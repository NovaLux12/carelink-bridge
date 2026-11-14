import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';
import { evaluateLastAlarm, logLastAlarm } from '../last-alarm.js';
import { mapMarkers } from './treatments.js';

import type { NightscoutSGVEntry, NightscoutDeviceStatus, NightscoutLastAlarmAnnotation, TransformResult } from '../types/nightscout.js';
import { CARELINK_TREND_TO_NIGHTSCOUT_TREND } from './trend-map.js';
import { guessPumpOffset, guessPumpOffsetMilliseconds, pumpClockReading } from './pump-offset.js';

/**
 * A devicestatus entry carrying the optional pump-clock drift annotation.
 *
 * Declared here rather than on `NightscoutDeviceStatus` so the published shape
 * stays as-is until a Nightscout consumer is confirmed to read it. The field is
 * additive and top-level (alongside `last_alarm`), which is where the research
 * memo's P0.3 recommendation places it.
 */
type DeviceStatusWithDrift = NightscoutDeviceStatus & {
  /**
   * Pump clock drift, in minutes, off the nearest real UTC offset.
   *
   * Present ONLY when (a) the payload carries a device clock we can compare
   * against the server's, and (b) the measured drift is non-zero. Absent means
   * "not measurable" — never 0 as a default. A `0` here is a positive claim
   * that the pump's clock sits on the quarter-hour grid; a v13
   * display/message payload has no pump clock at all, so writing 0 for it
   * would assert something we never measured.
   *
   * SCOPE, measured: this annotation detects CLOCK DRIFT, not DST. A DST shift
   * is a whole number of quarter hours, so it rounds away and reports no
   * drift while the offset is an hour wrong (see test/dst-drift.test.ts).
   */
  clock_drift_minutes?: number;
};

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

  // No zone, or it did not resolve.
  //
  // Fall back to UTC, NOT the host zone. The host zone makes the same payload
  // mean different instants on different machines — the exact bug this function
  // exists to prevent. UTC is at least deterministic: it is wrong by a known,
  // constant offset rather than by whatever the deployment happens to be set
  // to, and the log line below makes the assumption visible.
  //
  // An operator who knows the patient's zone can pin it with
  // CARELINK_ASSUME_TIMEZONE, which is the honest way to supply the missing
  // fact rather than inferring it from the server's locale.
  const assumed = process.env['CARELINK_ASSUME_TIMEZONE']?.trim();
  if (assumed) {
    const zoned = parseInZone(rawTime, assumed);
    if (Number.isFinite(zoned)) return zoned;
  }

  logger.log(
    'No usable clientTimeZoneName — interpreting "' + rawTime +
      '" as UTC. If the patient is not in UTC, set CARELINK_ASSUME_TIMEZONE ' +
      "(e.g. 'Europe/London') or every reading will be offset.",
  );
  const utc = Date.parse(rawTime.replace(/\s*$/, '') + ' UTC');
  return Number.isFinite(utc) ? utc : NaN;
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
    const raw = sgv.datetime ?? sgv.timestamp;
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

/**
 * The two recorded `therapyAlgorithmState` vocabularies
 * (carelink-api-research area DP §3). Disjoint sets, five and three tokens.
 */
const AUTO_MODE_SHIELD_STATES = new Set(['AUTO_BASAL', 'SAFE_BASAL', 'FEATURE_OFF']);
const PLGM_LGS_STATES = new Set([
  'FEATURE_OFF',
  'REFRACTORY_PERIOD',
  'MONITORING',
  'SUSPEND_FIRED_PLGM',
  'SUSPEND_FIRED_LGS',
]);
const SUSPEND_FIRED_STATES = new Set(['SUSPEND_FIRED_PLGM', 'SUSPEND_FIRED_LGS']);

export interface AutoModeSnapshot {
  shieldState?: string;
  plgmState?: string;
  /**
   * True only for the two tokens that mean delivery has stopped. `false` for
   * every other KNOWN token — and `null` when the token was not recognised, so
   * an unknown state cannot be read as "not suspended". A boolean `false`
   * there would be a quiet lie in a clinical field: the whole point of
   * surfacing the raw token is that the consumer must not assume it.
   */
  suspendFired: boolean | null;
  /** Whether both present tokens were inside the recorded vocabulary. */
  recognised: boolean;
  /** Tokens that were present but outside the recorded vocabulary. */
  unrecognisedStates: string[];
}

/**
 * Describe `therapyAlgorithmState` without translating it.
 *
 * The tokens are passed through verbatim: they were recovered from the
 * vendor's own parser and never seen on a captured payload (area DP §3), so a
 * new token is data, not corruption, and mapping it into an invented enum
 * would destroy the only evidence of it. What must NOT happen is the state
 * being silently invisible — before this change an unrecognised
 * `plgmLgsState` produced `suspendFired: false` and nothing else, so a
 * consumer saw a confident "not suspended" for a token nobody understands.
 *
 * Returns undefined only when the payload carries no object at all: a
 * CGM-only account must not gain a phantom annotation.
 */
