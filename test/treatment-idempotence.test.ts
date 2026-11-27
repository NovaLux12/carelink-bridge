/**
 * Treatment idempotence across polls.
 *
 * The property the deterministic `_id` scheme exists to guarantee: ONE physical
 * meal produces ONE Nightscout row, no matter how many times CareLink re-sends
 * it in its rolling 24 h window.
 *
 * It did not hold. `treatmentId()` hashes the marker's derived millisecond, and
 * that millisecond is `anchor − (287 − index) × 300_000` where the anchor is
 * `lastMedicalDeviceDataUpdateServerTime` — a raw server value that is never
 * slot-aligned (real fixtures carry residues of 170_381 ms and 275_436 ms).
 *
 * Measured before the fix, one meal across two polls:
 *
 *   poll1  index 280  id carelink-marker-7890e2…  created 11:25:00.381Z
 *   poll2  index 279  id carelink-marker-5633cf…  created 11:25:02.881Z
 *
 * Nightscout dedups treatments on `_id` alone, so each poll appended another
 * row. Its IOB/COB sums then counted that insulin and those carbs twice — in the
 * app people dose from.
 */

import { describe, expect, it } from 'vitest';
import { transform } from '../src/transform/index.js';
import { MARKER_SLOT_MS, quantiseAnchor } from '../src/transform/treatments.js';
import type { CareLinkData } from '../src/types/carelink.js';

/** The meal's true slot time. */
const MEAL_AT = Date.UTC(2026, 10, 12, 11, 25, 0);

function payload(anchorMs: number, index: number): CareLinkData {
  return {
    lastMedicalDeviceDataUpdateServerTime: anchorMs,
    clientTimeZoneName: 'Europe/London',
    sgs: [{ sg: 7.2, timestamp: 'Nov 12, 2026 11:30:00', version: 1, kind: 'SG' }],
    markers: [
      { index, type: 'MEAL', amount: 45 },
      { index, type: 'INSULIN', amount: 4 },
    ],
  } as unknown as CareLinkData;
}

/** One slot of anchor advance, plus the sub-slot jitter a real response carries. */
function nextPoll(anchorMs: number): number {
  return anchorMs + MARKER_SLOT_MS + 2_500;
}

describe('treatment idempotence across polls', () => {
  it('quantiseAnchor snaps to the slot grid and is idempotent', () => {
    expect(quantiseAnchor(MEAL_AT + 381)).toBe(MEAL_AT);
    expect(quantiseAnchor(MEAL_AT + 381)).toBe(quantiseAnchor(quantiseAnchor(MEAL_AT + 381)));
    expect(quantiseAnchor(MEAL_AT) % MARKER_SLOT_MS).toBe(0);
  });

  it('one meal re-sent with a drifting anchor keeps the same _id', () => {
    const anchor1 = MEAL_AT + 35 * 60_000 + 381;
    const anchor2 = nextPoll(anchor1);

    const t1 = transform(payload(anchor1, 280), 24).treatments[0];
    // CareLink slides the marker down one slot as the window advances.
    const t2 = transform(payload(anchor2, 279), 24).treatments[0];

    expect(t1._id).toBe(t2._id);
    expect(t1.created_at).toBe(t2.created_at);
    expect(t1.carbs).toBe(45);
    expect(t1.insulin).toBe(4);
    expect(t2.carbs).toBe(45);
    expect(t2.insulin).toBe(4);
  });

  it('holds across many consecutive polls, not just two', () => {
    let anchor = MEAL_AT + 35 * 60_000 + 170_381;
    const ids = new Set<string>();
    for (let poll = 0; poll < 12; poll++) {
      const index = 280 - poll;
      ids.add(transform(payload(anchor, index), 24).treatments[0]._id as string);
      anchor = nextPoll(anchor);
    }
    expect(ids.size).toBe(1);
  });

  it('still separates two genuinely distinct boluses at the same slot', () => {
    // Over-quantising must not collapse real siblings. Two identical boluses at
    // one index are separated by the `occurrence` discriminator, not the time.
    const anchor = MEAL_AT + 35 * 60_000;
    const out = transform(
      {
        lastMedicalDeviceDataUpdateServerTime: anchor,
        clientTimeZoneName: 'Europe/London',
        sgs: [{ sg: 7.2, timestamp: 'Nov 12, 2026 11:30:00', version: 1, kind: 'SG' }],
        markers: [
          { index: 280, type: 'INSULIN', amount: 3 },
          { index: 280, type: 'INSULIN', amount: 3 },
        ],
      } as unknown as CareLinkData,
      24,
    );
    expect(out.treatments).toHaveLength(2);
    expect(out.treatments[0]._id).not.toBe(out.treatments[1]._id);
    // Both doses are recorded — under-counting delivered insulin is the
    // dangerous direction.
    expect(out.treatments.reduce((n, t) => n + (t.insulin as number), 0)).toBe(6);
  });
});

