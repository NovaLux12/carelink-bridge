import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';
import { evaluateLastAlarm, logLastAlarm } from '../last-alarm.js';

import type { NightscoutSGVEntry, NightscoutDeviceStatus, NightscoutLastAlarmAnnotation, TransformResult } from '../types/nightscout.js';
import { CARELINK_TREND_TO_NIGHTSCOUT_TREND } from './trend-map.js';
import { guessPumpOffset, guessPumpOffsetMilliseconds } from './pump-offset.js';

const STALE_DATA_THRESHOLD_MINUTES = 20;

const MMOL_L_TO_MGDL = 18.0182;

/**
 * Detects whether a CareLink payload reports glucose in mmol/L. CareLink has
 * shipped both `bgUnits` and `bgunits` casing historically; we prefer the
 * lower-case one and accept either. Returns true only for the explicit mmol
 * marker — any other/unknown unit is treated as mg/dL (do not silently
 * convert).
 */
function isMmolL(data: CareLinkData): boolean {
  const u = (data.bgunits ?? data.bgUnits ?? '').toUpperCase();
  return u === 'MMOL_L' || u === 'MMOL/L' || u === 'MMOL';
}

/**
 * The device family as it should appear in Nightscout's `device` field.
 *
 * `medicalDeviceFamily` is declared non-optional on `CareLinkData`, but that is
 * a description of the legacy payload, not a guarantee: the BLE endpoint
 * (`blePereodicDataEndpoint`, used for 780G / Guardian / Instinct-era devices)
 * returns the family under `deviceFamily` and MAY omit `medicalDeviceFamily`
 * entirely. Reading it blind threw
 * `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
 * inside transform() — a crash on the very first real BLE payload, which is
 * exactly the shape arriving when the Instinct sensor enters service.
 *
 * Falls through `deviceFamily` before giving up, and never throws: an unnamed
 * device is a cosmetic wart; a crashed transform is a total data outage.
 */
function deviceFamilyName(data: CareLinkData): string | undefined {
  const candidates = [data.medicalDeviceFamily, data.deviceFamily];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return undefined;
}

function deviceName(data: CareLinkData): string {
  const family = deviceFamilyName(data);
  // Lowercase matches the historical `connect-paradigm` / `connect-guardian`
  // shape Nightscout already holds, so existing series are not split.
  return family ? 'connect-' + family.toLowerCase() : 'connect-unknown';
}

function normalizeSgToMgdl(sg: number, data: CareLinkData): number {
  if (!isMmolL(data)) return sg;
  // Round to the nearest integer mg/dL — Nightscout is mg/dL-native and
  // fractional entries are confusing downstream (Loop, xDrip, AAPS all
  // expect whole-number mg/dL).
  return Math.round(sg * MMOL_L_TO_MGDL);
}

/**
 * Resolve a reading's absolute time.
 *
 * `datetime`/`timestamp` from CareLink are **local wall-clock strings with no
 * zone**. The bridge corrects them with an offset inferred from
 * `sMedicalDeviceTime` minus `currentServerTime` (see pump-offset.ts).
 *
 * v13 `display/message` payloads do not carry `sMedicalDeviceTime` or
 * `currentServerTime` at the root — they carry `clientTimeZoneName` instead.
 * When the offset cannot be computed, `parsePumpTime` returned `NaN`, and
 * `timestampAsString` then fell back to `new Date()` — silently stamping
 * EVERY reading with the time the fetch happened, which Nightscout accepts and
 * plots as a flat line at "now". Reproduced with a display/message-shaped
 * payload: `date: NaN`, `dateString: <now>`.
 *
 * Falling back to clientTimeZoneName is strictly better than either NaN or
 * local-server time: it is the patient's own zone, which is what the wire
 * string is expressed in. A `±HH:MM`-style numeric fallback is used when the
 * named zone is absent; otherwise the string is parsed as-is.
 */
