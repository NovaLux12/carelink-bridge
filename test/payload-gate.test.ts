/**
 * The v13 `display/message` payload gate.
 *
 * `src/main.ts` used to decide a fetch was valid with
 * `if (!data?.lastMedicalDeviceDataUpdateServerTime)` — one field that the v13
 * display/message route NEVER sends. `src/transform/index.ts` says so in a
 * comment, and `test/ble-payload-shape.test.ts` builds its v13 fixture by
 * deleting exactly that field, so the two halves of the bridge disagreed about
 * the shape they were handling.
 *
 * Measured before this suite existed: the gate returned false for a payload
 * that `transform()` converted into 2 entries + 1 devicestatus + 1 treatment.
 * The bridge fetched good data on the exact device the v0.3 line targets,
 * logged "Empty or invalid data from CareLink", incremented `failure`, uploaded
 * nothing, and tripped the stale watchdog.
 *
 * `src/main.ts` itself still has no test (it is a top-level script that starts a
 * loop on import), so the predicate it now delegates to is pinned here.
 */

import { describe, expect, it } from 'vitest';
import { isUsablePayload } from '../src/payload-shape.js';
import { transform } from '../src/transform/index.js';
import type { CareLinkData } from '../src/types/carelink.js';

const CLOCK = Date.UTC(2026, 10, 12, 12, 0, 0);

/** The v13 display/message shape: `sgs` present, no device clock at all. */
function v13(overrides: Record<string, unknown> = {}): CareLinkData {
  return {
    deviceFamily: 'INSTINCT',
    clientTimeZoneName: 'Europe/London',
    sgs: [
      { sg: 7.2, timestamp: 'Nov 12, 2026 11:55:00', version: 1, timeChange: false, kind: 'SG' },
      { sg: 7.9, timestamp: 'Nov 12, 2026 12:00:00', version: 1, timeChange: false, kind: 'SG' },
    ],
    ...overrides,
  } as unknown as CareLinkData;
}

describe('isUsablePayload — the fetch-loop gate', () => {
  it('accepts a v13 display/message payload that carries no device clock', () => {
    expect(isUsablePayload(v13())).toBe(true);
  });

  it('accepts a legacy payload that carries the device clock', () => {
    expect(
      isUsablePayload({ lastMedicalDeviceDataUpdateServerTime: CLOCK } as CareLinkData),
    ).toBe(true);
  });

  it('rejects an empty object, null and undefined', () => {
    expect(isUsablePayload({} as CareLinkData)).toBe(false);
    expect(isUsablePayload(null)).toBe(false);
    expect(isUsablePayload(undefined)).toBe(false);
  });

  it('rejects an empty sgs array with no clock — nothing to upload', () => {
    expect(isUsablePayload(v13({ sgs: [] }))).toBe(false);
  });

  it('rejects a markers-only payload — a marker with no anchor is undatable', () => {
    // Deliberate: accepting it would only move the failure downstream into
    // mapMarkers(), which refuses an anchorless array rather than dating it.
    expect(
      isUsablePayload({ markers: [{ index: 280, type: 'MEAL', amount: 45 }] } as CareLinkData),
    ).toBe(false);
  });

  it('the gate and transform() agree on the v13 payload', () => {
    // The regression. Before the fix these two disagreed, and the gate was the
    // one that decided.
    const payload = v13({
      markers: [
        { index: 280, type: 'MEAL', amount: 45 },
        { index: 280, type: 'INSULIN', amount: 4 },
      ],
    });
    expect(isUsablePayload(payload)).toBe(true);

    const out = transform(payload, 24);
    expect(out.entries.length).toBe(2);
    expect(out.devicestatus.length).toBe(1);
    expect(out.treatments.length).toBe(1);
  });
});
