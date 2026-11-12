/**
 * Last-alarm policy module.
 *
 * Source: https://github.com/NovaLux2/carelink-api-research/blob/main/findings-log/medtronic-carelink-2026-07-21/03-data-model-and-gaps.md (P0.2).
 *
 * SAFETY CONSTRAINT: alarms with codes indicating "Critical Pump Error. Stop
 * using pump" or "Insulin delivery stopped" must NOT be auto-published to
 * Nightscout as treatments/announcements without operator review. This module
 * emits a Nightscout devicestatus.annotation ONLY. It never touches
 * `/api/v1/treatments.json`. The threshold for a console-level WARN is the
 * priority-1 subset; lower-severity alarms are INFO-only via the verbose logger.
 *
 * Code-tier model: CareLink surfaces `lastAlarm.code` in two wire forms
 * depending on the pump era / deployment:
 *
 *   - Numeric (paradigm-era, most older NGP payloads): `4`, `5`, `16`, `43`…
 *   - NGP "N"-prefixed string (mddub a95dc120d9d1414a433d): `"N24"`, `"N131"`…
 *
 * The exact wire form that 780G pumps send is UNVERIFIED on the live API
 * (issue #84 — the unauthenticated search is exhausted; a real token is the
 * only way to settle it). Both forms are accepted here so neither silently
 * drops. Normalisation preserves the original string for operator-visible
 * logging — an "N24" stays "N24" in journald, while the lookup keys remain
 * the canonical numeric form (24). Numeric input is unchanged.
 */

import type { CareLinkAlarm } from './types/carelink.js';
import type { NightscoutLastAlarmAnnotation } from './types/nightscout.js';
import * as logger from './logger.js';

export type LastAlarmSeverity = 'stop_using_pump' | 'delivery_stopped' | 'other';

export interface LastAlarmEvaluation {
  annotation: NightscoutLastAlarmAnnotation;
  severity: LastAlarmSeverity;
  text: string;
  /**
   * Original wire form, when the alarm arrived as a string (NGP "N24"). Used
   * by `logLastAlarm` so operators see exactly what the pump sent, while the
   * Nightscout annotation's `code` field stays a canonical number for
   * downstream consumers.
   */
  wireCode?: string;
}

/**
 * Normalise the alarm's wire-form code to a numeric key for the lookup
 * tables. Accepts:
 *
 *   - finite numbers: returned as-is
 *   - "N<digits>" / "n<digits>" (NGP string form): the digits are returned
 *     as a number; the original is preserved separately by the caller.
 *   - plain numeric strings "<digits>": parsed as a number — lenient, since
 *     paradigm codes may arrive stringified in some deployments.
 *
 * Anything else (`null`, `undefined`, empty string, junk like `"four"`,
 * `NaN`, `Infinity`, malformed `"N24x"`) returns `null`, which the caller
 * maps to "no evaluation" — the same null-return the codebase already had
 * for non-numeric input.
 */

function normaliseAlarmCode(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // NGP form: "N24", "n24", "N 24" tolerated. Anchored — a malformed
    // "N24x" or trailing garbage returns null rather than a partial match.
    const ngp = /^N(\d+)$/i.exec(trimmed);
    if (ngp) {
      const n = Number(ngp[1]);
      return Number.isFinite(n) ? n : null;
    }
    // Plain numeric string: "4" → 4. Lenient, since a stringified paradigm
    // code is a real alarm, not junk. Rejects ".", negatives, fractions.
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  return null;
}

/**
 * Human-readable text for the original wire form, if it was a string.
 * Returns undefined for the numeric path — the caller falls back to the
 * numeric `ALARM_TEXT` map.
 */