/**
 * Interpret a zoneless wall-clock string as a time in a named IANA zone,
 * returning epoch ms. Returns NaN when the zone or the string is unusable.
 *
 * Two problems are being solved at once.
 *
 * 1. `Date.parse('Nov 8, 2026 01:30:00')` binds the string to the HOST's zone.
 *    Measured: the same reading yields `2026-11-08T01:30Z` on a London host and
 *    `2026-11-08T06:30Z` on a New York host — five hours apart, purely from
 *    where the process runs. Appending ` UTC` makes the parse host-independent
 *    (verified on New York and Tokyo hosts), giving the reading's own
 *    components as if they were UTC. That value is a scaffold, not the answer.
 *
 * 2. The scaffold must then be shifted by the target zone's offset AT THAT
 *    INSTANT (so DST is handled). `Intl.DateTimeFormat` with an explicit
 *    `timeZone` renders any instant in that zone, which is how the offset is
 *    measured — no date library needed.
 *
 * Iterated twice because the offset itself can change the instant's zone
 * bucket across a DST boundary; one pass is correct except within an hour of a
 * transition, two settles it.
 */
function parseInZone(rawTime: string, zone: string): number {
  // Scafold: the reading's components, armed as UTC so the host cannot skew it.
  const scaffold = Date.parse(rawTime.replace(/\s*$/, '') + ' UTC');
  if (!Number.isFinite(scaffold)) return NaN;

  const fmt = (() => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      return undefined; // invalid IANA zone
    }
  })();
  if (!fmt) return NaN;

  /** Offset (ms) of `zone` at instant `at`, i.e. localWallClock - utc. */
  const offsetAt = (at: number): number => {
    const r = fmt.formatToParts(new Date(at));
    const g = (t: string) => Number(r.find((p) => p.type === t)?.value);
    const asIfUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return Number.isFinite(asIfUtc) ? asIfUtc - at : NaN;
  };

  let instant = scaffold;
  for (let i = 0; i < 2; i++) {
    const off = offsetAt(instant);
    if (!Number.isFinite(off)) return NaN;
    instant = scaffold - off;
  }
  return instant;
}

function resolveReadingTime(
  rawTime: string,
  offsetMilliseconds: number,
  data: CareLinkData,
): number {
  const finiteOffset = Number.isFinite(offsetMilliseconds);
  if (finiteOffset) {
    const parsed = parsePumpTime(rawTime, '', offsetMilliseconds);
    if (Number.isFinite(parsed)) return parsed;
  }

  // No usable device offset. The payload's `clientTimeZoneName` says which zone
  // the wall-clock string is expressed in, so bind it to THAT zone — never to
  // the host's. Falling back to the host zone is the bug this avoids: it makes
  // the same payload mean different instants on different machines.
  const zone = data.clientTimeZoneName;
  if (zone) {
    const zoned = parseInZone(rawTime, zone);
    if (Number.isFinite(zoned)) return zoned;
  }

  // No zone, or it did not resolve. `Date.parse` binds to the host zone, which
  // is only correct when the host IS in the patient's zone. Log it so the
  // assumption is visible rather than silent.
  logger.log(
    'No usable clientTimeZoneName — interpreting "' + rawTime +
      '" as host-local time (' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')',
  );
  const naive = Date.parse(rawTime);
  return Number.isFinite(naive) ? naive : NaN;
}

/**
 * Timestamp of the newest reading in the payload, or NaN when none parse.
 *
 * Used as the `created_at` fallback when the payload carries no
 * `lastMedicalDeviceDataUpdateServerTime` (the v13 display/message shape).
 * The newest reading IS the age of the data, which is what `created_at`
 * means; substituting `Date.now()` would assert the data is fresh.
 */
function newestReadingTime(data: CareLinkData): number {
  let newest = NaN;
  for (const sgv of data.sgs ?? []) {
    const raw = sgv.timestamp ?? sgv.datetime;
    if (!raw) continue;
    const parsed = resolveReadingTime(raw, NaN, data);
    if (Number.isFinite(parsed) && (!Number.isFinite(newest) || parsed > newest)) {
      newest = parsed;
    }
  }
  return newest;
}

function parsePumpTime(
  pumpTimeString: string,
  _offset: string,
  offsetMilliseconds: number,
): number {
  return Date.parse(pumpTimeString) - offsetMilliseconds;
}

/**
 * Format a resolved timestamp for Nightscout.
 *
 * Never returns "now" for an unparseable value. The previous fallback did
 * exactly that, which is how a missing device clock turned into every reading
 * carrying the fetch time instead of an error — invisible, and worse than a
 * gap. Callers now guarantee a finite value; this throws if one slips through
 * so the bug surfaces in tests and logs rather than in the glucose graph.
 */
function timestampAsString(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    throw new Error('timestampAsString received a non-finite timestamp');
  }
  return new Date(timestamp).toISOString();
}

