import { describe, it, expect } from 'vitest';
import {
  guessPumpOffset,
  guessPumpOffsetMilliseconds,
  pumpClockDriftMinutes,
  pumpClockReading,
} from '../src/transform/pump-offset.js';
import type { CareLinkData } from '../src/types/carelink.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * Builds the minimal CareLinkData the offset guesser reads. The pump time
 * string is parsed in the test runner's local timezone, so instead of
 * hardcoding expected epoch values we derive currentServerTime from the
 * parsed pump time — that makes the expected offset independent of the
 * machine/CI timezone.
 */
function dataWithOffset(offsetMs: number, driftMs = 0): CareLinkData {
  const pumpTimeString = 'Oct 19, 2015 08:20:00';
  return {
    sMedicalDeviceTime: pumpTimeString,
    currentServerTime: Date.parse(pumpTimeString) - offsetMs - driftMs,
  } as CareLinkData;
}

/** Conduit-pair payload: exact numeric delta, no host-zone parsing anywhere. */
function conduitData(deltaMs: number): CareLinkData {
  const server = 1_760_000_000_000;
  return {
    lastConduitUpdateServerDateTime: server,
    lastConduitDateTime: server + deltaMs,
  } as CareLinkData;
}

describe('guessPumpOffsetMilliseconds()', () => {
  it('should handle whole-hour offsets', () => {
    expect(guessPumpOffsetMilliseconds(dataWithOffset(2 * HOUR))).toBe(2 * HOUR);
    expect(guessPumpOffsetMilliseconds(dataWithOffset(-7 * HOUR))).toBe(-7 * HOUR);
    expect(guessPumpOffsetMilliseconds(dataWithOffset(0))).toBe(0);
  });

  // Regression tests for #15: whole-hour rounding skewed these by 30/15 min.
  it('should handle half-hour offsets (India +05:30, Newfoundland -03:30)', () => {
    expect(guessPumpOffsetMilliseconds(dataWithOffset(5.5 * HOUR))).toBe(5.5 * HOUR);
    expect(guessPumpOffsetMilliseconds(dataWithOffset(9.5 * HOUR))).toBe(9.5 * HOUR);
    expect(guessPumpOffsetMilliseconds(dataWithOffset(-3.5 * HOUR))).toBe(-3.5 * HOUR);
  });

  it('should handle quarter-hour offsets (Nepal +05:45)', () => {
    expect(guessPumpOffsetMilliseconds(dataWithOffset(5.75 * HOUR))).toBe(5.75 * HOUR);
  });

  it('should absorb pump clock drift of under 7.5 minutes', () => {
    expect(guessPumpOffsetMilliseconds(dataWithOffset(5.5 * HOUR, 4 * MINUTE))).toBe(5.5 * HOUR);
    expect(guessPumpOffsetMilliseconds(dataWithOffset(5.5 * HOUR, -4 * MINUTE))).toBe(5.5 * HOUR);
    expect(guessPumpOffsetMilliseconds(dataWithOffset(-7 * HOUR, 7 * MINUTE))).toBe(-7 * HOUR);
  });
});

describe('guessPumpOffset()', () => {
  it('should format whole-hour offsets as before', () => {
    expect(guessPumpOffset(dataWithOffset(2 * HOUR))).toBe('+0200');
    expect(guessPumpOffset(dataWithOffset(-7 * HOUR))).toBe('-0700');
    expect(guessPumpOffset(dataWithOffset(0))).toBe('+0000');
    expect(guessPumpOffset(dataWithOffset(11 * HOUR))).toBe('+1100');
  });

  it('should format sub-hour offsets with minutes', () => {
    expect(guessPumpOffset(dataWithOffset(5.5 * HOUR))).toBe('+0530');
    expect(guessPumpOffset(dataWithOffset(5.75 * HOUR))).toBe('+0545');
    expect(guessPumpOffset(dataWithOffset(9.5 * HOUR))).toBe('+0930');
    expect(guessPumpOffset(dataWithOffset(-3.5 * HOUR))).toBe('-0330');
  });

  it('returns "" — not "+0000" — when there is no device clock at all', () => {
    // A v13 display/message payload. "" tells the caller to fall back to
    // clientTimeZoneName; "+0000" would be a fabricated claim of UTC.
    expect(guessPumpOffset({} as CareLinkData)).toBe('');
  });
});

