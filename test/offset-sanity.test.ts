import { describe, it, expect } from 'vitest';
import { data } from './fixtures.js';
import { guessPumpOffsetMilliseconds } from '../src/transform/pump-offset.js';

const H = 3_600_000;

/**
 * xDrip only applies its correction when `diffInHour != 0 && diffInHour < 26`
 * (CareLinkClient.correctTimeInRecentData / correctTimeInDisplayMessage).
 * Beyond 26 h the pair is a clock fault, not a time zone — and a fault applied
 * blindly shifts EVERY reading in the payload by the delta, producing
 * plausible dates in the wrong place that nothing downstream can detect.
 */
describe('pump offset sanity bound', () => {
  it('accepts a plausible 1-hour shift', () => {
    const base = 1_760_000_000_000;
    const d: any = data({
      currentServerTime: base,
      sMedicalDeviceTime: new Date(base - 1 * H).toISOString(),
    });
    // device time is 1h BEHIND server time -> offset is -1h
    expect(guessPumpOffsetMilliseconds(d)).toBe(-1 * H);
  });

  it('rejects a 30-hour delta as a clock fault', () => {
    const base = 1_760_000_000_000;
    const d: any = data({
      currentServerTime: base,
      sMedicalDeviceTime: new Date(base - 30 * H).toISOString(),
    });
    expect(Number.isNaN(guessPumpOffsetMilliseconds(d))).toBe(true);
  });

  it('rejects a 300-hour delta (stale timestamp)', () => {
    const base = 1_760_000_000_000;
    const d: any = data({
      currentServerTime: base,
      sMedicalDeviceTime: new Date(base - 300 * H).toISOString(),
    });
    expect(Number.isNaN(guessPumpOffsetMilliseconds(d))).toBe(true);
  });

  it('accepts the real extremes (-12h and +14h)', () => {
    const base = 1_760_000_000_000;
    for (const h of [12, -14]) {
      const d: any = data({
        currentServerTime: base,
        sMedicalDeviceTime: new Date(base + h * H).toISOString(),
      });
      expect(guessPumpOffsetMilliseconds(d)).toBe(h * H);
    }
  });
});

describe('conduit clock pair preference (v13)', () => {
  // xDrip's v13 path derives its correction from the CONDUIT pair, not from
  // sMedicalDeviceTime/currentServerTime. The conduit pair is in the newer
  // block (RecentData.java:80, :143) so it is the right evidence here.
  it('prefers the conduit pair when both are present', () => {
    const base = 1_760_000_000_000;
    const d: any = data({
      currentServerTime: base,
      sMedicalDeviceTime: new Date(base - 1 * H).toISOString(),   // would say 1h
      lastConduitUpdateServerDateTime: base,
      lastConduitDateTime: base - 2 * H,                           // says -2h
    });
    expect(guessPumpOffsetMilliseconds(d)).toBe(-2 * H);
  });

  it('falls back to the device pair when the conduit pair is absent', () => {
    const base = 1_760_000_000_000;
    const d: any = data({
      currentServerTime: base,
      sMedicalDeviceTime: new Date(base - 1 * H).toISOString(),
    });
    expect(guessPumpOffsetMilliseconds(d)).toBe(-1 * H);
  });

  it('returns NaN when neither pair is usable', () => {
    const d: any = data();
    delete d.sMedicalDeviceTime;
    delete d.currentServerTime;
    expect(Number.isNaN(guessPumpOffsetMilliseconds(d))).toBe(true);
  });
});
