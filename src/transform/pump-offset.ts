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
 * Offset between the device's wall clock and the server clock, in ms.
 *
 * Returns `NaN` when either timestamp is absent. That is deliberate and
 * load-bearing: v13 `display/message` payloads carry neither
 * `sMedicalDeviceTime` nor `currentServerTime`, and the previous version
 * subtracted `undefined` from `Date.parse(undefined)`, producing `NaN` which
 * then propagated into every reading's date. `NaN` here is the signal to fall
 * back, not a value to arithmetic on.
 */
export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  if (
    typeof data.sMedicalDeviceTime !== 'string' ||
    typeof data.currentServerTime !== 'number'
  ) {
    return NaN;
  }
  const pumpTimeAsIfUTC = Date.parse(data.sMedicalDeviceTime);
  const serverTimeUTC = data.currentServerTime;
  if (!Number.isFinite(pumpTimeAsIfUTC) || !Number.isFinite(serverTimeUTC)) {
    return NaN;
  }
  const raw = pumpTimeAsIfUTC - serverTimeUTC;
  return Math.round(raw / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}
