import { describe, it, expect } from 'vitest';
import { transform } from '../src/transform/index.js';
import {
  guessPumpOffset,
  guessPumpOffsetMilliseconds,
  pumpClockDriftMinutes,
} from '../src/transform/pump-offset.js';

/**
 * DST BEHAVIOUR OF THE PUMP-CLOCK OFFSET — measured, not argued.
 *
 * ── WHAT THE CODE DOES ──
 * `pumpClockReading` computes `deviceClock − serverClock`, rounds to the
 * nearest 15 minutes, and the transform subtracts that from every reading's
 * wall-clock string.
 *
 * ── THE ANSWER TO "HALF-HOUR OR WRONG-BUT-CONSISTENT" ──
 * WRONG-BUT-CONSISTENT WHOLE HOUR. Never a half-hour, never a bare
 * quarter-hour. A DST shift is exactly ±60 min, and 60 is a multiple of 15, so
 * `Math.round(±60min / 15min)` is exact. There is no input in this code path
 * that turns an exact hour of delta into :30 — the only way to reach :30 or :45
 * is a *real* zone (+05:30 India, +05:45 Nepal), and the only way to reach a
 * wrong quarter hour is genuine clock DRIFT of ≥7.5 min (pinned below).
 *
 * ── MAX_OFFSET_HOURS = 26 ABSORBS IT SILENTLY. RECORDED. ──
 * 1 h is two orders of magnitude inside the 26 h bound, so the guard does not
 * fire, nothing is logged, and the wrong offset is applied to every reading in
 * the payload. The bound is a clock-FAULT ceiling (30 h, 300 h) and CANNOT be
 * turned into a plausibility check: by arithmetic alone, a DST-shifted offset
 * is indistinguishable from a legitimate one-hour time zone. Tightening it
 * would reject real zones, not catch DST.
 *
 * ── WHY THE PUMP-CLOCK PATH IS SELF-CONSISTENT, AND WHERE THE HOUR GOES ──
 * The delta is measured against the pump's OWN clock. If the pump truly never
 * DST-adjusts and the wall-clock strings are rendered in that same frozen
 * frame, the offset is CORRECT and DST costs nothing. The hour appears when the
 * two frames disagree: CareLink renders each reading's `datetime`/`timestamp`
 * in the *portal's* local zone, which does follow DST, while
 * `sMedicalDeviceTime` is the pump's unadjusted clock. From the transition
 * until the pump's clock is reset (or the fetch window rolls past it), the
 * difference between those frames is one hour, so readings across the boundary
 * are placed an hour out — and the size of the jump is the whole hour, not a
 * fraction of it. That is the memo's "±1 h … until the next fetch".
 *
 * ── `clock_drift_minutes` CANNOT SEE ANY OF THIS ──
 * Drift is the residual off the quarter-hour grid. A DST delta has no residual,
 * so drift reads 0.0 while the offset is an hour wrong. The two detections are
 * disjoint by construction. Do not read "drift 0" as "offset correct".
 *
 * ── HOST-INDEPENDENCE ──
 * Every assertion here drives the offset from `lastConduitDateTime`, which the
 * type allows as a NUMBER (`string | number`), so the delta is exact
 * arithmetic and no `Date.parse` of a zoneless string is involved. That makes
 * these tests produce identical results under any `TZ`. (The reading-level
 * tests use a differential — same payload with and without the device clock —
 * which cancels the host zone as well.)
 */
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Payload whose clock delta is exactly `deltaMs` — pure, host-independent. */
function clockPayload(deltaMs: number, extra: Record<string, unknown> = {}): any {
  const server = 1_775_000_000_000;
  return {
    bgUnits: 'MGDL', bgunits: 'MGDL', deviceFamily: 'INSTINCT',
    medicalDeviceBatteryLevelPercent: 80, conduitBatteryLevel: 80,
    sensorState: 'NORMAL', lastSGTrend: 'NONE',
    conduitInRange: true, conduitMedicalDeviceInRange: true, conduitSensorInRange: true,
    sgs: [{
      sg: 120, timestamp: 'Mar 29, 2026 02:30:00', version: 1, timeChange: false, kind: 'SG',
    }],
    lastConduitUpdateServerDateTime: server,
    lastConduitDateTime: server + deltaMs,
    ...extra,
  };
}

