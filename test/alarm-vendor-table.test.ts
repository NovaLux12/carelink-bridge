/**
 * Alarm-code coverage against the VENDOR'S OWN table.
 *
 * The previous revision of `last-alarm.ts` was built from a third-party 2015
 * display dictionary. Measured against the vendor's current parser (a
 * hash-pinned lazy chunk recovered during the 2026-11-11 data-plane research),
 * that model was wrong in both directions: it invented four codes that Medtronic
 * does not emit, and it left 53 of the vendor's 73 codes untiered — including
 * the whole of the largest severity group, so those alarms would have been
 * annotated `other`.
 *
 * This suite exists so that failure cannot recur silently. It reads the vendor
 * table directly rather than restating it, so a hand-edit to either side shows
 * up as a test failure rather than a drifting comment.
 *
 * The table is committed in the research repo at:
 *   carelink-api-research/findings-log/2026-11-11-area-dp-pump-data-plane/
 *     alarm-code-map.json
 * It is vendored here as a fixture so this repo's suite is self-contained and
 * does not need the research checkout present.
 */

import { describe, expect, it } from 'vitest';
import { evaluateLastAlarm } from '../src/last-alarm.js';
import type { CareLinkData } from '../src/types/carelink.js';
import vendorTable from './fixtures/alarm-code-map.json';

/** Minimal well-formed alarm, matching the shape the wire actually sends. */
function alarm(code: number | string): CareLinkData['lastAlarm'] {
  return {
    type: 'ALARM',
    version: 1,
    flash: false,
    datetime: '2026-01-01T00:00:00Z',
    kind: 'Alarm',
    code,
  };
}

const VENDOR_CRITICAL_GROUP = '024';

/** Every wire code the vendor's parser knows about, as numbers. */
const vendorCodes = Object.keys(vendorTable).map(Number);

/** Vendor codes whose name key is the critical "stop using pump" group. */
const vendorCritical = Object.entries(vendorTable as Record<string, string>)
  .filter(([, name]) => name === VENDOR_CRITICAL_GROUP)
  .map(([code]) => Number(code));

/** Vendor codes outside the critical group. */
const vendorNonCritical = vendorCodes.filter((c) => !vendorCritical.includes(c));

describe('alarm coverage against the vendor table', () => {
  it('the vendored fixture is the 73-entry table', () => {
    // If this fails the fixture was replaced or truncated, and every assertion
    // below becomes meaningless. Pin the size.
    expect(vendorCodes).toHaveLength(73);
    expect(new Set(Object.values(vendorTable)).size).toBe(19);
  });

  it('every vendor critical code is tiered stop_using_pump', () => {
    expect(vendorCritical).toHaveLength(7);
    for (const code of vendorCritical) {
      const r = evaluateLastAlarm(alarm(code));
      expect(r, `code ${code}`).not.toBeNull();
      expect(r!.severity, `code ${code} must be stop_using_pump`).toBe('stop_using_pump');
    }
  });

  it('every non-critical vendor code is tiered delivery_stopped, never other', () => {
    // This is the assertion that would have caught the original defect: 53 of
    // these were falling through to `other`.
    expect(vendorNonCritical).toHaveLength(66);
    const fellThrough = vendorNonCritical.filter((code) => {
      const r = evaluateLastAlarm(alarm(code));
      return r!.severity === 'other';
    });
    expect(fellThrough, `codes annotated 'other': ${fellThrough.join(', ')}`).toEqual([]);
  });

  it('no vendor code produces "Unknown alarm code" text', () => {
    const unknown = vendorCodes.filter((code) => {
      const r = evaluateLastAlarm(alarm(code));
      return r!.text.startsWith('Unknown alarm code');
    });
    expect(unknown, `codes with no text: ${unknown.join(', ')}`).toEqual([]);
  });

  it('a code outside the vendor table still surfaces, tiered other', () => {
    // The safety property: never silently drop. 999 is not in the table, so it
    // must still produce an annotation rather than null.
    const r = evaluateLastAlarm(alarm(999));
    expect(r).not.toBeNull();
    expect(r!.severity).toBe('other');
    expect(r!.text).toBe('Unknown alarm code 999');
  });

  it('NGP string form "N24" resolves to the critical tier', () => {
    // The wire form is UNVERIFIED on the live API, so both are accepted.
    const r = evaluateLastAlarm(alarm('N24'));
    expect(r!.severity).toBe('stop_using_pump');
    expect(r!.wireCode).toBe('N24');
  });

  it('legacy-only codes keep their own source severity, not the vendor tier', () => {
    // These four are in the third-party paradigm-era dictionary but absent from
    // the vendor table. Only 131 was documented critical; the rest were
    // documented "Insulin delivery stopped". Escalating all four would cry wolf.
    for (const code of [131, 130, 1, 5]) {
      expect(vendorCodes, `${code} must NOT be vendor data`).not.toContain(code);
    }
    expect(evaluateLastAlarm(alarm(131))!.severity).toBe('stop_using_pump');
    for (const code of [130, 1, 5]) {
      expect(evaluateLastAlarm(alarm(code))!.severity, `code ${code}`).toBe('delivery_stopped');
    }
  });
});
