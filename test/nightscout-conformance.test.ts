/**
 * Nightscout/Loop conformance for the treatments and devicestatus this bridge
 * emits.
 *
 * Every expectation here is taken from `nightscout/cgm-remote-monitor` v15.0.9
 * (`c6a0d8e`) and from the consuming clients, not from documentation prose:
 *
 *   - LoopKit `NightscoutTreatment.init?` guards on `_id`, `eventType`,
 *     `timestamp` and `enteredBy`, and is FAILABLE. Without `timestamp` it
 *     returns nil and Loop discards the treatment entirely.
 *   - LoopKit `BGCheckNightscoutTreatment.fromServer` additionally requires
 *     `units`.
 *   - AAPS `RemoteTreatment` is tolerant — it falls back
 *     `date ?: mills ?: timestamp ?: created_at` — which is why the missing
 *     `timestamp` never showed up as a bug report.
 *   - `lib/plugins/pump.js:284-293` renders `pump.status.suspended` and
 *     `pump.status.bolusing`; nothing in Nightscout reads `pump.autoMode.*`.
 *   - `lib/server/devicestatus.js:57-59,75` only skips a record whose `_id` is
 *     a 24-hex string.
 */

import { describe, expect, it } from 'vitest';
import { transform } from '../src/transform/index.js';
import { deviceStatusId, suspendStatus } from '../src/transform/index.js';
import type { CareLinkData } from '../src/types/carelink.js';

const ANCHOR = Date.UTC(2026, 10, 12, 12, 0, 0);

function payload(overrides: Record<string, unknown> = {}): CareLinkData {
  return {
    lastMedicalDeviceDataUpdateServerTime: ANCHOR,
    clientTimeZoneName: 'Europe/London',
    sgs: [{ sg: 7.2, timestamp: 'Nov 12, 2026 11:55:00', version: 1, kind: 'SG' }],
    ...overrides,
  } as unknown as CareLinkData;
}

describe('treatments carry the fields Loop requires', () => {
  it('a Meal Bolus has _id, eventType, timestamp, created_at and enteredBy', () => {
    const out = transform(
      payload({
        markers: [
          { index: 280, type: 'MEAL', amount: 45 },
          { index: 280, type: 'INSULIN', amount: 4 },
        ],
      }),
      24,
    );
    expect(out.treatments).toHaveLength(1);
    const t = out.treatments[0];

    // Loop's guard, field by field.
    expect(t._id).toBeTypeOf('string');
    expect(t.eventType).toBe('Meal Bolus');
    expect(t.timestamp).toBeTypeOf('string');
    expect(t.enteredBy).toBe('carelink-bridge');

    // timestamp and created_at must agree: one event, one time.
    expect(t.timestamp).toBe(t.created_at);
    // A parseable instant, not a zoneless wall-clock string.
    expect(Number.isFinite(Date.parse(t.timestamp as string))).toBe(true);
  });

  it('every treatment shape carries timestamp, not just meals', () => {
    const out = transform(
      payload({
        markers: [
          { index: 280, type: 'MEAL', amount: 45 },
          { index: 280, type: 'INSULIN', amount: 4 },
          { index: 279, type: 'INSULIN', amount: 2 },
          { index: 278, type: 'MEAL', amount: 30 },
        ],
      }),
      24,
    );
    expect(out.treatments.length).toBeGreaterThanOrEqual(3);
    for (const t of out.treatments) {
      expect(t.timestamp, `${t.eventType} missing timestamp`).toBeTypeOf('string');
    }
  });

  it('a BG Check carries units as well as glucose and glucoseType', () => {
    const out = transform(
      payload({ markers: [{ index: 280, type: 'BG', amount: 8.1 }] }),
      24,
    );
    expect(out.treatments).toHaveLength(1);
    const t = out.treatments[0];
    expect(t.eventType).toBe('BG Check');
    expect(t.units).toBe('mg/dL');
    expect(t.glucoseType).toBe('Finger');
    expect(t.timestamp).toBeTypeOf('string');
    expect(t.glucose).toBeTypeOf('number');
  });
});

describe('devicestatus _id', () => {
  it('is 24 lowercase hex characters — the shape Nightscout dedupes on', () => {
    const id = deviceStatusId(ANCHOR);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is stable for the same minute and different across minutes', () => {
    const a = deviceStatusId(ANCHOR + 1_000);
    const b = deviceStatusId(ANCHOR + 59_999);
    const c = deviceStatusId(ANCHOR + 60_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('is deterministic for a non-finite input rather than random', () => {
    expect(deviceStatusId(NaN)).toBe(deviceStatusId(NaN));
    expect(deviceStatusId(NaN)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('the emitted devicestatus carries it', () => {
    const out = transform(payload(), 24);
    expect(out.devicestatus[0]._id).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('pump.status — the field Nightscout actually renders', () => {
  it('is absent when nothing says suspended', () => {
    expect(suspendStatus({}, undefined)).toBeUndefined();
    const out = transform(payload(), 24);
    expect(out.devicestatus[0].pump?.status).toBeUndefined();
  });

  it('is Suspended when the pump reports medicalDeviceSuspended', () => {
    expect(suspendStatus({ medicalDeviceSuspended: true }, undefined)).toEqual({
      status: { suspended: 'Suspended' },
    });
  });

  it('is Suspended when SmartGuard reports suspendFired', () => {
    expect(
      suspendStatus({}, { suspendFired: true } as never),
    ).toEqual({ status: { suspended: 'Suspended' } });
  });

  it('does not treat an unrecognised plgm token as a suspend', () => {
    // suspendFired is null, not false, when the token is outside the recorded
    // vocabulary. Null means "we do not know", which is not "suspended".
    expect(suspendStatus({}, { suspendFired: null } as never)).toBeUndefined();
    expect(suspendStatus({}, { suspendFired: false } as never)).toBeUndefined();
  });

  it('end to end: a SmartGuard suspend reaches devicestatus.pump.status', () => {
    const out = transform(
      payload({
        therapyAlgorithmState: {
          autoModeShieldState: 'AUTO_BASAL',
          plgmLgsState: 'SUSPEND_FIRED_PLGM',
        },
      }),
      24,
    );
    expect(out.devicestatus[0].pump?.status).toEqual({ suspended: 'Suspended' });
    // The raw evidence is still published alongside it.
    expect(out.devicestatus[0].pump?.autoMode?.suspendFired).toBe(true);
  });
});
