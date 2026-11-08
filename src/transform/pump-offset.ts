import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';

// Real-world UTC offsets are all multiples of 15 minutes (+05:30 India,
// +09:30 central Australia, +05:45 Nepal, -03:30 Newfoundland). Rounding
// the pump/server clock difference to the nearest quarter hour supports
// those zones while still absorbing up to ±7.5 minutes of pump clock
// drift. Rounding to whole hours (the previous behaviour) skewed every
// SGV timestamp by up to 30 minutes for users in those zones — see #15.
const QUARTER_HOUR_MS = 15 * 60 * 1000;

let lastGuess: string | undefined;

export function guessPumpOffset(data: CareLinkData): string {
  const offsetMs = guessPumpOffsetMilliseconds(data);
  if (!Number.isFinite(offsetMs)) {
    // No device clock in the payload (v13 display/message shape). There is no
    // offset to report, and inventing one would shift every reading. The
    // transform falls back to `clientTimeZoneName` instead.
    return '';
  }
  const totalMinutes = Math.abs(offsetMs) / (60 * 1000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const offset =
    (offsetMs >= 0 ? '+' : '-') +
    String(hours).padStart(2, '0') +
    String(minutes).padStart(2, '0');

  if (offset !== lastGuess) {
    logger.log(
      'Guessed pump timezone ' + offset +
      ' (pump time: "' + data.sMedicalDeviceTime +
      '"; server time: ' + new Date(data.currentServerTime ?? 0) + ')'
    );
  }
  lastGuess = offset;
  return offset;
}

/**
 * Largest offset accepted, in hours.
 *
 * Real UTC offsets top out at ±14 h (Kiritimati +14, Baker Island −12). xDrip
 * uses 26 h as its "possibly a different time zone" ceiling and rejects
 * anything larger as a clock fault rather than a zone. Without a bound, a
 * single stale or malformed timestamp pair shifts EVERY reading in the payload
 * by the delta — and unlike a missing timestamp, that produces plausible dates
 * in the wrong place, which nothing downstream can detect.
 */
const MAX_OFFSET_HOURS = 26;

/**
 * Offset between the device's wall clock and the server clock, in ms.
 *
 * Returns `NaN` when either timestamp is absent, OR when the computed delta
 * exceeds MAX_OFFSET_HOURS. That is deliberate and load-bearing: v13
 * `display/message` payloads carry neither `sMedicalDeviceTime` nor
 * `currentServerTime`, and the previous version subtracted `undefined` from
 * `Date.parse(undefined)`, producing `NaN` which then propagated into every
 * reading's date. `NaN` here is the signal to fall back, not a value to
 * arithmetic on.
 *
 * The 26 h bound mirrors xDrip's `correctTimeInRecentData` /
 * `correctTimeInDisplayMessage`, which only apply a correction when
 * `diffInHour != 0 && diffInHour < 26`. Beyond that the pair is reporting a
 * clock fault, not a time zone, and trusting it would be worse than the
 * uncorrected wall-clock string.
 */
export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  const maxOffsetMs = MAX_OFFSET_HOURS * 60 * 60 * 1000;

  /**
   * Two clock pairs, in preference order.
   *
   * `sMedicalDeviceTime`/`currentServerTime` is the legacy pair; xDrip's v13
   * path does not use it at all. `lastConduitDateTime`/
   * `lastConduitUpdateServerDateTime` is what `correctTimeInDisplayMessage()`
   * actually reads, so it is the right evidence for a display/message payload
   * and is tried first when present.
   */
  const pairs: Array<[string | number | undefined, number | undefined, string]> = [
    [data.lastConduitDateTime, data.lastConduitUpdateServerDateTime, 'conduit'],
    [data.sMedicalDeviceTime, data.currentServerTime, 'device'],
  ];

  for (const [deviceTime, serverTime, label] of pairs) {
    const deviceMs =
      typeof deviceTime === 'number' ? deviceTime : Date.parse(deviceTime ?? '');
    if (!Number.isFinite(deviceMs) || typeof serverTime !== 'number' ||
        !Number.isFinite(serverTime)) {
      continue;
    }

    const raw = deviceMs - serverTime;
    if (Math.abs(raw) > maxOffsetMs) {
      logger.log(
        'Ignoring implausible ' + label + ' clock delta of ' +
          (raw / 3_600_000).toFixed(1) + 'h (limit ' + MAX_OFFSET_HOURS + 'h) — ' +
          'treating it as a clock fault, not a time zone',
      );
      // A fault in the PREFERRED pair should not silently fall through to the
      // other pair and apply a different correction; report "no usable offset"
      // so the caller uses the wall-clock string as-is.
      return NaN;
    }
    return Math.round(raw / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  }

  return NaN;
}