/**
 * Device battery level, preferring the pump-reported value (#82). The
 * reference client reads `pumpBatteryLevelPercent` first and falls back to
 * `medicalDeviceBatteryLevelPercent` only when the former is 0 or absent, so
 * a device reporting only the new field does not surface as 0% battery.
 * `||` (not `??`) mirrors that: 0 means "not reported" here.
 */
function deviceBatteryPercent(data: CareLinkData): number {
  return data.pumpBatteryLevelPercent || data.medicalDeviceBatteryLevelPercent;
}

/**
 * Sensor age / time-to-calibration in HOURS.
 *
 * The wire has two spellings depending on payload generation (xDrip
 * RecentData.java:112-113 legacy `*Hours`; :146-147 newer `*Minutes`, in the
 * same block as `clientTimeZoneName`). A v13 display/message payload sends the
 * minutes pair, so reading only `*Hours` yields `undefined` for sensor age on
 * exactly the device this bridge is being prepared for.
 *
 * Nightscout's `connect` block is documented in hours (and every value this
 * bridge has ever written there was hours), so minutes are converted rather
 * than passed through — passing 10080 for a 7-day sensor would be a
 * 60x lie in a medical field.
 */
function sensorHours(
  hours: number | undefined,
  minutes: number | undefined,
): number | undefined {
  if (typeof hours === 'number' && Number.isFinite(hours)) return hours;
  if (typeof minutes === 'number' && Number.isFinite(minutes)) {
    return minutes / 60;
  }
  return undefined;
}

function deviceStatusEntry(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): NightscoutDeviceStatus {
  // Compute lastAlarm annotation + side-effect log once per transform call.
  // Both branches (GUARDIAN, pump) attach the same annotation. NEVER
  // publishes to /api/v1/treatments.json — see src/last-alarm.ts.
  const lastAlarmEval = evaluateLastAlarm(data.lastAlarm);
  if (lastAlarmEval) {
    logLastAlarm(lastAlarmEval); // priority-1 codes always warn
  }
  const lastAlarm: NightscoutLastAlarmAnnotation | undefined =
    lastAlarmEval?.annotation;

  // Resolve once: on a BLE payload the family may arrive only as
  // `deviceFamily`, so reading `medicalDeviceFamily` directly would miss the
  // GUARDIAN branch as well as crash in deviceName(). Same fix, same reason.
  const family = deviceFamilyName(data);

  // `created_at` must never be "now". v13 display/message sends no
  // `lastMedicalDeviceDataUpdateServerTime`, so fall back to the newest
  // reading's own timestamp — the age of the data is what this field means.
  const deviceUpdateAt = Number.isFinite(data.lastMedicalDeviceDataUpdateServerTime)
    ? data.lastMedicalDeviceDataUpdateServerTime
    : newestReadingTime(data);

  if (family === 'GUARDIAN') {
    return {
      created_at: timestampAsString(deviceUpdateAt),
      device: deviceName(data),
      uploader: {
        battery: deviceBatteryPercent(data),
      },
      last_alarm: lastAlarm,


      connect: {
        sensorState: data.sensorState,
        calibStatus: data.calibStatus,
        sensorDurationHours: sensorHours(data.sensorDurationHours, data.sensorDurationMinutes),
        timeToNextCalibHours: sensorHours(data.timeToNextCalibHours, data.timeToNextCalibrationMinutes),
        conduitInRange: data.conduitInRange,
        conduitMedicalDeviceInRange: data.conduitMedicalDeviceInRange,
        conduitSensorInRange: data.conduitSensorInRange,
        medicalDeviceBatteryLevelPercent: data.medicalDeviceBatteryLevelPercent,
        pumpBatteryLevelPercent: data.pumpBatteryLevelPercent,
        medicalDeviceFamily: family,
      },
    };
  }

  return {
    created_at: timestampAsString(deviceUpdateAt),
    device: deviceName(data),
    uploader: {
      battery: data.conduitBatteryLevel,
    },
    last_alarm: lastAlarm,


    pump: {
      battery: { percent: deviceBatteryPercent(data) },
      // Units fields win over reservoirLevelPercent (#83): the percent is
      // quantised and the units are rounded, so they can disagree slightly,
      // and downstream looping clients read the units value.
      reservoir: data.reservoirRemainingUnits ?? data.reservoirAmount,
      iob: {
        timestamp: timestampAsString(deviceUpdateAt),
        bolusiob: data.activeInsulin?.amount != null && data.activeInsulin.amount >= 0
          ? data.activeInsulin.amount
          : undefined,
      },
      // The pump clock is what this field reports. When the payload carries no
      // device time (v13 display/message), the newest reading is the best
      // available statement about "when this device last spoke", and is
      // honest in a way that `Date.now()` is not.
      clock: timestampAsString(
        data.sMedicalDeviceTime
          ? resolveReadingTime(data.sMedicalDeviceTime, offsetMilliseconds, data)
          : deviceUpdateAt
      ),
    },
    connect: {
      sensorState: data.sensorState,
      calibStatus: data.calibStatus,
      sensorDurationHours: sensorHours(data.sensorDurationHours, data.sensorDurationMinutes),
      timeToNextCalibHours: sensorHours(data.timeToNextCalibHours, data.timeToNextCalibrationMinutes),
      conduitInRange: data.conduitInRange,
      conduitMedicalDeviceInRange: data.conduitMedicalDeviceInRange,
      conduitSensorInRange: data.conduitSensorInRange,
      medicalDeviceBatteryLevelPercent: data.medicalDeviceBatteryLevelPercent,
      pumpBatteryLevelPercent: data.pumpBatteryLevelPercent,
    },
  };
}