describe('DST: an exact hour of delta rounds to an exact hour', () => {
  it('+1 h (fall-back shape) → exactly +0100, drift 0', () => {
    const p = clockPayload(+HOUR);
    expect(guessPumpOffsetMilliseconds(p)).toBe(+HOUR);
    expect(guessPumpOffset(p)).toBe('+0100');
    expect(pumpClockDriftMinutes(p)).toBe(0);
  });

  it('−1 h (spring-forward shape) → exactly −0100, drift 0', () => {
    const p = clockPayload(-HOUR);
    expect(guessPumpOffsetMilliseconds(p)).toBe(-HOUR);
    expect(guessPumpOffset(p)).toBe('-0100');
    expect(pumpClockDriftMinutes(p)).toBe(0);
  });

  it('the emitted offset is always a multiple of 15 min, so :30/:45 only ever means a real zone', () => {
    // Sweep the whole hour either side of the transition in 1-minute steps. A
    // DST delta is exactly 60, but the sweep proves no *neighbouring* delta can
    // produce a value off the quarter-hour grid that is not drift.
    // NB `expect(x % n).toBe(0)` is wrong here: JS `%` yields `-0` for negative
    // multiples, and `Object.is(-0, 0)` is false. Assert on the value directly.
    for (let m = 30; m <= 90; m++) {
      const offset = guessPumpOffsetMilliseconds(clockPayload(m * MIN));
      expect(Number.isFinite(offset)).toBe(true);
      expect(offset / (15 * MIN)).toBe(Math.round(offset / (15 * MIN)));
      expect(Number.isInteger(offset / (15 * MIN))).toBe(true);
    }
    for (let m = -90; m <= -30; m++) {
      const offset = guessPumpOffsetMilliseconds(clockPayload(m * MIN));
      expect(Number.isFinite(offset)).toBe(true);
      expect(Number.isInteger(offset / (15 * MIN))).toBe(true);
    }
  });

  it('a 60-minute delta is preserved exactly; 52 and 68 flip a quarter hour as DRIFT', () => {
    // This is the honest boundary. Exactly on the hour → exact. Eight minutes
    // either side → the nearest quarter hour, which is a wrong-but-legal
    // :45/:15 for a real zone. That is drift absorption, not DST, and the
    // drift annotation is what makes it visible.
    expect(guessPumpOffsetMilliseconds(clockPayload(60 * MIN))).toBe(60 * MIN);
    expect(guessPumpOffsetMilliseconds(clockPayload(52 * MIN))).toBe(45 * MIN);
    expect(guessPumpOffsetMilliseconds(clockPayload(68 * MIN))).toBe(75 * MIN);

    expect(pumpClockDriftMinutes(clockPayload(52 * MIN))).toBe(7);
    expect(pumpClockDriftMinutes(clockPayload(68 * MIN))).toBe(-7);
  });

  it('MAX_OFFSET_HOURS=26 does not fire on DST — the guard is silent', () => {
    // Recorded so nobody "fixes" DST by tightening the bound. A plausibility
    // bound cannot distinguish a DST offset from a real one-hour zone.
    const offset = guessPumpOffsetMilliseconds(clockPayload(-HOUR));
    expect(Number.isFinite(offset)).toBe(true);
    expect(Math.abs(offset)).toBeLessThan(26 * HOUR);
    // ...and the real fault ceiling still does its job.
    expect(Number.isNaN(guessPumpOffsetMilliseconds(clockPayload(-30 * HOUR)))).toBe(true);
  });

  it('drift stays 0.0 across the transition — it cannot see DST', () => {
    // Disjointness is the load-bearing point: an operator dashboard watching
    // clock_drift_minutes alone shows a perfectly healthy pump while every
    // reading sits an hour out.
    expect(pumpClockDriftMinutes(clockPayload(+HOUR))).toBe(0);
    expect(pumpClockDriftMinutes(clockPayload(-HOUR))).toBe(0);
  });
});

