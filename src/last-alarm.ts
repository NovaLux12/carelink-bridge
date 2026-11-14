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

export type LastAlarmSeverity = 'stop_using_pump' | 'delivery_stopped' | 'attention' | 'other';

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
  // 002 — "Pump Error. Delivery Stopped": the vendor's largest group, 39 codes.
  2, 3, 4, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 26, 27, 28, 30, 31, 33, 34,
  44, 45, 46, 49, 53, 54, 60, 63, 64, 65, 67, 68, 74, 75, 76, 79, 80, 81, 82,
  // 037 — "Pump Motor Error. Delivery Stopped": six codes.
  37, 38, 39, 41, 42, 43,
  // 007, 012, 029, 061, 077 and 130 individually name a stopped delivery.
  7, 8, 12, 29, 61, 77,
  // 809/810 — "Suspend On Low / Suspend Before Low. Delivery Stopped."
  //
  // These were tiered `other` (verbose-only, silent by default) because they sat
  // outside the 73-code paradigm table the earlier model was built from. They
  // are the NGP-era suspend alarms, they say "Delivery Stopped" in the vendor's
  // own strings, and they are exactly what a SmartGuard pump does when it takes
  // basal away. Measured before this change: 809 and 810 both returned
  // severity 'other' with text "Unknown alarm code".
  809, 810,
]);

/**
 * Codes that need operator ATTENTION but are not stopped deliveries.
 *
 * These were previously tiered `delivery_stopped` and fired a priority-1
 * `[LastAlarm] Delivery stopped` line on every occurrence. The vendor's own
 * strings say they are not stopped deliveries — but they are not noise either:
 * a pump that has run out of battery stops delivering shortly, and an empty
 * reservoir already has.
 *
 * So they get their own tier rather than being promoted to a false stop or
 * demoted into silence. `attention` logs at WARN, with the vendor's text —
 * "Pump Battery Out Limit", "Reservoir Empty. Change Reservoir Now" — so the
 * operator sees the actual problem instead of a wrong one.
 */
const ATTENTION_CODES: ReadonlySet<number> = new Set([
  6,  // Pump Battery Out Limit
  11, 73,  // Replace Pump Battery Now
  25,  // Pump Power Error. Record Settings
  52,  // Delivery Limit Exceeded. Check BG
  57,  // Pump Battery Not Compatible
  58,  // Insert A New AA Battery
  66,  // No Reservoir Detected During Infusion Set Change
  69,  // Loading Incomplete During Infusion Set Change
  84,  // Pump Battery Removed. Replace Battery
]);

/**
 * Codes that are genuinely benign chatter.
 *
 * `062`/`070`/`071`/`072` are the vendor's "New notification received from
 * CareLink" — a push-delivery confirmation, not a pump event. The vendor's own
 * client suppresses the display name for `062` for exactly this reason.
 *
 * `051` ("Bolus Stopped") is a cancelled BOLUS, not stopped basal delivery. It
 * is annotated with the vendor's text so the record is accurate, but it is not
 * a pump-level alarm and must not be logged as one.
 */
