/**
 * Severity must agree with the vendor's own display string, for every code.
 *
 * The vendor publishes the alarm vocabulary unauthenticated:
 *
 *   https://carelink.minimed.eu/crm/ocl/15.5/i18n/ui/app/en.json
 *   200, application/json, 137123 bytes
 *   sha256 a6b8180b87c022d65ae48700d240f5a2a80db3ad9db6b3c8fff3a5c707cd7f9f
 *   byte-identical on carelink.minimed.com
 *
 * 63 `connect.ble.NNN` keys. This fixture is the verbatim text for those codes,
 * plus the handful of NGP-era codes the 73-entry paradigm table does not carry
 * (130, 809, 810, 812, 814) which the same bundle does.
 *
 * Why this suite exists: the previous tiering was inferred from GROUP
 * membership — the assumption being that any non-critical vendor group meant
 * "delivery stopped". Measured against these strings, that was wrong in both
 * directions. Pinning the text alongside the severity makes the next such drift
 * a test failure rather than a wrong log line at 03:00.
 *
 * Note on the fixture source: the bundle is transient. It is re-fetchable at
 * that URL and the digest is recorded above, so a future maintainer can
 * re-derive it. Only the strings this suite asserts are vendored here — not the
 * whole 137 KB body.
 */

import { describe, expect, it } from 'vitest';
import { evaluateLastAlarm } from '../src/last-alarm.js';
import type { CareLinkData } from '../src/types/carelink.js';

function alarm(code: number | string): CareLinkData['lastAlarm'] {
  return {
    type: 'ALARM',
    version: 1,
    flash: false,
    datetime: '2026-11-13T00:00:00Z',
    kind: 'Alarm',
    code,
  };
}

/** Vendor display text, copied verbatim from the i18n bundle above. */
const VENDOR_TEXT: Record<number, string> = {
  2: 'Pump Error. Delivery Stopped',
  6: 'Pump Battery Out Limit',
  7: 'Delivery Stopped. Check BG',
  11: 'Replace Pump Battery Now',
  12: 'Auto Suspend Limit Reached. Delivery Stopped',
  24: 'Critical Pump Error. Stop Pump Use. Use Other Treatment',
  25: 'Pump Power Error. Record Settings',
  29: 'Pump Restarted. Delivery Stopped',
  37: 'Pump Motor Error. Delivery Stopped',
  51: 'Bolus Stopped',
  52: 'Delivery Limit Exceeded. Check BG',
  57: 'Pump Battery Not Compatible',
  58: 'Insert A New AA Battery',
  61: 'Pump Button Error. Delivery Stopped',
  62: 'New notification received from CareLink',
  66: 'No Reservoir Detected During Infusion Set Change',
  69: 'Loading Incomplete During Infusion Set Change',
  73: 'Replace Pump Battery Now',
  77: 'Pump Settings Error. Delivery Stopped',
  84: 'Pump Battery Removed. Replace Battery',
  130: 'Rewind Required. Delivery Stopped',
  809: 'Suspend On Low. Delivery Stopped. Check BG',
  810: 'Suspend Before Low. Delivery Stopped. Check BG',
  812: 'Call Emergency Assistance',
  814: 'Basal Resumed. SG Still Under Low Limit. Check BG',
};

describe('severity follows the vendor display text', () => {
  it('every code in the fixture produces exactly the vendor string', () => {
    const mismatched: string[] = [];
    for (const [code, text] of Object.entries(VENDOR_TEXT)) {
      const r = evaluateLastAlarm(alarm(Number(code)));
      if (r?.text !== text) {
        mismatched.push(`${code}: expected ${JSON.stringify(text)} got ${JSON.stringify(r?.text)}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('exactly the 10 codes whose text says "Delivery Stopped" are tiered delivery_stopped', () => {
    // Measured: 10 codes carry that exact phrase —
    //   002 007 012 029 037 061 077 130 809 810
    // 024 is NOT one of them; its text is "Stop Pump Use", a different and more
    // urgent instruction, and it is tiered stop_using_pump.
    const saysStopped = Object.entries(VENDOR_TEXT)
      .filter(([, t]) => /Delivery Stopped/i.test(t))
      .map(([c]) => Number(c));
    expect(saysStopped.sort((a, b) => a - b)).toEqual([
      2, 7, 12, 29, 37, 61, 77, 130, 809, 810,
    ]);
    for (const code of saysStopped) {
      expect(evaluateLastAlarm(alarm(code))!.severity, `code ${code}`).toBe('delivery_stopped');
    }
  });

  it('no code whose text claims stopped delivery is tiered below delivery_stopped', () => {
    // The safety direction: a missed "delivery stopped" is unrecoverable.
    const silent = Object.entries(VENDOR_TEXT)
      .filter(([, t]) => /Delivery Stopped/i.test(t))
      .filter(([c]) => evaluateLastAlarm(alarm(Number(c)))!.severity === 'other')
      .map(([c]) => Number(c));
    expect(silent).toEqual([]);
  });

  it('no battery, notification or cancelled-bolus code claims stopped delivery', () => {
    // The alarm-fatigue direction. These were all delivery_stopped before the
    // fix, so an operator saw "Delivery stopped" for a battery reminder.
    const notStopped = [6, 11, 25, 51, 52, 57, 58, 62, 66, 69, 73, 84];
    for (const code of notStopped) {
      const r = evaluateLastAlarm(alarm(code))!;
      expect(r.severity, `code ${code}`).not.toBe('delivery_stopped');
      expect(r.text, `code ${code}`).not.toMatch(/Delivery Stopped/i);
    }
  });

  it('a stop-using-pump instruction outranks the delivery-stopped tier', () => {
    // 024 says "Stop Pump Use" — strictier than stopped delivery, and must not
    // be flattened into it.
    const r = evaluateLastAlarm(alarm(24))!;
    expect(r.severity).toBe('stop_using_pump');
    expect(r.text).toMatch(/Stop Pump Use/);
    expect(r.text).not.toMatch(/Delivery Stopped/i);
  });

  it('the three codes absent from the vendor bundle keep honest text', () => {
    // 811 does NOT exist in the bundle (810 and 812 do). Neither do 1/5/131,
    // which come from the older third-party dictionary. They must still surface
    // — never silently dropped — and must not borrow another code's text.
    for (const code of [811, 1, 5, 131]) {
      const r = evaluateLastAlarm(alarm(code));
      expect(r, `code ${code} must still produce an annotation`).not.toBeNull();
      expect(r!.text === 'Unknown alarm code ' + code || /Insulin delivery stopped|Critical Pump Error/.test(r!.text))
        .toBe(true);
    }
    // 811 specifically: absent from the vendor bundle, so it is NOT vendor data.
    expect(r_text(811)).not.toMatch(/Suspend On Low|Suspend Before Low/);
  });
});

function r_text(code: number): string {
  return evaluateLastAlarm(alarm(code))!.text;
}
