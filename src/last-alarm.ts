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

// NGP stop_using_pump codes (mddub a95dc120d9d1414a433d, 2015-10-19
// paradigm + NGP errorStrings table). The display dictionary keys these as
// "N"-prefixed strings; after normaliseAlarmCode() they are looked up as
// numbers. Populated in lieu of a sanitised 780G fixture, against the same
// source already cited for the paradigm-era sets. Worst-case outcome of a
// wrong entry: a priority-1 alarm surfaces as "other" severity with a
// "Unknown alarm code N<n>" text — still no silent drop, still visible in
// the Nightscout annotation, just de-escalated from console.warn to INFO.
const STOP_USING_PUMP_CODES: ReadonlySet<number> = new Set([
  24, 35, 40, 47, 48, 50, 55, 131,
]);

// NGP delivery_stopped codes (same source). Includes the paradigm-era
// codes (4, 5, 6, 16, 43, 61) plus NGP-era additions.
const DELIVERY_STOPPED_CODES: ReadonlySet<number> = new Set([
  4, 5, 6, 16, 43, 61,
  1, 22, 25, 33, 42, 63, 67, 76, 77, 130,
]);

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
});

function textFor(code: number): string {
  return ALARM_TEXT[code] ?? 'Unknown alarm code ' + code;
}

function severityFor(code: number): LastAlarmSeverity {
  if (STOP_USING_PUMP_CODES.has(code)) return 'stop_using_pump';
  if (DELIVERY_STOPPED_CODES.has(code)) return 'delivery_stopped';
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