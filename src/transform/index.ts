import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';
import { evaluateLastAlarm, logLastAlarm } from '../last-alarm.js';
import { mapMarkers, markerTimeOrOffset, quantiseAnchor } from './treatments.js';

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
 * Detects whether a CareLink payload reports glucose in mmol/L.
 *
 * CareLink has shipped both `bgUnits` and `bgunits` casing historically; we
 * prefer the lower-case one and accept either. Returns true only for the
 * explicit mmol marker — any other/unknown unit is treated as mg/dL (do not
 * silently convert).
 *
 * ⚠ THE PAYLOAD CAN LIE ABOUT THIS — do not trust `bgUnits` alone.
 *
 * Measured 2026-11-27 against a real 780G (MMT-1885, medicalDeviceFamily NGP,
 * Instinct sensor): the BLE `display/message` response declared
 * `"bgUnits":"MMOL_L"` while every `sgs[].sg` in it was mg/dL. Trusting the
 * declaration multiplied each reading by 18.0182, so Nightscout received
 * 4559 mg/dL for a true 253 and rendered 253 mmol/L. Both ends of the chain
 * were "working"; the number was simply nonsense.
 *
 * The payload carries its own proof of scale, and it is the proof we use:
 * `sgBelowLimit` (50) and `limits[].lowLimit` (68) are in the SAME unit as
 * `sg`. 68 mg/dL is 3.78 mmol/L — exactly the pump's configured low alert —
 * whereas 68 mmol/L is not a blood glucose at all. A declared-mmol payload
 * whose own low limit exceeds any survivable mmol/L value is mg/dL wearing
 * the wrong label.
 */
function isMmolL(data: CareLinkData): boolean {
  const u = (data.bgunits ?? data.bgUnits ?? '').toUpperCase();
  const declaredMmol = u === 'MMOL_L' || u === 'MMOL/L' || u === 'MMOL';
  if (!declaredMmol) return false;
  return !unitDeclarationIsImplausible(data);
}

/** Highest reading that could be a real mmol/L blood glucose. */
const MMOL_PLAUSIBILITY_CEILING = 40;

/**
 * Payload shapes already reported as mislabelled, so the warning is emitted
 * once per distinct evidence rather than once per reading or per fetch.
 *
 * The guard runs inside the per-reading conversion, so without this a single
 * 288-reading payload logs 288 identical warnings — which is how a real signal
 * becomes noise an operator learns to skip.
 */
const mislabelledUnitShapesReported = new Set<string>();

/** Test seam: forget which mislabelled shapes have been reported. */
export function resetMislabelledUnitWarning(): void {
  mislabelledUnitShapesReported.clear();
}

/**
 * True when a payload declaring mmol/L carries numbers that cannot be mmol/L.
 *
 * Checks the scale-bearing fields the payload supplies for itself, in order of
 * reliability. Any ONE of them being impossible in mmol/L is enough: they all
 * share the unit of `sg`, so they cannot disagree unless the label is wrong.
 */