export function describeAutoMode(therapy: unknown): AutoModeSnapshot | undefined {
  if (!therapy || typeof therapy !== 'object' || Array.isArray(therapy)) return undefined;
  const state = therapy as { autoModeShieldState?: unknown; plgmLgsState?: unknown };

  const shield = typeof state.autoModeShieldState === 'string' ? state.autoModeShieldState : undefined;
  const plgm = typeof state.plgmLgsState === 'string' ? state.plgmLgsState : undefined;

  // An object with neither field carries no state at all. Emitting
  // `{suspendFired: null}` for it would be an annotation that says nothing
  // about the pump, which is worse than no annotation — a consumer cannot tell
  // it apart from a payload whose fields were stripped.
  if (state.autoModeShieldState === undefined && state.plgmLgsState === undefined) {
    return undefined;
  }

  const unrecognised: string[] = [];
  // A field that is absent is not a mislabel; only a present-but-unknown token
  // is. A non-string present value is likewise surfaced, coerced for the log.
  if (state.autoModeShieldState !== undefined && shield === undefined) {
    unrecognised.push(String(state.autoModeShieldState));
  } else if (shield !== undefined && !AUTO_MODE_SHIELD_STATES.has(shield)) {
    unrecognised.push(shield);
  }
  if (state.plgmLgsState !== undefined && plgm === undefined) {
    unrecognised.push(String(state.plgmLgsState));
  } else if (plgm !== undefined && !PLGM_LGS_STATES.has(plgm)) {
    unrecognised.push(plgm);
  }

  if (unrecognised.length > 0) {
    // Loud on purpose: the token set was never observed on the wire, so an
    // unknown value is the one signal that the vocabulary is incomplete.
    logger.warn(
      'therapyAlgorithmState carries token(s) outside the recorded vocabulary: ' +
        unrecognised.join(', ') +
        ' — the raw value is passed through, not interpreted',
      { autoModeState: state },
    );
  }

  const snapshot: AutoModeSnapshot = {
    suspendFired: plgm === undefined ? null : SUSPEND_FIRED_STATES.has(plgm) ? true
      : PLGM_LGS_STATES.has(plgm) ? false : null,
    recognised: unrecognised.length === 0,
    unrecognisedStates: unrecognised,
  };
  if (shield !== undefined) snapshot.shieldState = shield;
  else if (state.autoModeShieldState !== undefined) {
    snapshot.shieldState = String(state.autoModeShieldState);
  }
  if (plgm !== undefined) snapshot.plgmState = plgm;
  else if (state.plgmLgsState !== undefined) {
    snapshot.plgmState = String(state.plgmLgsState);
  }
  return snapshot;
}

/**
 * Reservoir in the units Nightscout's `pump.reservoir` is documented in.
 *
 * Units fields win over `reservoirLevelPercent` (#83): the percent is
 * quantised to five snap-points (0/25/50/75/100 — research memo §P2.1) and the
 * units are rounded, so they can disagree slightly, and downstream looping
 * clients read the units value.
 *
 * A percent is NOT converted into units as a last resort. That conversion
 * needs the reservoir's capacity, which is not in the payload and is not
 * measured, so `25` would become an invented `75` (or `60`, or `100`) — a
 * fabricated dose-supply figure in a medical field. Instead the percent is
 * surfaced separately as `pump.reservoirPercent`, so a percent-only payload is
 * visible rather than silently `undefined`. Research memo §P2.1 asks for
 * exactly that field, and it is the honest half of the mapping: coarse beats
 * absent, but only when labelled as coarse.
 */
