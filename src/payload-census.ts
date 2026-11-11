import type { CareLinkData } from './types/carelink.js';

/**
 * A census of what a real CareLink payload actually carried.
 *
 * WHY THIS EXISTS. The bridge has never talked to a real 780G. Every payload
 * shape it handles is derived from community reverse-engineering and Medtronic's
 * own configuration documents, never from an observed response. On validation
 * day the operator has one chance to write down what arrived before the session
 * gets busy, and reading a raw payload out of journald by eye is how that gets
 * done badly.
 *
 * The research corpus (`carelink-api-research` area DP) recovered the pump-data
 * schema from the vendor's own client parser, but it could not establish two
 * things: whether a given pump POPULATES those fields, and what the 19 alarm
 * name keys read as text. Both are answered by one fetch — if something writes
 * the answer down.
 *
 * So this emits a single line per distinct shape, listing:
 *
 *   - which pump-data fields are PRESENT (by name, never by value — several are
 *     personal: reservoir, IOB, glucose)
 *   - the enum VALUES for the two state machines, and whether each is inside the
 *     vocabulary the corpus recorded
 *   - the alarm CODE and whether it is one the vendor's own table normalises,
 *     and whether it is one the client suppresses outright
 *   - how many markers arrived, and the MULTISET of their types with counts
 *
 * DESIGN RULES, each of which is a decision rather than an accident:
 *
 * 1. **Never log a value that could be personal.** Glucose, carbs, insulin
 *    amounts, reservoir units, IOB, serial numbers and dates are all excluded.
 *    Only counts, presence and enum tokens reach the log. A validation-day log
 *    gets pasted into a public issue.
 * 2. **Unknown is a result, not an error.** A field the corpus predicted but
 *    which did not arrive is exactly as informative as one that did, and the
 *    census says which.
 * 3. **Emit once per distinct shape.** The identity line already dedups; this
 *    follows the same pattern so a 5-minute poll loop does not flood journald.
 */

/** Fields area DP recovered from the vendor's client parser (chunk 6746). */
const PUMP_DATA_FIELDS = [
  'therapyAlgorithmState',
  'autoModeShieldState',
  'plgmLgsState',
  'lastAlarm',
  'activeInsulin',
  'reservoirRemainingUnits',
  'reservoirAmount',
  'reservoirLevelPercent',
  'medicalDeviceBatteryLevelPercent',
  'conduitBatteryLevel',
  'conduitInRange',
  'sensorState',
  'calibStatus',
  'sensorDurationHours',
  'timeToNextCalibHours',
  'markers',
  'lastSGTrend',
  'sgs',
  'bgUnits',
  'systemStatusMessage',
  'medicalDeviceSuspended',
  'pumpModelNumber',
  'medicalDeviceFamily',
  'deviceFamily',
] as const;

/**
 * The two `therapyAlgorithmState` vocabularies, as recorded from the vendor's
 * own client (`AUTO_BASAL`, `SAFE_BASAL`, `FEATURE_OFF` and the five PLGM/LGS
 * tokens). A value outside these sets is not an error — it is the finding.
 */
export const SHIELD_STATES = ['AUTO_BASAL', 'SAFE_BASAL', 'FEATURE_OFF'] as const;
export const PLGM_STATES = [
  'FEATURE_OFF',
  'REFRACTORY_PERIOD',
  'MONITORING',
  'SUSPEND_FIRED_PLGM',
  'SUSPEND_FIRED_LGS',
] as const;

/**
 * The marker types the vendor's own client declares. `AUTO_BASAL_DELIVERY` and
 * `AUTO_MODE_STATUS` are declared but never handled — so their arrival is worth
 * knowing about precisely because nobody knows what they carry.
 */
export const MARKER_TYPES = [
  'CALIBRATION',
  'AUTO_BASAL_DELIVERY',
  'AUTO_MODE_STATUS',
  'TIME_CHANGE',
  'BG_READING',
  'BG',
  'INSULIN',
  'MEAL',
  'LOW_GLUCOSE_SUSPENDED',
  'EXERCISE',
  'OTHER',
] as const;

/**
 * Alarm codes the vendor's own client suppresses outright, at byte 87622 of
 * chunk 6746: `["00-1","121"]` returns before any name lookup, so these produce
 * no alarm name at all.
 */
export const SUPPRESSED_ALARM_CODES = ['00-1', '121'] as const;
/** Codes forced to `lastAlarmNameKey = null`, at byte 88057. */
export const NULL_NAME_ALARM_CODES = [
  '0', '070', '071', '072', '108', '114', '786', '787', '788', '799', '806',
  '825', '828',
] as const;

/** How many source codes the vendor's normalisation table maps. */
export const ALARM_CODE_TABLE_SIZE = 73;
export const ALARM_NAME_KEYS = 19;