function unitDeclarationIsImplausible(data: CareLinkData): boolean {
  const raw = data as unknown as Record<string, unknown>;

  const limits = Array.isArray(raw['limits']) ? (raw['limits'] as Record<string, unknown>[]) : [];
  const candidates: number[] = [];
  const push = (v: unknown): void => {
    const n = typeof v === 'number' ? v : Number(v);
    // 0 is how this payload spells "no limit configured" — skip it, it is not
    // evidence either way and would otherwise look like an impossible mmol low.
    if (Number.isFinite(n) && n > 0) candidates.push(n);
  };

  push(raw['sgBelowLimit']);
  push(raw['belowHypoLimit']);
  push(raw['aboveHyperLimit']);
  for (const limit of limits) {
    push(limit['lowLimit']);
    push(limit['highLimit']);
  }
  for (const s of Array.isArray(data.sgs) ? data.sgs : []) push(s?.sg);

  const max = candidates.length ? Math.max(...candidates) : undefined;
  if (max !== undefined && max > MMOL_PLAUSIBILITY_CEILING) {
    const lowLimit = raw['sgBelowLimit'] ?? limits[0]?.['lowLimit'] ?? '?';
    const declared = String(raw['bgUnits'] ?? raw['bgunits']);
    const shape = `${declared}|max=${max}|low=${String(lowLimit)}`;
    if (!mislabelledUnitShapesReported.has(shape)) {
      mislabelledUnitShapesReported.add(shape);
      logger.warn(
        `Payload declares ${declared} but carries values up to ${max}, which cannot be ` +
          `mmol/L. Treating readings as mg/dL. (Low limit ${String(lowLimit)} is the tell.)`,
        { component: 'transform' },
      );
    }
    return true;
  }

  return false;
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
 * Is this byte a "no value" sentinel rather than a measurement?
 *
 * The 780G reports several uint8/uint16 counters as **all-ones when unknown**:
 * measured 2026-11-27, `gstBatteryLevel: 255` and `timeToNextCalibHours: 65535`
 * (0xFFFF), on a pump whose battery is simultaneously reported as 100% by
 * `medicalDeviceBatteryLevelPercent`. Passing those through would publish a
 * 255% battery and a 65535-hour calibration countdown — two numbers that look
 * like data, are obviously impossible, and would make every future reading of
 * this record suspect.
 *
 * 255 and 65535 are the whole of the vocabulary observed so far; the guard is
 * a set rather than a `>= 255` test so an unobserved sentinel is not silently
 * folded into "unknown" without someone noticing it exist.
 */
const UNSET_SENTINELS: ReadonlySet<number> = new Set([255, 65535, -1]);

function withoutSentinel(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return UNSET_SENTINELS.has(v) ? undefined : v;
}

/**
 * Sensor time-REMAINING / time-to-calibration in HOURS.
 *
 * ⚠ NOT "sensor age". The field name carries no direction and this was recorded
 * backwards once: `sensorDurationHours` / `sensorDurationMinutes` are the time
 * LEFT, not the time elapsed (VERIFIED live 2026-11-27 on a 780G + Instinct —
 * 21163 minutes read 7.5 h after insertion, against 360 h of 15-day wear, places
 * insertion at the right minute; as elapsed it is impossible). Anything that
 * renders this as age puts an expiry alarm on a sensor fitted that morning.
 * The pump also OMITS the pair when it loses the sensor, while `sensorState`
 * stays NO_ERROR_MESSAGE — so a missing value here means the LINK is down, not
 * that there is no sensor. Detail: carelink-api-research
 * findings-log/2026-11-27-display-message-field-semantics.
 *
 * The wire has two spellings depending on payload generation (xDrip
 * RecentData.java:112-113 legacy `*Hours`; :146-147 newer `*Minutes`, in the
 * same block as `clientTimeZoneName`). A v13 display/message payload sends the
 * minutes pair, so reading only `*Hours` yields `undefined` on exactly the
 * device this bridge is being prepared for.
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
  if (typeof hours === 'number' && Number.isFinite(hours)) return withoutSentinel(hours);
  if (typeof minutes === 'number' && Number.isFinite(minutes)) {
    const clean = withoutSentinel(minutes);
    return clean === undefined ? undefined : clean / 60;
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
 * A stable 24-hex Nightscout `_id` for a devicestatus record.
 *
 * Nightscout's devicestatus `create()` only skips a duplicate whose `_id` is a
 * 24-hex string; with no `_id` it inserts on every POST (see the call site).
 * The value is the device-update time floored to the minute, hashed into the
 * 12-byte hex form Mongo uses — so a re-send within the same minute updates in
 * place, and a new fetch a minute later is a new document.
 *
 * Falling back to `0` for a non-finite time keeps a deterministic id: the
 * alternative is an id that changes per call, which is the bug this fixes.
 */
export function deviceStatusId(deviceUpdateAtMs: number): string {
  const bucket = Number.isFinite(deviceUpdateAtMs)
    ? Math.floor(deviceUpdateAtMs / 60_000)
    : 0;
  // 24 hex chars == 12 bytes, the shape Mongo's ObjectId string takes and the
  // shape Nightscout's hex check accepts.
  return bucket.toString(16).padStart(24, '0').slice(-24);
}

/**
 * The delivery-status block Nightscout actually renders.
 *
 * `lib/plugins/pump.js` `updateStatus()` (cgm-remote-monitor v15.0.9, read
 * directly) reads `pump.status.suspended` / `pump.status.bolusing` as BOOLEANS
 * and raises a WARNING ("Pump Suspended") when `prefs.warnOnSuspend` is on.
 * Nothing in that repo reads `autoMode.suspendFired`, so before this the
 * bridge's most important "not delivering" fact was invisible.
 *
 * Two independent sources mean suspended:
 *   1. `medicalDeviceSuspended: true` — the pump's own report. Confirmed as a
 *      real wire field, not a guess: it appears 8 times in the vendor's own
 *      client parser (carelink-api-research area DP field census, token
 *      `medicalDeviceSuspended`, chunk byte 47,380).
 *   2. `autoMode.suspendFired === true` — SmartGuard took basal away
 *      (plgmLgsState SUSPEND_FIRED_PLGM / SUSPEND_FIRED_LGS).
 *
 * `suspendFired` is `boolean | null`, where null means "a token we do not
 * recognise" — not a suspend, and deliberately not treated as one.
 *
 * Returns undefined when neither source says suspended, so `status` is absent
 * rather than asserting a running pump. Also deliberately NOT emitting
 * `bolusing`: the payload has no trustworthy "a bolus is running right now"
 * field, and `activeInsulin` is a decayed total, not a delivery flag.
 */
export function suspendStatus(
  data: { medicalDeviceSuspended?: boolean },
  autoMode: AutoModeSnapshot | undefined,
): { status: { suspended: true } } | undefined {
  if (data.medicalDeviceSuspended === true) return { status: { suspended: true } };
  if (autoMode?.suspendFired === true) return { status: { suspended: true } };
  return undefined;
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

  // `mills` as well as `created_at`, because Nightscout's IOB plugin reads it.
  //
  // `lib/plugins/iob.js` (v15.0.9) fromDeviceStatus(), pump branch:
  //
  //     iob: iobPump.iob || iobPump.bolusiob,
  //     mills: devicestatusEntry.mills
  //
  // It takes the timestamp from the TOP-LEVEL `mills`, not from
  // `pump.iob.timestamp` — so without this field the plugin computes
  // `time - undefined` = NaN and discards the whole IOB figure, however
  // correct the number inside `pump.iob` is. Measured: Nightscout reported
  // `iob_u: null` for a devicestatus row carrying `pump.iob.bolusiob: 0`.
  const mills = deviceUpdateAt;

  // A stable 24-hex `_id`, because without one Nightscout appends on every poll.
  //
  // `lib/server/devicestatus.js` (v15.0.9) only skips a record whose `_id` is a
  // 24-hex string (lines 57-59, 75); with no `_id` at all it runs `insertMany`
  // every POST. The bridge's in-memory recency filter hides this during a run,
  // but it persists nothing, so every restart re-inserts too — unbounded growth
  // at ~288 docs/day on a 5-minute poll.
  //
  // The value is the device-update time snapped to the poll's own minute, so
  // re-sending the same payload in the same minute updates rather than appends,
  // while a genuine new fetch a minute later is a genuinely new record. That is
  // also why this is derived from the payload clock rather than `Date.now()`:
  // the latter would mint a new id on every re-send and defeat the purpose.
  const statusId = deviceStatusId(deviceUpdateAt);

  if (family === 'GUARDIAN') {
    return {
      _id: statusId,
      created_at: timestampAsString(deviceUpdateAt),
      mills,
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
    _id: statusId,
    created_at: timestampAsString(deviceUpdateAt),
    mills,
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
      // Nightscout renders `256U` on its own, which sat next to an unlabelled
      // battery percentage as two numbers with no way to tell which was which.
      // Name both quantities by their units instead. Only the DISPLAY is
      // overridden — `reservoir` and `reservoirPercent` above still carry the
      // raw values for anything that computes from them.
      ...(() => {
        const units = reservoirUnits(data);
        if (units === undefined) return {};
        const rounded = Math.round(units);
        return {
          reservoir_display_override:
            pct !== undefined
              ? `${rounded}U · ${pct}%`
              : `${rounded}U`,
        };
      })(),
      iob: (() => {
        const amount = data.activeInsulin?.amount;
        // `iob` AND `bolusiob`, deliberately both.
        //
        // Nightscout's plugin does `iobPump.iob || iobPump.bolusiob`. With only
        // `bolusiob: 0` that expression is `undefined || 0`, which is 0 and
        // fine — but a genuine 0 must not be mistaken for "absent", and more
        // importantly the MM Connect convention is `iob`, so emitting only the
        // alias relies on the fallback working. Write the value to both keys:
        // `0 || 0` is 0, and any consumer reading either name gets the truth.
        const value = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
          ? amount
          : undefined;
        return {
          timestamp: timestampAsString(deviceUpdateAt),
          ...(value !== undefined ? { iob: value, bolusiob: value } : {}),
        };
      })(),
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
      // The delivery-status field Nightscout's pump plugin actually renders
      // (lib/plugins/pump.js:284-293). Two independent sources say "not
      // delivering": the pump reporting a user suspend, and SmartGuard's own
      // suspend. Either is enough.
      //
      // `bolusing` is deliberately NOT emitted. The payload has no trustworthy
      // "a bolus is running right now" field — `activeInsulin` is a decayed
      // total, not a delivery flag — and inventing one would put a fabricated
      // state on the pump pill.
      ...(suspendStatus(data, autoMode) ?? {}),
      /**
       * Rows for the pump pill's info panel.
       *
       * Nightscout's pump plugin renders every key/value here as a labelled
       * row when the pill is opened (`lib/plugins/pump.js`, the `extended`
       * branch). It has no native slot for any of the 780G-specific facts
       * below, so without this they are visible only in the raw API — which is
       * not "in Nightscout" in any sense Jack can use.
       *
       * Kept to facts that CHANGE a decision, and flat strings: a nested object
       * renders as `[object Object]`.
       */
      extended: (() => {
        const rows: Record<string, string | number> = {};
        const info = data.medicalDeviceInformation;

        // The recall check, on screen. FDA Class 2 Z-2698-2026 covers 6.62
        // paired with the Instinct sensor; 6.63 is the fix.
        if (info?.softwareRevision) rows['Pump software'] = String(info.softwareRevision);
        if (info?.modelNumber) rows['Pump model'] = String(info.modelNumber);

        // What basal is actually programmed. The BASAL pill shows the
        // Nightscout PROFILE's rate, which is a different number and was
        // 2.08 against the pump's 1.2 until 2026-11-27.
        const rate = data.basal?.basalRate;
        if (typeof rate === 'number' && Number.isFinite(rate)) {
          rows['Pump basal'] = `${rate} U/hr (${data.basal?.activeBasalPattern ?? 'profile'})`;
        }

        // SmartGuard. `FEATURE_OFF` until Monday, then AUTO_BASAL.
        const shield = autoMode?.shieldState;
        if (shield) rows['SmartGuard'] = String(shield);
        if (autoMode?.plgmState) rows['Low suspend'] = String(autoMode.plgmState);

        // Reservoir as the pump's own percent — the units figure is on the pill
        // already; the percent is what the 780G actually reports.
        const level = data.reservoirLevelPercent;
        if (typeof level === 'number') rows['Reservoir level'] = `${level}%`;

        // Sensor age and calibration, in the units clinicians read.
        const sensorH = sensorHours(data.sensorDurationHours, data.sensorDurationMinutes);
        if (sensorH !== undefined) rows['Sensor age'] = `${Math.round(sensorH)} h`;
        const calibH = sensorHours(data.timeToNextCalibHours, data.timeToNextCalibrationMinutes);
        if (calibH !== undefined) rows['Next calibration'] = `${Math.round(calibH)} h`;

        if (data.conduitBatteryStatus) rows['Phone link'] = String(data.conduitBatteryStatus);
        if (data.sensorState && data.sensorState !== 'NO_ERROR_MESSAGE') {
          rows['Sensor state'] = String(data.sensorState);
        }
        if (data.systemStatusMessage && data.systemStatusMessage !== 'NO_ERROR_MESSAGE') {
          rows['Pump message'] = String(data.systemStatusMessage);
        }

        return rows;
      })(),
    },
    /**
     * Pump identity and the settings that qualify the numbers above.
     *
     * Everything here is on the wire and was previously discarded. Two fields
     * are load-bearing rather than decorative:
     *
     *  - `softwareRevision` answers the FDA Class 2 recall check (Z-2698-2026:
     *    6.62 + Instinct stops delivery). The pump in use reports 6.63V, so
     *    the fix is present — a fact nothing else in Nightscout records.
     *  - `basalRate` is the only record of what basal was running. In MANUAL
     *    mode it IS the delivered rate; under SmartGuard the algorithm sets
     *    delivery and this is the underlying profile, which is why it is
     *    nested under `pump.basal` rather than presented as `pump.basal` at
     *    top level where it would read as an enacted rate.
     *
     * Emitted only when the payload carries something: a CGM-only account must
     * not gain a phantom pump block, same rule as `autoMode`.
     */
    ...(() => {
      const info = data.medicalDeviceInformation;
      const basal = data.basal;
      const hardware: Record<string, unknown> = {};
      if (info?.manufacturer !== undefined) hardware.manufacturer = info.manufacturer;
      if (info?.modelNumber !== undefined) hardware.model = info.modelNumber;
      if (info?.hardwareRevision !== undefined) hardware.hardwareRevision = info.hardwareRevision;
      if (info?.firmwareRevision !== undefined) hardware.firmwareRevision = info.firmwareRevision;
      if (info?.softwareRevision !== undefined) hardware.softwareRevision = info.softwareRevision;

      const basalBlock: Record<string, unknown> = {};
      if (basal?.activeBasalPattern !== undefined) basalBlock.pattern = basal.activeBasalPattern;
      if (typeof basal?.basalRate === 'number' && Number.isFinite(basal.basalRate)) {
        basalBlock.rate = basal.basalRate;
        // U/hr is the pump's unit; state it so a consumer cannot read the
        // number as a daily total.
        basalBlock.units = 'U/hr';
      }

      const limits: Record<string, unknown> = {};
      if (typeof data.maxAutoBasalRate === 'number') limits.maxBasalRate = data.maxAutoBasalRate;
      if (typeof data.maxBolusAmount === 'number') limits.maxBolus = data.maxBolusAmount;

      const block: Record<string, unknown> = {};
      if (Object.keys(hardware).length) block.hardware = hardware;
      if (Object.keys(basalBlock).length) block.basal = basalBlock;
      if (Object.keys(limits).length) block.limits = limits;
      if (data.systemStatusMessage !== undefined) block.statusMessage = data.systemStatusMessage;
      return Object.keys(block).length ? { carelink: block } : {};
    })(),
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

  // Date markers from the pump's own `dateTime` string, NOT from the slot index.
  //
  // The slot index is measured against a different clock than the anchor
  // (`lastMedicalDeviceDataUpdateServerTime`), so the derived time slides between
  // fetches — measured 166 s of drift on an unchanged meal marker across two
  // polls 2 h 40 m apart, and the quantised value flipped between :15, :20 and
  // :25 on the hour. `treatmentId()` hashes that time, so each poll minted a new
  // `_id` and Nightscout appended a duplicate. Measured consequence: **three**
  // rows for the 34 g meal and **three** for the 12 g, so COB read 15.1 g on a
  // dashboard where the pump reported 46 g of carbs absorbed hours earlier.
  //
  // `dateTime` did not move at all across the same polls, and it is the pump's
  // own statement of when the event happened.
  //
  // The fallback still has to be deterministic, so it uses the QUANTISED anchor
  // — the same value `emit()` passes as `alignedAnchor`, and the same one
  // `quantiseAnchor` exists to pin. Passing the raw anchor here re-introduced
  // the sub-slot jitter that function was written to remove, which the
  // idempotence test caught immediately.
  const alignedMarkerAnchor = quantiseAnchor(markerAnchor);

  const resolveMarkerTime = (marker: { dateTime?: string; index?: number }):
    number | null => {
    if (typeof marker.dateTime === 'string' && marker.dateTime.trim() !== '') {
      // A marker `dateTime` is a FULL ISO string carrying its own offset
      // (`2026-11-27T12:23:03.000-00:00`), so it needs no pump clock to
      // resolve. `parsePumpTime` subtracts `offsetMilliseconds`, and that value
      // is NaN whenever the payload has no `sMedicalDeviceTime` — which made
      // the whole branch fall through to the unstable slot path exactly when
      // the payload was least complete. Use the string directly when there is
      // no offset to apply.
      const parsed = Number.isFinite(offsetMilliseconds)
        ? parsePumpTime(marker.dateTime, '', offsetMilliseconds)
        : Date.parse(marker.dateTime);
      if (Number.isFinite(parsed)) {
        // Allow a couple of minutes of pump/server skew before calling it
        // future-dated; a genuinely future marker is the defect corrected for
        // elsewhere and must not be emitted.
        if (parsed <= markerAnchor + 2 * 60_000) return parsed;
        logger.warn(
          'Dropping future-dated marker: ' + marker.dateTime + ' is after the payload anchor',
        );
        return null;
      }
    }
    return markerTimeOrOffset(marker, alignedMarkerAnchor);
  };

  const markers = mapMarkers(data.markers, markerAnchor, resolveMarkerTime);
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