/**
 * The 780G's own marker shape, measured 2026-11-27.
 *
 * The slot-based tests above use a synthetic payload with no `dateTime`. Real
 * NGP markers carry one, and on those the slot math is measurably unstable:
 * the same 12 g meal came back with index 228 then 196 (166 s of derived drift)
 * while `dateTime` never moved. Three distinct `_id`s were minted for that one
 * meal, Nightscout appended all three, and the dashboard read **COB 15.1 g**
 * for carbs the pump had already finished absorbing.
 *
 * `dateTime` is now the primary source; the slot is only a fallback.
 */
describe('780G marker shape: dateTime beats slot arithmetic', () => {
  /** A real NGP payload: index slides, dateTime is fixed. */
  function ngpPayload(anchorMs: number, index: number, dateTime: string): CareLinkData {
    return {
      lastMedicalDeviceDataUpdateServerTime: anchorMs,
      clientTimeZoneName: 'GMT+00:00',
      sgs: [{ sg: 145, datetime: '2026-11-27T12:25:01.000Z', version: 1, kind: 'SG' }],
      markers: [
        { index, type: 'MEAL', amount: 34, dateTime, id: 2 },
        {
          index, type: 'INSULIN', bolusType: 'FAST', completed: true,
          programmedFastAmount: 7.3, deliveredFastAmount: 7.3,
          programmedExtendedAmount: 0, deliveredExtendedAmount: 0,
          dateTime, id: 2,
        },
      ],
    } as unknown as CareLinkData;
  }

  const AT = '2026-11-27T12:23:03.000-00:00';

  it('keeps ONE _id when the slot index slides but dateTime is fixed', () => {
    // Exactly the two captures measured on the live pump, 2 h 40 m apart.
    const poll1 = ngpPayload(Date.parse('2026-11-27T15:22:04.466Z'), 251, AT);
    const poll2 = ngpPayload(Date.parse('2026-11-27T18:04:50.134Z'), 219, AT);

    const t1 = transform(poll1, 24).treatments.find((t) => t.eventType === 'Meal Bolus');
    const t2 = transform(poll2, 24).treatments.find((t) => t.eventType === 'Meal Bolus');

    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t1!._id).toBe(t2!._id);
    expect(t1!.created_at).toBe(t2!.created_at);
    // And the time is the pump's own, not a quantised slot boundary.
    expect(t1!.created_at).toBe('2026-11-27T12:23:03.000Z');
    expect(t1!.carbs).toBe(34);
    expect(t1!.insulin).toBe(7.3);
  });

  it('holds across a whole afternoon of polls', () => {
    const ids = new Set<string>();
    let anchor = Date.parse('2026-11-27T15:22:04.466Z');
    let index = 251;
    for (let poll = 0; poll < 40; poll++) {
      const t = transform(ngpPayload(anchor, index, AT), 24)
        .treatments.find((x) => x.eventType === 'Meal Bolus');
      ids.add(t!._id as string);
      anchor += MARKER_SLOT_MS + 1_700;   // one slot of drift plus jitter
      index -= 1;
    }
    // ONE id across 40 polls is the whole point: Nightscout dedups on _id.
    expect(ids.size).toBe(1);
  });

  it('falls back to the QUANTISED anchor when dateTime is absent', () => {
    // No dateTime: the slot path must still be idempotent. Passing the raw
    // anchor here re-introduced sub-slot jitter and broke this.
    const p1 = transform(payload(MEAL_AT + 35 * 60_000 + 381, 280), 24).treatments[0];
    const p2 = transform(payload(MEAL_AT + 35 * 60_000 + 381 + MARKER_SLOT_MS + 2_500, 279), 24)
      .treatments[0];
    expect(p1._id).toBe(p2._id);
  });
});
