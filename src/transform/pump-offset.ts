import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';

// Real-world UTC offsets are all multiples of 15 minutes (+05:30 India,
// +09:30 central Australia, +05:45 Nepal, -03:30 Newfoundland). Rounding
// the pump/server clock difference to the nearest quarter hour supports
// those zones while still absorbing up to ±7.5 minutes of pump clock
// drift. Rounding to whole hours (the previous behaviour) skewed every
// SGV timestamp by up to 30 minutes for users in those zones — see #15.
const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * Largest offset accepted, in hours.
 *
 * Real UTC offsets top out at ±14 h (Kiritimati +14, Baker Island −12). xDrip
 * uses 26 h as its "possibly a different time zone" ceiling and rejects
 * anything larger as a clock fault rather than a zone. Without a bound, a
 * single stale or malformed timestamp pair shifts EVERY reading in the payload
 * by the delta — and unlike a missing timestamp, that produces plausible dates
 * in the wrong place, which nothing downstream can detect.
 *
 * ⚠ WHAT THIS BOUND DOES **NOT** CATCH: DST. A 1 h spring-forward or
 * fall-back delta is nowhere near 26 h, so it passes the bound silently and is
 * emitted as a wrong-but-consistent whole-hour offset (−0100 where +0000 was
 * meant, say). Measured, not inferred — see test/dst-drift.test.ts. The bound
 * is a *fault* ceiling, not a *plausibility* check, and it can never be the
 * latter: the offset a DST shift produces is indistinguishable from a real
 * zone offset by arithmetic alone.
 */
const MAX_OFFSET_HOURS = 26;

/** One resolved pump-clock reading: the raw delta, the zone it implies, the drift. */
export interface PumpClockReading {
  /** Device wall clock minus server clock, in ms. Unrounded. */
  rawMs: number;
  /**
   * `rawMs` rounded to the nearest quarter hour, in ms. This is the value the
   * transform applies, and it is the offset of *some* real time zone by
   * construction.
   */
  offsetMs: number;
  /**
   * Signed `rawMs - offsetMs` in minutes, rounded to one decimal: how far the
   * device clock sits off the quarter-hour grid.
   *
   * Every real UTC offset is a multiple of 15 minutes, so a non-zero value here
   * is device clock drift and nothing else — that is what makes it worth
   * publishing to an operator (research memo P0.3 recommends exactly this as
   * `clock_drift_minutes`).
   *
   * ⚠ WHAT IT CANNOT SEE: a DST shift. A DST delta is itself a whole number of
   * quarter hours, so it rounds cleanly and reports drift 0.0 while the offset
   * is an hour wrong. The two failures are disjoint: drift tells you the pump's
   * clock is off the grid, DST tells you the pump's clock stopped following the
   * zone. Do not read drift 0 as "the offset is right".
   */
  driftMinutes: number;
  /** Which clock pair produced this reading: `conduit` or `device`. */
  label: string;
}

/**
 * Offset between the device's wall clock and the server clock, in ms.
 *
 * Returns `undefined` when either timestamp is absent, OR when the computed
 * delta exceeds MAX_OFFSET_HOURS. `undefined` here is the signal to fall back
 * to `clientTimeZoneName`, not a value to arithmetic on: v13 `display/message`
 * payloads carry neither `sMedicalDeviceTime` nor `currentServerTime`, and the
 * previous version subtracted `undefined` from `Date.parse(undefined)`,
 * producing `NaN` which then propagated into every reading's date.
 *
 * The 26 h bound mirrors xDrip's `correctTimeInRecentData` /
 * `correctTimeInDisplayMessage`, which only apply a correction when
 * `diffInHour != 0 && diffInHour < 26`. Beyond that the pair is reporting a
 * clock fault, not a time zone, and trusting it would be worse than the
 * uncorrected wall-clock string.
 */
export function pumpClockReading(data: CareLinkData): PumpClockReading | undefined {
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

    const rawMs = deviceMs - serverTime;
    if (Math.abs(rawMs) > maxOffsetMs) {
      logger.log(
        'Ignoring implausible ' + label + ' clock delta of ' +
          (rawMs / 3_600_000).toFixed(1) + 'h (limit ' + MAX_OFFSET_HOURS + 'h) — ' +
          'treating it as a clock fault, not a time zone',
      );
      // A fault in the PREFERRED pair should not silently fall through to the
      // other pair and apply a different correction; report "no usable offset"
      // so the caller uses the wall-clock string as-is.
      return undefined;
    }

    const offsetMs = Math.round(rawMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
    // One decimal: sub-minute drift is noise, but 6.4 vs 7.4 is not.
    const driftMinutes = Math.round(((rawMs - offsetMs) / 60_000) * 10) / 10;

    return { rawMs, offsetMs, driftMinutes, label };
  }

  return undefined;
}

/**
 * Signed pump clock drift in minutes, or `undefined` when there is no device
 * clock to measure against.
 *
 * `undefined` is load-bearing: a v13 display/message payload has no pump clock
 * at all, and a `0` there would be a *claim* that the clock is exact. Absent
 * means "not measurable", which is a different statement from "measured, and
 * correct".
 */
export function pumpClockDriftMinutes(data: CareLinkData): number | undefined {
  return pumpClockReading(data)?.driftMinutes;
}

/** Offset between the device's wall clock and the server clock, in ms, rounded to a quarter hour. */
export function guessPumpOffsetMilliseconds(data: CareLinkData): number {
  const reading = pumpClockReading(data);
  return reading ? reading.offsetMs : NaN;
}

/**
 * Format the pump offset as a signed `±HHMM` string, or `''` when there is no
 * device clock in the payload.
 *
 * NO MODULE-LEVEL STATE. An earlier version kept a `let lastGuess` to suppress
 * a repeated log line. It was removed: the value never affected the returned
 * offset, it was shared across every account and pump in the process (so a
 * second account's first guess was silently unlogged, and a swapped pump's
 * change was swallowed), and it made the log output a function of test order.
 * The message it deduped is verbose-gated and costs one line per poll, so the
 * dedupe bought nothing that the removal costs.
 */
export function guessPumpOffset(data: CareLinkData): string {
  const reading = pumpClockReading(data);
  if (!reading) {
    // No device clock in the payload (v13 display/message shape). There is no
    // offset to report, and inventing one would shift every reading. The
    // transform falls back to `clientTimeZoneName` instead.
    return '';
  }

  const totalMinutes = Math.abs(reading.offsetMs) / (60 * 1000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const offset =
    (reading.offsetMs >= 0 ? '+' : '-') +
    String(hours).padStart(2, '0') +
    String(minutes).padStart(2, '0');

  logger.log(
    'Guessed pump timezone ' + offset +
    ' (' + reading.label + ' pair; drift ' + reading.driftMinutes.toFixed(1) + ' min' +
    '; pump time: "' + data.sMedicalDeviceTime +
    '"; server time: ' + new Date(data.currentServerTime ?? 0) + ')'
  );
  return offset;
}