describe('DST at reading level: the whole payload moves, and only in whole hours', () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Wall clock at instant `ms` rendered at a FIXED offset (a frozen pump clock). */
  function wallClock(ms: number, frozenOffsetMinutes: number): string {
    const d = new Date(ms + frozenOffsetMinutes * MIN);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  /**
   * How far each reading moved when the pump clock delta changed from
   * `deltaWithout` to `deltaWith`, in whole minutes.
   *
   * Both payloads carry a device clock, so BOTH go through `parsePumpTime`
   * (`Date.parse` of a zoneless string, which binds to the host zone). Comparing
   * two device-clock payloads cancels the host zone exactly — including in
   * half-hour zones like Australia/Adelaide (+09:30), where comparing a
   * device-clock payload against a zone-parsed control leaks 30 min and makes
   * the assertion untestable. That leak is the host-zone wart documented in
   * test/zoned-reading-time.test.ts, not the DST behaviour under test.
   */
  function clockShift(
    readings: number[], fetchAt: number, deltaWith: number, deltaWithout: number,
  ): number[] {
    const a = transform(payload({ readings, fetchAt, deltaMs: deltaWithout })).entries;
    const b = transform(payload({ readings, fetchAt, deltaMs: deltaWith })).entries;
    expect(b).toHaveLength(a.length);
    return b.map((e, i) => Math.round((e.date - a[i].date) / MIN));
  }

  function payload(opts: { readings: number[]; fetchAt: number; deltaMs: number }): any {
    return {
      bgUnits: 'MGDL', bgunits: 'MGDL', deviceFamily: 'INSTINCT',
      medicalDeviceBatteryLevelPercent: 80, conduitBatteryLevel: 80,
      sensorState: 'NORMAL', lastSGTrend: 'NONE',
      conduitInRange: true, conduitMedicalDeviceInRange: true, conduitSensorInRange: true,
      clientTimeZoneName: 'Europe/London',
      sgs: opts.readings.map((t) => ({
        sg: 120, timestamp: wallClock(t, 0), version: 1, timeChange: false, kind: 'SG',
      })),
      lastConduitUpdateServerDateTime: opts.fetchAt,
      lastConduitDateTime: opts.fetchAt + opts.deltaMs,
    };
  }

  it('every reading in the payload moves by the same whole hour', () => {
    const fetchAt = Date.parse('2026-03-29T02:30:00Z'); // 90 min after the London transition
    const readings = [0, 1, 2, 3, 4, 5].map((i) => fetchAt - i * 5 * MIN);

    // A −1 h pump clock delta (the spring-forward shape) versus a 0 delta.
    const shifts = clockShift(readings, fetchAt, -HOUR, 0);

    // One value for the whole payload — the correction is computed once and
    // applied to every reading, so the shift is systematic, not per-reading.
    const distinct = [...new Set(shifts)];
    expect(distinct).toHaveLength(1);

    // EXACTLY one hour, with the host zone cancelled. This is the assertion a
    // half-hour hypothesis would fail: a :30 answer here would mean the
    // rounding had split the hour across the grid.
    expect(Math.abs(distinct[0])).toBe(60);
  });

  it('the shift is not confined to the pre-transition readings', () => {
    const transition = Date.parse('2026-03-29T01:00:00Z');
    const fetchAt = transition + 90 * MIN;
    const readings = [0, 1, 2, 3, 4, 5].map((i) => fetchAt - i * 5 * MIN);

    const shifts = clockShift(readings, fetchAt, -HOUR, 0);

    // At least one reading is after the transition, and it moved by the SAME
    // whole-hour amount as the rest: the payload is corrected as a unit, which
    // is exactly why a transition mid-window corrupts the whole fetch rather
    // than one reading.
    const after = readings.findIndex((t) => t > transition);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(Math.abs(shifts[after])).toBe(60);
    expect(shifts[after]).toBe(shifts[0]);
  });

  it('a quarter-hour delta moves readings by exactly 15 min — never a half hour', () => {
    // The near-miss case: a real +05:45 zone, or 15 min of accumulated drift
    // across the boundary. Whatever the source, the code must emit the exact
    // quarter hour, not round it to :30.
    const fetchAt = Date.parse('2026-03-29T02:30:00Z');
    const shifts = clockShift([fetchAt], fetchAt, -15 * MIN, 0);
    expect(Math.abs(shifts[0])).toBe(15);
  });

  it('no device clock: no offset and no drift, and the transform falls back to the zone', () => {
    const fetchAt = Date.parse('2026-03-29T02:30:00Z');
    const p = payload({ readings: [fetchAt], fetchAt, deltaMs: 0 });
    delete p.lastConduitDateTime;
    delete p.lastConduitUpdateServerDateTime;

    expect(guessPumpOffset(p)).toBe('');
    expect(Number.isNaN(guessPumpOffsetMilliseconds(p))).toBe(true);
    expect(pumpClockDriftMinutes(p)).toBeUndefined();
  });
});