function reservoirUnits(data: CareLinkData): number | undefined {
  for (const v of [data.reservoirRemainingUnits, data.reservoirAmount]) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

function reservoirPercent(data: CareLinkData): number | undefined {
  const v = data.reservoirLevelPercent;
  // 0..100 or nothing: a percent outside that range is malformed, and a
  // negative percent would read as "more than full" downstream.
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return undefined;
  return v;
}

function deviceStatusEntry(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): DeviceStatusWithDrift {
  // Pump clock drift annotation (research memo P0.3). Present only when a
  // device clock exists AND the drift is non-zero — see DeviceStatusWithDrift.
  // `Math.abs` because a pump running 6 min fast and one running 6 min slow are
  // equally worth an operator's attention, and the sign is already carried by
  // the raw delta in the log line; the annotation is a magnitude alarm.
  const clockReading = pumpClockReading(data);
  const clockDrift =
    clockReading && clockReading.driftMinutes !== 0
      ? { clock_drift_minutes: Math.abs(clockReading.driftMinutes) }
      : {};
  // Compute lastAlarm annotation + side-effect log once per transform call.
  // Both branches (GUARDIAN, pump) attach the same annotation. NEVER
  // publishes to /api/v1/treatments.json — see src/last-alarm.ts.
  const lastAlarmEval = evaluateLastAlarm(data.lastAlarm);
  if (lastAlarmEval) {
    logLastAlarm(lastAlarmEval); // priority-1 codes always warn
  }
  const lastAlarm: NightscoutLastAlarmAnnotation | undefined =
    lastAlarmEval?.annotation;

  // SmartGuard auto-mode state, read off `therapyAlgorithmState`. Emitted only
  // when the payload carries the object — a CGM-only account has no pump and
  // must not gain a phantom annotation. See describeAutoMode() for why an
  // unknown token is surfaced instead of translated.
  const autoMode = describeAutoMode(data.therapyAlgorithmState);

  // Resolve once: on a BLE payload the family may arrive only as
  // `deviceFamily`, so reading `medicalDeviceFamily` directly would miss the
  // GUARDIAN branch as well as crash in deviceName(). Same fix, same reason.
  const family = deviceFamilyName(data);

  // Computed once so `reservoir` and `reservoirPercent` cannot disagree.
  const pct = reservoirPercent(data);

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
      ...clockDrift,


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
    ...clockDrift,


    pump: {
      battery: { percent: deviceBatteryPercent(data) },
      // Units fields win over reservoirLevelPercent (#83): the percent is
      // quantised and the units are rounded, so they can disagree slightly,
      // and downstream looping clients read the units value. A percent-only
      // payload keeps `reservoir` undefined — converting it would need the
      // reservoir capacity, which is not in the payload — but the percent is
      // published separately so the value is not silently lost.
      reservoir: reservoirUnits(data),
      ...(pct !== undefined ? { reservoirPercent: pct } : {}),
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
      // SmartGuard's own auto-mode state (carelink-api-research area DP §3).
      // `plgmLgsState` is the clinically interesting half: SUSPEND_FIRED_PLGM /
      // SUSPEND_FIRED_LGS mean the pump has stopped delivering. Both fields are
      // passed through verbatim rather than translated into an invented enum —
      // a value outside the recorded vocabulary is data, not corruption, and a
      // consumer should be able to see it.
      ...(autoMode ? { autoMode } : {}),
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

/**
 * `kind` tokens that mean "this reading is NOT sensor glucose".
 *
 * Deliberately a small allowlist of KNOWN non-SG vocabulary rather than an
 * accept-list of `'SG'`: the wire form has never been observed on the
 * display/message route, so an unknown token is more likely to be glucose under
 * a name we have not met than to be a calibration. Known calibration and
 * meter-BG kinds are rejected because plotting those as sensor glucose would
 * fabricate a reading the sensor never produced.
 */
const NON_SG_KINDS: ReadonlySet<string> = new Set([
  'CAL',
  'CALIBRATION',
  'BG',
  'METER',
]);

function isNonSgKind(kind: unknown): boolean {
  return typeof kind === 'string' && NON_SG_KINDS.has(kind.toUpperCase());
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
    // `kind` is a GUESS: it is typed required in types/carelink.ts, but it has
    // never been observed on the display/message route — the route this bridge's
    // v0.3 line exists to support. Measured: a payload with no `kind` produced
    // 0 entries, and one with `kind: "sg"` produced 0 entries, i.e. a silent
    // total glucose outage from a field-name assumption. So accept absence, and
    // reject only a DIFFERENT known non-SG token.
    if (sgv.kind !== undefined && sgv.kind !== null && sgv.kind !== 'SG') {
      if (!isNonSgKind(sgv.kind)) {
        // Unknown kind: fall through to the SGV path rather than dropping data.
        logger.log('SGV with unrecognised kind, accepted as SG', {
          kind: String(sgv.kind),
        });
      } else {
        continue;
      }
    }
    if (sgv.sg === 0) continue;

    // Precedence: `datetime` FIRST, then `timestamp`.
    //
    // SensorGlucose.getDate() (xDrip SensorGlucose.java:31-36) returns
    // `datetimeAsDate` when non-null and only falls back to `timestamp`:
    //
    //     if (this.datetimeAsDate != null) return datetimeAsDate;
    //     else return timestamp;
    //
    // An earlier version of this code claimed the opposite "matches the
    // reference client" — it did not. Both carry the same zoneless wall-clock
    // form, so preferring `datetime` costs nothing and agrees with the client
    // that has years of production use.
    const rawTime = sgv.datetime ?? sgv.timestamp ?? '';

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

  // Sort ASCENDING by time before anything downstream reads a position.
  //
  // Two silent wrongs followed from the missing sort, both reproduced:
  //   - the trend was attached to `sgvs[sgvs.length - 1]`, which for a
  //     descending payload is the OLDEST reading — measured, trend "DoubleUp"
  //     landed on sgv 90 while the newest (200) got none;
  //   - `transform()` then does `.slice(-limit)`, so on a descending payload it
  //     kept the OLDEST `limit` readings and discarded the newest — measured
  //     with limit 2: kept [100, 90] and dropped 200.
  //
  // The cumulus path already sorts upstream; the legacy `connect/data` path
  // does not, and that is the path whose ordering is unverified against a real
  // account. Sorting here makes both paths agree.
  sgvs.sort((a, b) => a.date - b.date);

  // Apply the trend only when the payload's NEWEST slot actually carries a
  // reading.
  //
  // `sg === 0` is the vendor's "no glucose at this slot" sentinel, and the
  // newest slot can be empty while older readings are present — the legacy
  // connect/data shape represents that as a trailing `sg: 0` entry, sometimes
  // with an empty `datetime`. Attaching `lastSGTrend` then would label the last
  // good reading with a trend belonging to a slot that has no reading, which is
  // what the `missingLastSgv` fixture and "should not add a trend if the most
  // recent sgv is absent" have always guarded.
  //
  // Two ways a slot can be the newest and empty, so both are checked:
  //   - dated: a `sg: 0` entry whose time is at or after the newest real
  //     reading (survives the sort, and is correct for a descending payload);
  //   - undated: a `sg: 0` entry at the array tail with no parseable time,
  //     which is positional — the wire array is slot-ordered.
  const newestReading = sgvs.length > 0 ? sgvs[sgvs.length - 1].date : NaN;
  const rawTail = data.sgs[data.sgs.length - 1];
  const undatedEmptyTail =
    rawTail !== undefined && rawTail.sg === 0 && !(rawTail.datetime ?? rawTail.timestamp);

  const newestSlotIsEmpty =
    sgvs.length > 0 &&
    (undatedEmptyTail ||
      data.sgs.some((s) => {
        if (s.sg !== 0) return false;
        const raw = s.datetime ?? s.timestamp ?? '';
        if (!raw) return false;
        const t = resolveReadingTime(raw, offsetMilliseconds, data);
        return Number.isFinite(t) && t >= newestReading;
      }));

  if (sgvs.length > 0 && !newestSlotIsEmpty) {
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
      // WARN, not log. At the default CARELINK_QUIET=true, logger.log emits
      // nothing, so this — the one condition the stale watchdog exists to catch
      // — was silent. The return value also carries the verdict so the caller
      // can refuse to count it as a healthy fetch.
      logger.warn(
        'Stale CareLink data: ' + recency.toFixed(2) + ' minutes old (> ' +
          STALE_DATA_THRESHOLD_MINUTES + ' min) — payload refused',
        { component: 'transform', staleMinutes: Number(recency.toFixed(2)) },
      );
      return {
        devicestatus: [],
        entries: [],
        treatments: [],
        stale: true,
        staleMinutes: recency,
      };
    }
  } else {
    logger.log(
      'No device clock in payload — staleness check skipped (display/message shape)',
    );
  }

  const offset = guessPumpOffset(data);
  const offsetMilliseconds = guessPumpOffsetMilliseconds(data);
  const limit = sgvLimit ?? Infinity;

  // Markers are dated RELATIVE to the newest datapoint, so they need the same
  // anchor the SGV path uses. Reusing `deviceUpdateAt` rather than re-deriving
  // it keeps one clock: a marker and the reading beside it cannot disagree
  // about what "now" is.
  const markerAnchor = Number.isFinite(data.lastMedicalDeviceDataUpdateServerTime)
    ? (data.lastMedicalDeviceDataUpdateServerTime as number)
    : newestReadingTime(data);
  const markers = mapMarkers(data.markers, markerAnchor);
  if (markers.undatable > 0) {
    // Loud, because the alternative reading is "this fetch had no meals" when
    // in fact it had some that could not be placed in time.
    logger.warn(
      'Dropped ' + markers.undatable + ' marker(s) that could not be dated ' +
        '(no usable anchor)',
      { undatable: markers.undatable },
    );
  }
  const unmappedKinds = Object.entries(markers.unmapped);
  if (unmappedKinds.length > 0) {
    logger.log('Markers present but not mapped to treatments', {
      unmapped: markers.unmapped,
    });
  }

  return {
    devicestatus: [deviceStatusEntry(data, offset, offsetMilliseconds)],
    entries: sgvEntries(data, offset, offsetMilliseconds).slice(-limit),
    treatments: markers.treatments,
  };
}
