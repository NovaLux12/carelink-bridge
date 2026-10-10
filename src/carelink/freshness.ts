import type { CareLinkData } from '../types/carelink.js';

/**
 * How old a CareLink payload may be before we stop trusting it.
 *
 * Every payload carries its own clock: `currentServerTime` is the server's
 * "now" at the moment of the response, and `lastMedicalDeviceDataUpdateServerTime`
 * is when the device last reported. The difference is a server-side age, so it
 * needs no clock sync on our side.
 *
 * This constant is the single definition of "too old". Both the fetch layer
 * (which endpoint to trust — see client.ts) and the transform layer (whether to
 * emit entries at all) import it, so the two can never drift apart.
 */
export const STALE_DATA_THRESHOLD_MINUTES = 20;

/**
 * Age of a payload in minutes, or `undefined` when the payload does not carry
 * both timestamps and no judgement can be made.
 *
 * Undefined is deliberately distinct from 0: "we don't know" must not be
 * treated as "fresh", nor as "stale" — callers decide, and our callers choose
 * to keep the payload when they cannot judge.
 */
export function payloadAgeMinutes(data: Partial<CareLinkData> | undefined): number | undefined {
  if (!data) return undefined;
  const { currentServerTime, lastMedicalDeviceDataUpdateServerTime } = data;
  if (typeof currentServerTime !== 'number' || typeof lastMedicalDeviceDataUpdateServerTime !== 'number') {
    return undefined;
  }
  if (!Number.isFinite(currentServerTime) || !Number.isFinite(lastMedicalDeviceDataUpdateServerTime)) {
    return undefined;
  }
  return (currentServerTime - lastMedicalDeviceDataUpdateServerTime) / (60 * 1000);
}

/**
 * True when a payload is recent enough to be worth acting on.
 *
 * A payload we cannot date is treated as fresh on purpose: the alternative is
 * discarding real readings on an endpoint that never sends the timestamps. We
 * only reject a 200 when it positively demonstrates staleness.
 */
export function isPayloadFresh(
  data: Partial<CareLinkData> | undefined,
  thresholdMinutes: number = STALE_DATA_THRESHOLD_MINUTES,
): boolean {
  const age = payloadAgeMinutes(data);
  if (age === undefined) return true;
  return age <= thresholdMinutes;
}

/**
 * Of two payloads, the one with the most recent device data.
 *
 * Falls back to `a` when either payload cannot be dated, so an undatable
 * payload never displaces a datable one.
 */
export function fresherPayload<T extends Partial<CareLinkData>>(
  a: T | undefined,
  b: T | undefined,
): T | undefined {
  if (!a) return b;
  if (!b) return a;
  const ageA = payloadAgeMinutes(a);
  const ageB = payloadAgeMinutes(b);
  // An undatable payload must never displace a datable one, in either
  // argument position. When neither can be dated, keep the incumbent.
  if (ageA === undefined) return ageB === undefined ? a : b;
  if (ageB === undefined) return a;
  return ageB < ageA ? b : a;
}