function wireCode(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

// NGP stop_using_pump codes. SOURCE OF TRUTH: the vendor's own client parser,
// recovered from a hash-pinned lazy chunk (`6746.c6795ff7e9ff468d.js`) at byte
// 84,476 — a 73-entry object literal mapping every wire code to one of 19 name
// keys. Full table: carelink-api-research
// `findings-log/2026-11-11-area-dp-pump-data-plane/alarm-code-map.json`.
//
// The vendor's `024` group is exactly these seven codes. The previous revision
// of this file also carried `131`, which is NOT in the vendor table — it came
// from a third-party 2015 paradigm-era display dictionary, not from Medtronic's
// current parser. It is retained below in `LEGACY_CRITICAL_CODES` so a real "N131"
// still surfaces loudly rather than being silently reclassified, but it is no
// longer claimed to be part of the vendor's critical set.
const STOP_USING_PUMP_CODES: ReadonlySet<number> = new Set([
  24, 35, 40, 47, 48, 50, 55,
]);

// NGP delivery_stopped codes. The vendor collapses 73 wire codes into 19 name
// keys; every code NOT in the `024` group still carries a severity the vendor
// distinguishes, so the bridge must not treat them as "other".
//
// Previously this set held {4,5,6,16,43,61} + {1,22,25,33,42,63,67,76,77,130}.
// Measured against the vendor table, that was wrong in both directions:
//   - `1`, `5`, `130` do not exist in the vendor table at all (four codes were
//     invented; `131` is the fourth, handled above).
//   - `43` is in the vendor's `037` group, not a delivery-stop group.
//   - 53 of the vendor's 73 codes were not tiered at all, including the whole
//     of the largest group (`002`, 39 codes) — every one of those would have
//     been annotated "other".
// The sets below now cover all 73 vendor codes. Group names are the vendor's
// own name keys, kept verbatim so a reader can go straight to the table.
const DELIVERY_STOPPED_CODES: ReadonlySet<number> = new Set([
  // 002 — the vendor's largest group: 39 codes.
  2, 3, 4, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 26, 27, 28, 30, 31, 33, 34,
  44, 45, 46, 49, 53, 54, 60, 63, 64, 65, 67, 68, 74, 75, 76, 79, 80, 81, 82,
  // 011 — two codes. (Missed on the first pass; the coverage test caught it.)
  11, 73,
  // 037 — six codes.
  37, 38, 39, 41, 42, 43,
  // 062 — four codes.
  62, 70, 71, 72,
  // 007 — two codes.
  7, 8,
  // 006, 012, 025, 029, 051, 052, 057, 058, 061, 066, 069, 077, 084 — one each.
  6, 12, 25, 29, 51, 52, 57, 58, 61, 66, 69, 77, 84,
]);

// Codes present in the third-party paradigm-era dictionary but ABSENT from the
// vendor's current 73-entry parser. They are tiered stop_using_pump on the
// precautionary principle — a false critical is recoverable, a missed one is
// not — but they are kept separate so nobody mistakes them for vendor data.
// Only 131 was documented as "Critical Pump Error. Stop using pump"; 1, 5 and
// 130 were documented as "Insulin delivery stopped" and stay in that tier.
// Escalating them would fire a stop-using-pump banner for a recoverable alarm,
// which trains the operator to ignore the banner that matters.
const LEGACY_CRITICAL_CODES: ReadonlySet<number> = new Set([131]);
const LEGACY_DELIVERY_STOPPED_CODES: ReadonlySet<number> = new Set([1, 5, 130]);

// Human-readable text for the codes we ship. Not exhaustive — for any code
// not present in this map, evaluateLastAlarm synthesises "Unknown alarm code
// <n>" so a real alarm is never silently dropped.
const ALARM_TEXT: Readonly<Record<number, string>> = Object.freeze({
  4: 'Insulin delivery stopped',
  5: 'Insulin delivery stopped',
  6: 'Insulin delivery stopped',
  16: 'Insulin delivery stopped',
  43: 'Insulin delivery stopped',
  61: 'Insulin delivery stopped',
  // NGP stop_using_pump (mddub a95dc120d9d1414a433d): all listed as
  // "Critical Pump Error. Stop using pump" in the cited display dict.
  24: 'Critical Pump Error. Stop using pump',
  35: 'Critical Pump Error. Stop using pump',
  40: 'Critical Pump Error. Stop using pump',
  47: 'Critical Pump Error. Stop using pump',
  48: 'Critical Pump Error. Stop using pump',
  50: 'Critical Pump Error. Stop using pump',
  55: 'Critical Pump Error. Stop using pump',
  131: 'Critical Pump Error. Stop using pump',
  // NGP delivery_stopped (same source): the cited dict renders these as
  // "Pump error. Insulin delivery stopped" or "Insulin delivery stopped".
  // Grouped to a single canonical text per the existing paradigm pattern.
  1: 'Insulin delivery stopped',
  22: 'Pump error. Insulin delivery stopped',
  25: 'Pump error. Insulin delivery stopped',
  33: 'Insulin delivery stopped',
  42: 'Insulin delivery stopped',
  63: 'Insulin delivery stopped',
  67: 'Insulin delivery stopped',
  76: 'Insulin delivery stopped',
  77: 'Pump error. Insulin delivery stopped',
  130: 'Insulin delivery stopped',
  // Codes newly tiered by the vendor table. The vendor distinguishes 19 name
  // keys among its 73 codes; the bridge collapses them to the two
  // operator-facing texts above because Nightscout's annotation is a single
  // string, and splitting 19 ways would fragment the record without helping a
  // human reading it at 03:00. Every vendor code now resolves to real text, so
  // "Unknown alarm code" only fires for codes outside the vendor table.
  2: 'Insulin delivery stopped', 3: 'Insulin delivery stopped',
  7: 'Insulin delivery stopped', 8: 'Insulin delivery stopped',
  11: 'Insulin delivery stopped', 12: 'Insulin delivery stopped',
  13: 'Insulin delivery stopped', 14: 'Insulin delivery stopped',
  15: 'Insulin delivery stopped', 17: 'Insulin delivery stopped',
  18: 'Insulin delivery stopped', 19: 'Insulin delivery stopped',
  20: 'Insulin delivery stopped', 23: 'Insulin delivery stopped',
  26: 'Insulin delivery stopped', 27: 'Insulin delivery stopped',
  28: 'Insulin delivery stopped', 29: 'Insulin delivery stopped',
  30: 'Insulin delivery stopped', 31: 'Insulin delivery stopped',
  34: 'Insulin delivery stopped', 37: 'Insulin delivery stopped',
  38: 'Insulin delivery stopped', 39: 'Insulin delivery stopped',
  41: 'Insulin delivery stopped', 44: 'Insulin delivery stopped',
  45: 'Insulin delivery stopped', 46: 'Insulin delivery stopped',
  49: 'Insulin delivery stopped', 51: 'Insulin delivery stopped',
  52: 'Insulin delivery stopped', 53: 'Insulin delivery stopped',
  54: 'Insulin delivery stopped', 57: 'Insulin delivery stopped',
  58: 'Insulin delivery stopped', 60: 'Insulin delivery stopped',
  62: 'Insulin delivery stopped', 64: 'Insulin delivery stopped',
  65: 'Insulin delivery stopped', 66: 'Insulin delivery stopped',
  68: 'Insulin delivery stopped', 69: 'Insulin delivery stopped',
  70: 'Insulin delivery stopped', 71: 'Insulin delivery stopped',
  72: 'Insulin delivery stopped', 73: 'Insulin delivery stopped',
  74: 'Insulin delivery stopped', 75: 'Insulin delivery stopped',
  79: 'Insulin delivery stopped', 80: 'Insulin delivery stopped',
  81: 'Insulin delivery stopped', 82: 'Insulin delivery stopped',
  84: 'Insulin delivery stopped',
});

function textFor(code: number): string {
  return ALARM_TEXT[code] ?? 'Unknown alarm code ' + code;
}

function severityFor(code: number): LastAlarmSeverity {
  // Legacy-only codes are checked first: they are absent from the vendor table,
  // so neither set below would catch them, and they are precautionarily tiered
  // critical. A false critical is recoverable; a missed one is not.
  if (LEGACY_CRITICAL_CODES.has(code)) return 'stop_using_pump';
  if (STOP_USING_PUMP_CODES.has(code)) return 'stop_using_pump';
  if (DELIVERY_STOPPED_CODES.has(code)) return 'delivery_stopped';
  if (LEGACY_DELIVERY_STOPPED_CODES.has(code)) return 'delivery_stopped';
  return 'other';
}

/**
 * Converts a CareLinkAlarm into a Nightscout annotation pair (annotation +
 * severity). Always returns an annotation when alarm is non-null AND the
 * code normalises to a number — never silently drops an alarm. The caller
 * decides whether to attach the annotation to the device-status payload and
 * whether to log.
 *
 * Accepts both numeric (paradigm-era) and "N"-prefixed string (NGP-era)
 * codes — see module header for why. The original wire form, when it was a
 * string, is preserved on `wireCode` and surfaced by `logLastAlarm` so
 * operators see exactly what the pump sent.
 */
export function evaluateLastAlarm(alarm: CareLinkAlarm | undefined): LastAlarmEvaluation | null {
  if (!alarm) return null;
  const code = normaliseAlarmCode(alarm.code);
  if (code === null) return null;

  const text = textFor(code);
  const severity = severityFor(code);
  const wc = wireCode(alarm.code);

  return {
    annotation: {
      code,
      ...(wc ? { wireCode: wc } : {}),
      datetime: alarm.datetime,
      text,
      severity,
    },
    severity,
    text,
    ...(wc ? { wireCode: wc } : {}),
  };
}

/**
 * Side-effecting helper: emits the operator-visible log line for a CareLink
 * alarm evaluation. Priority-1 codes (stop_using_pump, delivery_stopped) go
 * to console.warn — always-visible, irrespective of verbose mode — because
 * the safety contract demands they appear in journald. Lower-severity alarms
 * are routed through the verbose logger so quiet operators don't see noise.
 *
 * The displayed `code=` value is the original wire form when available, so
 * an NGP "N24" surfaces as `code=N24` (not `code=24`). Falls back to the
 * canonical numeric form for the numeric path.
 *
 * NEVER publishes to /api/v1/treatments.json. The annotation is the entire
 * Nightscout surface; an operator reading Nightscout still has to look at it.
 */
export function logLastAlarm(evalResult: LastAlarmEvaluation): void {
  const { severity, text, annotation } = evalResult;
  const codeLabel = evalResult.wireCode ?? annotation.code;
  const tag = '[LastAlarm]';

  if (severity === 'stop_using_pump') {
    console.warn(
      `${tag} STOP USING PUMP — code=${codeLabel} text="${text}" datetime="${annotation.datetime}"`,
    );
    return;
  }

  if (severity === 'delivery_stopped') {
    console.warn(
      `${tag} Delivery stopped — code=${codeLabel} text="${text}" datetime="${annotation.datetime}"`,
    );
    return;
  }

  // Other alarms: verbose-only. Operators who want them visible run with
  // CARELINK_QUIET=false; default silent.
  logger.log(tag, `Other alarm — code=${codeLabel} text="${text}"`);
}