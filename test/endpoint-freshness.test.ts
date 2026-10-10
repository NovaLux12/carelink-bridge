import { describe, it, expect } from 'vitest';
import {
  STALE_DATA_THRESHOLD_MINUTES,
  payloadAgeMinutes,
  isPayloadFresh,
  fresherPayload,
} from '../src/carelink/freshness.js';

const NOW = 1_760_000_000_000;
const minutesAgo = (m: number) => NOW - m * 60 * 1000;

describe('payloadAgeMinutes()', () => {
  it('computes age from the payload own server clock', () => {
    expect(
      payloadAgeMinutes({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(33),
      }),
    ).toBeCloseTo(33, 5);
  });

  it('returns 0 for data reported at response time', () => {
    expect(
      payloadAgeMinutes({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: NOW,
      }),
    ).toBe(0);
  });

  it('returns undefined when the payload carries no timestamps', () => {
    // An endpoint that 200s with a body we cannot date must not be judged
    // stale — that would discard real readings.
    expect(payloadAgeMinutes({})).toBeUndefined();
    expect(payloadAgeMinutes({ currentServerTime: NOW })).toBeUndefined();
    expect(payloadAgeMinutes(undefined)).toBeUndefined();
  });

  it('returns undefined for non-numeric or non-finite timestamps', () => {
    expect(
      payloadAgeMinutes({
        currentServerTime: 'now',
        lastMedicalDeviceDataUpdateServerTime: NOW,
      } as never),
    ).toBeUndefined();
    expect(
      payloadAgeMinutes({
        currentServerTime: Number.NaN,
        lastMedicalDeviceDataUpdateServerTime: NOW,
      }),
    ).toBeUndefined();
  });
});

describe('isPayloadFresh()', () => {
  it('accepts data inside the threshold', () => {
    expect(
      isPayloadFresh({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(STALE_DATA_THRESHOLD_MINUTES - 1),
      }),
    ).toBe(true);
  });

  it('accepts data exactly at the threshold', () => {
    expect(
      isPayloadFresh({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(STALE_DATA_THRESHOLD_MINUTES),
      }),
    ).toBe(true);
  });

  it('rejects the 33-day-stale payload from issue #3', () => {
    expect(
      isPayloadFresh({
        currentServerTime: NOW,
        lastMedicalDeviceDataUpdateServerTime: minutesAgo(47510.42),
      }),
    ).toBe(false);
  });

  it('treats an undatable payload as fresh', () => {
    expect(isPayloadFresh({})).toBe(true);
    expect(isPayloadFresh(undefined)).toBe(true);
  });

  it('honours a caller-supplied threshold', () => {
    const payload = {
      currentServerTime: NOW,
      lastMedicalDeviceDataUpdateServerTime: minutesAgo(45),
    };
    expect(isPayloadFresh(payload, 20)).toBe(false);
    expect(isPayloadFresh(payload, 60)).toBe(true);
  });
});

describe('fresherPayload()', () => {
  const old = {
    currentServerTime: NOW,
    lastMedicalDeviceDataUpdateServerTime: minutesAgo(47510),
  };
  const recent = {
    currentServerTime: NOW,
    lastMedicalDeviceDataUpdateServerTime: minutesAgo(2),
  };

  it('keeps the more recent of two datable payloads', () => {
    expect(fresherPayload(old, recent)).toBe(recent);
    expect(fresherPayload(recent, old)).toBe(recent);
  });

  it('handles a single side being absent', () => {
    expect(fresherPayload(undefined, old)).toBe(old);
    expect(fresherPayload(old, undefined)).toBe(old);
    expect(fresherPayload(undefined, undefined)).toBeUndefined();
  });

  it('never lets an undatable payload displace a datable one', () => {
    const undatable = { foo: 'bar' };
    expect(fresherPayload(old, undatable)).toBe(old);
    expect(fresherPayload(undatable, recent)).toBe(recent);
  });

  it('prefers the first when both are equally old', () => {
    const twin = { ...old };
    expect(fresherPayload(old, twin)).toBe(old);
  });
});