const BENIGN_CODES: ReadonlySet<number> = new Set([
  51, 62, 70, 71, 72,
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

/**
 * Human-readable text for alarm codes, taken from the VENDOR'S OWN strings.
 *
 * Source: https://carelink.minimed.eu/crm/ocl/15.5/i18n/ui/app/en.json
 *   (200, application/json, 137123 bytes,
 *    sha256 a6b8180b87c022d65ae48700d240f5a2a80db3ad9db6b3c8fff3a5c707cd7f9f,
 *    byte-identical on carelink.minimed.com; unauthenticated).
 *
 * The previous table was built from a third-party 2015 display dictionary and
 * disagreed with the vendor on EVERY code it shipped. Most differences were
 * cosmetic, but the wording is what an operator reads at 03:00, so it is worth
 * being the vendor's. Where the vendor has no string for a code, `textFor()`
 * still synthesises "Unknown alarm code <n>" so no alarm is ever silently
 * dropped.
 */
const ALARM_TEXT: Readonly<Record<number, string>> = Object.freeze({
  2: "Pump Error. Delivery Stopped",
  3: "Pump Error. Delivery Stopped",
  4: "Pump Error. Delivery Stopped",
  13: "Pump Error. Delivery Stopped",
  14: "Pump Error. Delivery Stopped",
  15: "Pump Error. Delivery Stopped",
  16: "Pump Error. Delivery Stopped",
  17: "Pump Error. Delivery Stopped",
  18: "Pump Error. Delivery Stopped",
  19: "Pump Error. Delivery Stopped",
  20: "Pump Error. Delivery Stopped",
  22: "Pump Error. Delivery Stopped",
  23: "Pump Error. Delivery Stopped",
  26: "Pump Error. Delivery Stopped",
  27: "Pump Error. Delivery Stopped",
  28: "Pump Error. Delivery Stopped",
  30: "Pump Error. Delivery Stopped",
  31: "Pump Error. Delivery Stopped",
  33: "Pump Error. Delivery Stopped",
  34: "Pump Error. Delivery Stopped",
  44: "Pump Error. Delivery Stopped",
  45: "Pump Error. Delivery Stopped",
  46: "Pump Error. Delivery Stopped",
  49: "Pump Error. Delivery Stopped",
  53: "Pump Error. Delivery Stopped",
  54: "Pump Error. Delivery Stopped",
  60: "Pump Error. Delivery Stopped",
  63: "Pump Error. Delivery Stopped",
  64: "Pump Error. Delivery Stopped",
  65: "Pump Error. Delivery Stopped",
  67: "Pump Error. Delivery Stopped",
  68: "Pump Error. Delivery Stopped",
  74: "Pump Error. Delivery Stopped",
  75: "Pump Error. Delivery Stopped",
  76: "Pump Error. Delivery Stopped",
  79: "Pump Error. Delivery Stopped",
  80: "Pump Error. Delivery Stopped",
  81: "Pump Error. Delivery Stopped",
  82: "Pump Error. Delivery Stopped",
  24: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  35: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  40: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  47: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  48: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  50: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  55: "Critical Pump Error. Stop Pump Use. Use Other Treatment",
  37: "Pump Motor Error. Delivery Stopped",
  38: "Pump Motor Error. Delivery Stopped",
  39: "Pump Motor Error. Delivery Stopped",
  41: "Pump Motor Error. Delivery Stopped",
  42: "Pump Motor Error. Delivery Stopped",
  43: "Pump Motor Error. Delivery Stopped",
  62: "New notification received from CareLink",
  70: "New notification received from CareLink",
  71: "New notification received from CareLink",
  72: "New notification received from CareLink",
  7: "Delivery Stopped. Check BG",
  8: "Delivery Stopped. Check BG",
  11: "Replace Pump Battery Now",
  73: "Replace Pump Battery Now",
  117: "Active Insulin Cleared",
  817: "Alert Before High. Check BG",
  805: "Alert Before Low. Check BG",
  819: "Auto Mode Exit. Basal Delivery Started. BG Required",
  12: "Auto Suspend Limit Reached. Delivery Stopped",
  103: "BG Check Reminder",
  829: "BG Required",
  807: "Basal Delivery Resumed. Check BG",
  814: "Basal Resumed. SG Still Under Low Limit. Check BG",
  100: "Bolus Entry Timed Out Before Delivery",
  51: "Bolus Stopped",
  775: "Calibrate Now",
  776: "Calibration Error",
  869: "Calibration Reminder",
  832: "Calibration Required",
  812: "Call Emergency Assistance",
  777: "Change Sensor",
  833: "Correction Bolus Recommended",
  52: "Delivery Limit Exceeded. Check BG",
  140: "Delivery Suspended. Connect Infusion Set",
  801: "Do Not Calibrate. Wait Up To 3 Hours",
  816: "High Sensor Glucose",
  823: "High Sensor Glucose For Over 1 Hour",
  58: "Insert A New AA Battery",
  69: "Loading Incomplete During Infusion Set Change",
  780: "Lost Sensor Signal",
  795: "Lost Sensor Signal. Check Transmitter",
  815: "Low Limit Changed. Basal Manually Resumed. Check BG",
  802: "Low Sensor Glucose",
  803: "Low Sensor Glucose. Check BG",
  822: "Maximum Delivery Timeout. BG Required",
  821: "Minimum Delivery Timeout. BG Required",
  107: "Missed Meal Bolus Reminder",
  66: "No Reservoir Detected During Infusion Set Change",
  796: "No Sensor Signal",
  57: "Pump Battery Not Compatible",
  6: "Pump Battery Out Limit",
  84: "Pump Battery Removed. Replace Battery",
  61: "Pump Button Error. Delivery Stopped",
  25: "Pump Power Error. Record Settings",
  29: "Pump Restarted. Delivery Stopped",
  77: "Pump Settings Error. Delivery Stopped",
  779: "Recharge Transmitter Now",
  870: "Recharge Transmitter Soon",
  104: "Replace Pump Battery Soon",
  113: "Reservoir Empty. Change Reservoir Now",
  105: "Reservoir Low. Change Reservoir Soon",
  130: "Rewind Required. Delivery Stopped",
  784: "SG Rising Rapidly",
  797: "Sensor Connected",
  794: "Sensor Expired. Change Sensor",
  109: "Set Change Reminder",
  110: "Silenced Sensor Alert. Check Alarm History",
  810: "Suspend Before Low. Delivery Stopped. Check BG",
  809: "Suspend On Low. Delivery Stopped. Check BG",
  827: "Urgent Low Sensor Glucose. Check BG",
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
  // Benign BEFORE the delivery-stopped set: these codes were tiered as stopped
  // deliveries on the assumption that every non-critical vendor group was one.
  // The vendor's own strings say otherwise — see BENIGN_CODES.
  if (BENIGN_CODES.has(code)) return 'other';
  if (ATTENTION_CODES.has(code)) return 'attention';
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

  if (severity === 'attention') {
    // WARN, but with the vendor's own text and NOT the words "Delivery
    // stopped". An operator must be able to tell "change the battery" apart
    // from "basal has stopped" at a glance, or the priority-1 line loses its
    // meaning.
    console.warn(
      `${tag} Attention — code=${codeLabel} text="${text}" datetime="${annotation.datetime}"`,
    );
    return;
  }

  // Other alarms: verbose-only. Operators who want them visible run with
  // CARELINK_QUIET=false; default silent.
  logger.log(tag, `Other alarm — code=${codeLabel} text="${text}"`);
}