export interface PayloadCensus {
  /** Pump-data fields present in this payload, sorted. */
  present: string[];
  /** Pump-data fields the corpus predicted which did NOT arrive, sorted. */
  absent: string[];
  /** Auto-mode state, if the object arrived. Values are enum tokens, not PII. */
  autoMode?: { shieldState: string; shieldKnown: boolean; plgmState: string; plgmKnown: boolean };
  /** Alarm code plus whether it is table-known / suppressed. Never the info text. */
  alarm?: { code: string; suppressed: boolean; nullNamed: boolean };
  /** Marker count and the multiset of types present. */
  markers?: { count: number; types: Record<string, number>; unknownTypes: string[] };
  /** Which SGV/trend/unit tokens arrived, so a transform mismatch is visible. */
  readings?: { sgvCount: number; hasTrend: boolean; bgUnits?: string };
}

function present(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return v !== undefined && v !== null && v !== '';
}

/**
 * Build the census for one payload.
 *
 * Pure and exported so it can be tested without a logger or a network call.
 */
export function payloadCensus(data: CareLinkData | undefined): PayloadCensus {
  const raw = (data ?? {}) as Record<string, unknown>;
  const out: PayloadCensus = { present: [], absent: [] };

  for (const key of PUMP_DATA_FIELDS) {
    // `autoModeShieldState` / `plgmLgsState` are NESTED under
    // therapyAlgorithmState, so top-level absence is expected and not a finding.
    const nested = key === 'autoModeShieldState' || key === 'plgmLgsState';
    if (nested) continue;
    (present(raw, key) ? out.present : out.absent).push(key);
  }

  const therapy = raw['therapyAlgorithmState'] as Record<string, unknown> | undefined;
  if (therapy && typeof therapy === 'object') {
    const shield = String(therapy['autoModeShieldState'] ?? '');
    const plgm = String(therapy['plgmLgsState'] ?? '');
    out.autoMode = {
      shieldState: shield,
      shieldKnown: (SHIELD_STATES as readonly string[]).includes(shield),
      plgmState: plgm,
      // An unrecorded token is the finding this census exists to catch.
      plgmKnown: (PLGM_STATES as readonly string[]).includes(plgm),
    };
  }

  const alarm = raw['lastAlarm'] as Record<string, unknown> | undefined;
  if (alarm && typeof alarm === 'object') {
    const rawCode = alarm['code'];
    const code = rawCode === undefined || rawCode === null ? '' : String(rawCode);
    out.alarm = {
      code,
      suppressed: (SUPPRESSED_ALARM_CODES as readonly string[]).includes(code),
      nullNamed: (NULL_NAME_ALARM_CODES as readonly string[]).includes(code),
    };
  }

  const markers = raw['markers'];
  if (Array.isArray(markers)) {
    const types: Record<string, number> = {};
    for (const m of markers) {
      const t = m && typeof m === 'object' ? String((m as Record<string, unknown>)['type'] ?? '') : '';
      if (!t) continue;
      types[t] = (types[t] ?? 0) + 1;
    }
    out.markers = {
      count: markers.length,
      types,
      unknownTypes: Object.keys(types)
        .filter((t) => !(MARKER_TYPES as readonly string[]).includes(t))
        .sort(),
    };
  }

  const sgs = raw['sgs'];
  if (Array.isArray(sgs)) {
    out.readings = {
      sgvCount: sgs.length,
      hasTrend: present(raw, 'lastSGTrend'),
      bgUnits: typeof raw['bgUnits'] === 'string' ? (raw['bgUnits'] as string) : undefined,
    };
  }

  out.present.sort();
  out.absent.sort();
  return out;
}

let lastCensusSignature: string | undefined;

/**
 * Log the census at most once per distinct shape.
 *
 * Follows `logDeviceIdentity`'s pattern deliberately: a 5-minute poll loop must
 * not emit 288 identical lines a day, and a validation-day log is only useful if
 * the lines in it are new information.
 *
 * The signature excludes SGV count and marker count, because those change on
 * every fetch by design — including them would defeat the dedup entirely. What
 * is deduped on is the SHAPE: which fields arrived, which state tokens, which
 * marker types.
 */
export function logPayloadCensus(
  endpoint: string,
  data: CareLinkData | undefined,
  log: (msg: string) => void,
): void {
  const census = payloadCensus(data);
  const shape = {
    present: census.present,
    absent: census.absent,
    autoMode: census.autoMode,
    alarm: census.alarm
      ? { suppressed: census.alarm.suppressed, nullNamed: census.alarm.nullNamed }
      : undefined,
    markerTypes: census.markers ? Object.keys(census.markers.types).sort() : undefined,
    unknownMarkerTypes: census.markers?.unknownTypes,
    bgUnits: census.readings?.bgUnits,
    hasTrend: census.readings?.hasTrend,
  };
  const signature = `${endpoint}|${JSON.stringify(shape)}`;
  if (signature === lastCensusSignature) return;
  lastCensusSignature = signature;

  log(`Payload census (${endpoint}): ${JSON.stringify({ ...shape, counts: {
    sgv: census.readings?.sgvCount ?? 0,
    markers: census.markers?.count ?? 0,
  } })}`);
}

/** Test seam: forget the dedup signature. */
export function resetPayloadCensusDedup(): void {
  lastCensusSignature = undefined;
}
