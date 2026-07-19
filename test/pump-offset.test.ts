import { describe, it, expect } from 'vitest';
import { guessPumpOffset, guessPumpOffsetMilliseconds } from '../src/transform/pump-offset.js';
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
});