describe('pumpClockReading(): the single source of offset + drift', () => {
  it('reports the raw delta, the rounded offset and the residual as drift', () => {
    const r = pumpClockReading(conduitData(5.5 * HOUR + 4 * MINUTE));
    expect(r).toBeDefined();
    expect(r!.rawMs).toBe(5.5 * HOUR + 4 * MINUTE);
    expect(r!.offsetMs).toBe(5.5 * HOUR);
    // drift = raw − rounded offset, so a device clock AHEAD of the grid is
    // positive. Here the pump's clock runs 4 min ahead of +05:30.
    expect(r!.driftMinutes).toBe(4);
    expect(r!.label).toBe('conduit');
  });

  it('rounds drift to one decimal so sub-minute noise does not look alarming', () => {
    const r = pumpClockReading(conduitData(3 * HOUR + 6.4 * MINUTE));
    expect(r!.driftMinutes).toBe(6.4);
  });

  it('drift is signed: a fast pump is positive, a slow pump negative', () => {
    // device clock AHEAD of the server by 5 min beyond a whole hour.
    expect(pumpClockDriftMinutes(conduitData(HOUR + 5 * MINUTE))).toBe(5);
    expect(pumpClockDriftMinutes(conduitData(HOUR - 5 * MINUTE))).toBe(-5);
    expect(pumpClockDriftMinutes(conduitData(HOUR))).toBe(0);
  });

  it('is undefined — never 0 — when there is no device clock', () => {
    expect(pumpClockReading({} as CareLinkData)).toBeUndefined();
    expect(pumpClockDriftMinutes({} as CareLinkData)).toBeUndefined();
  });

  it('is undefined when the delta is beyond the clock-fault ceiling', () => {
    // 30 h: a fault, not a zone. Drift must not be reported for it either —
    // measuring the residual of a garbage delta would be a meaningless number
    // presented as an operator signal.
    expect(pumpClockReading(conduitData(-30 * HOUR))).toBeUndefined();
    expect(pumpClockDriftMinutes(conduitData(-30 * HOUR))).toBeUndefined();
  });

  it('reports a non-zero offset with zero drift for every real quarter-hour zone', () => {
    for (const hours of [0, 1, 5.5, 5.75, 9.5, -3.5, 12, -14]) {
      const r = pumpClockReading(conduitData(hours * HOUR));
      expect(r!.offsetMs).toBe(hours * HOUR);
      expect(r!.driftMinutes).toBe(0);
    }
  });
});

/**
 * `lastGuess` — the module-level mutable that used to sit at the top of
 * pump-offset.ts — is GONE, and these tests are what stops it coming back.
 *
 * The hazard it carried, stated precisely because the bug was never visible as
 * a wrong offset:
 *
 *   - `lastGuess` only gated a LOG LINE. The returned offset was always
 *     computed fresh, so no reading was ever misdated by it directly. That is
 *     why it survived review.
 *   - It was shared across every account, pump and test in the process
 *     (ES module singleton). A second account whose offset matched the first's
 *     produced NO log line at all — so the operator's only record that the
 *     bridge had switched accounts was silence. Same for a pump swap between
 *     two devices in the same zone.
 *   - It made log output a function of call order, so a test asserting "this
 *     payload logs a guess" passed or failed depending on what ran first in the
 *     file. Order-dependent assertions are worse than no assertions.
 *   - `dataWithOffset(2*HOUR)` then `dataWithOffset(-7*HOUR)` then back again
 *     would log twice, but two DIFFERENT accounts both at +0200 would log once.
 *     The dedupe key was the offset, which is not account identity.
 *
 * The tests below assert observable behaviour, not the absence of a variable:
 * the same payload must produce the same log decision on the first and the
 * second call, and two distinct payloads at the SAME offset must both log.
 */
describe('no cross-call state: logging is a pure function of the payload', () => {
  function capture(fn: () => void): string[] {
    const lines: string[] = [];
    const orig = console.log;
    (console as unknown as { log: (...a: unknown[]) => void }).log =
      (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      fn();
    } finally {
      (console as unknown as { log: typeof console.log }).log = orig;
    }
    return lines.filter((l) => l.includes('Guessed pump timezone'));
  }

  it('logs the same guess twice for the same payload (no dedupe state)', async () => {
    const logger = await import('../src/logger.js');
    logger.setVerbose(true);
    try {
      const p = dataWithOffset(2 * HOUR);
      const lines = capture(() => { guessPumpOffset(p); guessPumpOffset(p); });
      // Two calls, two lines. With the old `lastGuess` this was one.
      expect(lines).toHaveLength(2);
    } finally {
      logger.setVerbose(false);
    }
  });

  it('logs both accounts when two DIFFERENT payloads share an offset', async () => {
    const logger = await import('../src/logger.js');
    logger.setVerbose(true);
    try {
      // The bug: identical offsets, so the second account's guess was swallowed
      // and the operator saw no evidence the bridge had switched accounts.
      const accountA = conduitData(2 * HOUR);
      const accountB = conduitData(2 * HOUR);
      const lines = capture(() => { guessPumpOffset(accountA); guessPumpOffset(accountB); });
      expect(lines).toHaveLength(2);
    } finally {
      logger.setVerbose(false);
    }
  });

  it('interleaved offsets never suppress a later log (no order dependence)', async () => {
    const logger = await import('../src/logger.js');
    logger.setVerbose(true);
    try {
      const a = conduitData(2 * HOUR);
      const b = conduitData(-7 * HOUR);
      const lines = capture(() => {
        guessPumpOffset(a); guessPumpOffset(b); guessPumpOffset(a); guessPumpOffset(b);
      });
      expect(lines).toHaveLength(4);
    } finally {
      logger.setVerbose(false);
    }
  });

  it('never logs for a payload with no device clock', async () => {
    const logger = await import('../src/logger.js');
    logger.setVerbose(true);
    try {
      const lines = capture(() => { guessPumpOffset({} as CareLinkData); });
      expect(lines).toHaveLength(0);
    } finally {
      logger.setVerbose(false);
    }
  });
});
