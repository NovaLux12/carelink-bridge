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
      '"; server time: ' + new Date(data.currentServerTime) + ')'
    );
  }
  lastGuess = offset;
  return offset;
}

export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  const pumpTimeAsIfUTC = Date.parse(data.sMedicalDeviceTime);
  const serverTimeUTC = data.currentServerTime;
  const raw = pumpTimeAsIfUTC - serverTimeUTC;
  return Math.round(raw / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}