function sgvEntries(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): NightscoutSGVEntry[] {
  if (!data.sgs?.length) {
    return [];
  }

  const sgvs: NightscoutSGVEntry[] = [];
  for (const sgv of data.sgs) {
    if (sgv.kind !== 'SG' || sgv.sg === 0) continue;

    // Readings from the `display/message` route carry `timestamp` instead of
    // `datetime`. Both are local wall-clock strings with no zone, so the same
    // offset correction applies; preferring `timestamp` matches the reference
    // client.
    const rawTime = sgv.timestamp ?? sgv.datetime ?? '';

    // Never fall through to the current time. An unresolvable reading is
    // dropped, not stamped "now": a dropped reading is a visible gap in the
    // graph, whereas a reading stamped "now" silently corrupts the series
    // (Nightscout accepts it and plots a flat line at the fetch time).
    const timestamp = rawTime
      ? resolveReadingTime(rawTime, offsetMilliseconds, data)
      : NaN;
    if (!Number.isFinite(timestamp)) {
      logger.log('Dropping SGV with unparseable time: ' + JSON.stringify(rawTime));
      continue;
    }

    sgvs.push({
      type: 'sgv' as const,
      sgv: normalizeSgToMgdl(sgv.sg, data),
      date: timestamp,
      dateString: timestampAsString(timestamp),
      device: deviceName(data),
    });
  }

  // Apply trend data to the most recent SGV
  if (sgvs.length > 0 && data.sgs[data.sgs.length - 1].sg !== 0) {
    const trendData = CARELINK_TREND_TO_NIGHTSCOUT_TREND[data.lastSGTrend];
    if (trendData) {
      sgvs[sgvs.length - 1] = { ...sgvs[sgvs.length - 1], ...trendData };
    }
  }

  return sgvs;
}

export function transform(data: CareLinkData, sgvLimit?: number): TransformResult {
  // The staleness gate needs BOTH device timestamps. v13 display/message sends
  // neither, so the check is skipped rather than computed from `undefined`
  // (which yields `NaN > threshold` === false and would silently pass anyway).
  // Skipping is the honest behaviour: without a device clock there is nothing
  // to measure staleness against, and refusing the payload outright would
  // discard good glucose data.
  if (
    typeof data.currentServerTime === 'number' &&
    typeof data.lastMedicalDeviceDataUpdateServerTime === 'number'
  ) {
    const recency =
      (data.currentServerTime - data.lastMedicalDeviceDataUpdateServerTime) / (60 * 1000);

    if (recency > STALE_DATA_THRESHOLD_MINUTES) {
      logger.log('Stale CareLink data: ' + recency.toFixed(2) + ' minutes old');
      return { devicestatus: [], entries: [] };
    }
  } else {
    logger.log(
      'No device clock in payload — staleness check skipped (display/message shape)',
    );
  }

  const offset = guessPumpOffset(data);
  const offsetMilliseconds = guessPumpOffsetMilliseconds(data);
  const limit = sgvLimit ?? Infinity;

  return {
    devicestatus: [deviceStatusEntry(data, offset, offsetMilliseconds)],
    entries: sgvEntries(data, offset, offsetMilliseconds).slice(-limit),
  };
}
