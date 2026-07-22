/**
 * Last-alarm policy module.
 *
 * Source: research/medtronic-carelink-2026-07-21/03-data-model-and-gaps.md (P0.2).
 *
 * SAFETY CONSTRAINT: alarms with codes indicating "Critical Pump Error. Stop
 * using pump" or "Insulin delivery stopped" must NOT be auto-published to
 * Nightscout as treatments/announcements without operator review. This module
 * emits a Nightscout devicestatus.annotation ONLY. It never touches
 * `/api/v1/treatments.json`. The threshold for a console-level WARN is the
 * priority-1 subset; lower-severity alarms are INFO-only via the verbose logger.
 *
 * Code-tier model: CareLink surfaces `lastAlarm.code` as a number. Two
 * eras exist (paradigm-era integer codes 3-117; NGP-era "N"-prefixed codes
 * 1-870 from mddub a95dc120d9d1414a433d). The evidence table below only
 * populates the paradigm-era integer codes for which public evidence is
 * concrete. NGP codes that arrive as numeric wire values from the real
 * 780G payload will be added to the table on first sanitized fixture —
 * until then they synthesize "Unknown alarm code <n>" so a real alarm is
 * never silently dropped; the WARN contract only fires for codes in this
 * table.
 */

import type { CareLinkAlarm } from './types/carelink.js';
import type { NightscoutLastAlarmAnnotation } from './types/nightscout.js';
import * as logger from './logger.js';

export type LastAlarmSeverity = 'stop_using_pump' | 'delivery_stopped' | 'other';

export interface LastAlarmEvaluation {
  annotation: NightscoutLastAlarmAnnotation;
  severity: LastAlarmSeverity;
  text: string;
}

// Paradigm-era "Critical Pump Error. Stop using pump" codes per mddub
// a95dc120d9d1414a433d (paradigm + NGP, 2015-10-19). mddub's table lists
// paradigm 4/5/6/16/43/61 as "Insulin delivery stopped" — those go in the
// delivery-stopped set below. The "Stop using pump" subset was empty in
// paradigm-era; populated in NGP (see separate "Critical Pump Error" comment
// in the memo). Until a sanitized 780G fixture lands in repo, this set is
// left empty so the WARN path is provably correct: an NGP priority-1 code
// arrives as "Unknown alarm code <n>" + 'other' severity, never a false
// positive WARN, and the operator sees the synthesized text.
const STOP_USING_PUMP_CODES: ReadonlySet<number> = new Set([
  // populated on first sanitized 780G fixture
]);

// Paradigm-era "Insulin delivery stopped" codes (mddub a95dc120d9d1414a433d).
const DELIVERY_STOPPED_CODES: ReadonlySet<number> = new Set([
  4, 5, 6, 16, 43, 61,
]);

// Human-readable text for the codes we ship. Not exhaustive — for any code
// not present in this map, evaluateLastAlarm synthesizes "Unknown alarm code
// <n>" so a real alarm is never silently dropped.
const ALARM_TEXT: Readonly<Record<number, string>> = Object.freeze({
  4: 'Insulin delivery stopped',
  5: 'Insulin delivery stopped',
  6: 'Insulin delivery stopped',
  16: 'Insulin delivery stopped',
  43: 'Insulin delivery stopped',
  61: 'Insulin delivery stopped',
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
 * severity). Always returns an annotation when alarm is non-null and the code
 * is numeric — never silently drops an alarm. The caller decides whether to
 * attach the annotation to the device-status payload and whether to log.
 */
export function evaluateLastAlarm(alarm: CareLinkAlarm | undefined): LastAlarmEvaluation | null {
  if (!alarm) return null;
  const code = alarm.code;
  if (typeof code !== 'number') return null;

  const text = textFor(code);
  const severity = severityFor(code);

  return {
    annotation: {
      code,
      datetime: alarm.datetime,
      text,
      severity,
    },
    severity,
    text,
  };
}

/**
 * Side-effecting helper: emits the operator-visible log line for a CareLink
 * alarm evaluation. Priority-1 codes (stop_using_pump, delivery_stopped) go
 * to console.warn — always-visible, irrespective of verbose mode — because
 * the safety contract demands they appear in journald. Lower-severity alarms
 * are routed through the verbose logger so quiet operators don't see noise.
 *
 * NEVER publishes to /api/v1/treatments.json. The annotation is the entire
 * Nightscout surface; an operator reading Nightscout still has to look at it.
 */
export function logLastAlarm(evalResult: LastAlarmEvaluation): void {
  const { severity, text, annotation } = evalResult;
  const tag = '[LastAlarm]';

  if (severity === 'stop_using_pump') {
    console.warn(
      `${tag} STOP USING PUMP — code=${annotation.code} text="${text}" datetime="${annotation.datetime}"`,
    );
    return;
  }

  if (severity === 'delivery_stopped') {
    console.warn(
      `${tag} Delivery stopped — code=${annotation.code} text="${text}" datetime="${annotation.datetime}"`,
    );
    return;
  }

  // Other alarms: verbose-only. Operators who want them visible run with
  // CARELINK_QUIET=false; default silent.
  logger.log(tag, `Other alarm — code=${annotation.code} text="${text}"`);
}
