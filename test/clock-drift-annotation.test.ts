import { describe, it, expect } from 'vitest';
import { transform } from '../src/transform/index.js';
import { data } from './fixtures.js';

/**
 * `clock_drift_minutes` — the devicestatus annotation recommended by
 * carelink-api-research GAPS-0721 §P0.3.
 *
 * THE CONTRACT, and the reason each clause is a test rather than a comment:
 *
 *  1. PRESENT AND NON-ZERO when a device clock exists and its delta is off the
 *     quarter-hour grid. That is the only condition under which the value means
 *     anything: every real UTC offset is a multiple of 15 min, so a residual is
 *     pump clock drift by elimination.
 *  2. ABSENT when there is no device clock (v13 display/message). NOT zero.
 *     Zero is a measurement ("the clock is exact"); absent is the truth ("we
 *     could not measure"). Writing 0 here would tell an operator dashboard that
 *     a payload with no clock at all was checked and found clean — the precise
 *     inversion that makes a monitoring field worse than none.
 *  3. ABSENT when drift is exactly zero. Same reasoning, weaker: a 0 carries no
 *     information an operator can act on, and its presence would make "is this
 *     payload from a device with a clock?" unanswerable from the annotation.
 *
 * SCOPE: drift cannot detect DST — a DST delta has no residual. See
 * test/dst-drift.test.ts for that half. Do not add a DST expectation here.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A devicestatus-producing payload with an exact, numeric clock delta. */
function withClockDelta(deltaMs: number): any {
  const server = 1_760_000_000_000;
  return data({
    lastConduitUpdateServerDateTime: server,
    lastConduitDateTime: server + deltaMs,
    // Keep staleness out of the way: the gate needs BOTH of these.
    currentServerTime: server,
    lastMedicalDeviceDataUpdateServerTime: server,
  } as any);
}

function entry(p: any) {
  return transform(p).devicestatus[0] as any;
}

describe('clock_drift_minutes is emitted when measurable and non-zero', () => {
  it('emits the drift for a pump 6 minutes off the grid', () => {
    // +2h +6min -> rounds to +2h, residual 6.
    expect(entry(withClockDelta(2 * HOUR + 6 * MINUTE)).clock_drift_minutes).toBe(6);
  });

  it('emits it for a slow pump too, as a magnitude', () => {
    // −2h −6min -> residual −6. The annotation is a magnitude alarm; the sign
    // is in the log line (see pump-offset.ts guessPumpOffset).
    expect(entry(withClockDelta(-2 * HOUR - 6 * MINUTE)).clock_drift_minutes).toBe(6);
  });

  it('reports sub-minute drift rounded to one decimal', () => {
    // 4.5 min off a whole hour. Rounded to one decimal, not to an integer, so a
    // slowly-worsening clock is visible across polls.
    const v = entry(withClockDelta(3 * HOUR + 4.5 * MINUTE)).clock_drift_minutes;
    expect(v).toBe(4.5);
  });

  it('lands as a TOP-LEVEL devicestatus field, beside last_alarm', () => {
    // The research memo places it at the devicestatus root. Nesting it under
    // `pump` or `connect` would put it where no consumer looks, and would
    // collide with Nightscout plugins that read `pump.pump.*`.
    const ds = entry(withClockDelta(1 * HOUR + 8 * MINUTE));
    expect(ds).toHaveProperty('clock_drift_minutes');
    expect(ds.pump?.clock_drift_minutes).toBeUndefined();
    expect(ds.connect?.clock_drift_minutes).toBeUndefined();
    // Still a valid devicestatus: the field is additive, nothing was displaced.
    expect(ds.created_at).toBeTypeOf('string');
    expect(ds.device).toBeTypeOf('string');
    expect(ds.pump).toBeDefined();
  });

  it('is present on the GUARDIAN branch as well as the pump branch', () => {
    // Both branches share the annotation. A CGM-only GUARDIAN payload has a
    // conduit clock and can drift just as a pump's can.
    // 6 min, not 9: 69 min rounds UP to 75 and would report 6, which is
    // correct behaviour but not what this test is about.
    const p = withClockDelta(1 * HOUR + 6 * MINUTE);
    p.medicalDeviceFamily = 'GUARDIAN';
    expect((transform(p).devicestatus[0] as any).clock_drift_minutes).toBe(6);
  });
});

describe('clock_drift_minutes is ABSENT, never zero, when unmeasurable', () => {
  it('is absent for a v13 display/message payload with no device clock', () => {
    // The clause that matters most. `undefined`, not 0.
    const p: any = {
      bgUnits: 'MGDL', bgunits: 'MGDL', deviceFamily: 'INSTINCT',
      medicalDeviceBatteryLevelPercent: 80, conduitBatteryLevel: 80,
      sensorState: 'NORMAL', lastSGTrend: 'NONE',
      conduitInRange: true, conduitMedicalDeviceInRange: true, conduitSensorInRange: true,
      clientTimeZoneName: 'Europe/London',
      sgs: [{ sg: 120, timestamp: 'Nov 8, 2026 01:30:00', version: 1, timeChange: false, kind: 'SG' }],
    };
    const ds = entry(p);
    expect(ds).not.toHaveProperty('clock_drift_minutes');
    expect(ds.clock_drift_minutes).toBeUndefined();
    // Explicitly NOT zero: `toBe(0)` would pass for a defaulted field, and the
    // whole point is that this payload was never measured.
    expect(ds.clock_drift_minutes).not.toBe(0);
  });

  it('is absent when the clock pair is unusable (only one half present)', () => {
    const p = withClockDelta(2 * HOUR + 6 * MINUTE);
    delete p.lastConduitUpdateServerDateTime;
    expect(entry(p)).not.toHaveProperty('clock_drift_minutes');
  });

  it('is absent when the delta is a clock fault, not a zone', () => {
    // 30 h is rejected as a fault. Reporting the residual of a garbage delta
    // would dress a bogus number up as an operator signal.
    expect(entry(withClockDelta(-30 * HOUR))).not.toHaveProperty('clock_drift_minutes');
  });

  it('is absent when drift is exactly zero', () => {
    // A clean pump. Absent == "nothing to report", which is the only reading an
    // operator can act on; a 0 would be noise on every poll forever.
    const ds = entry(withClockDelta(2 * HOUR));
    expect(ds).not.toHaveProperty('clock_drift_minutes');
    expect(ds.clock_drift_minutes).toBeUndefined();
  });

  it('is absent for every real quarter-hour zone — they are not drift', () => {
    for (const hours of [0, 1, 5.5, 5.75, 9.5, -3.5, 12, -14]) {
      const ds = entry(withClockDelta(hours * HOUR));
      expect(ds, `offset ${hours}h`).not.toHaveProperty('clock_drift_minutes');
    }
  });
});

describe('clock_drift_minutes does not disturb existing fields', () => {
  it('leaves pump.clock, reservoir, battery and iob as they were', () => {
    const ds = entry(withClockDelta(2 * HOUR + 6 * MINUTE));
    expect(ds.pump.battery).toEqual({ percent: 100 });
    expect(ds.pump.reservoir).toBe(52);
    expect(ds.pump.clock).toBeTypeOf('string');
    expect(ds.pump.iob.bolusiob).toBe(1.275);
  });
});
