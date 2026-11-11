import { describe, it, expect } from 'vitest';
import {
  mapMarkers,
  markerTime,
  treatmentId,
  MARKER_SLOT_MS,
  MARKER_LAST_SLOT,
} from '../src/transform/treatments.js';

/**
 * The anchor is the newest datapoint's time; every marker time is relative to
 * it. A fixed anchor keeps these tests deterministic — `Date.now()` anywhere
 * in this file would make them pass on the day they were written and rot after.
 */
const ANCHOR = Date.UTC(2026, 10, 11, 12, 0, 0);

/** A marker at `index` maps to `anchor − (287 − index) × 5 min`. */
function atIndex(index: number): string {
  return new Date(ANCHOR - (MARKER_LAST_SLOT - index) * MARKER_SLOT_MS).toISOString();
}

describe('markerTime', () => {
  it('places index 287 at the anchor', () => {
    expect(markerTime(287, ANCHOR)).toBe(ANCHOR);
  });

  it('places index 0 a full 287 slots back (≈24 h)', () => {
    const want = ANCHOR - 287 * MARKER_SLOT_MS;
    expect(markerTime(0, ANCHOR)).toBe(want);
    // 287 × 5 min = 1435 min = 23 h 55 m
    expect((ANCHOR - want) / 60_000).toBe(1435);
  });

  it('rejects an index past the window rather than clamping it', () => {
    // A clamp here would move a marker into the future, which is the exact
    // class of defect that produced future-dated readings elsewhere.
    expect(markerTime(288, ANCHOR)).toBeNull();
    expect(markerTime(-1, ANCHOR)).toBeNull();
  });

  it('rejects a non-finite anchor', () => {
    expect(markerTime(280, Number.NaN)).toBeNull();
    expect(markerTime(280, Infinity)).toBeNull();
  });

  it('rejects a non-numeric index', () => {
    expect(markerTime('280' as unknown, ANCHOR)).toBeNull();
    expect(markerTime(undefined, ANCHOR)).toBeNull();
  });
});

describe('mapMarkers', () => {
  it('returns nothing for a missing or empty array', () => {
    expect(mapMarkers(undefined, ANCHOR).treatments).toEqual([]);
    expect(mapMarkers([], ANCHOR).treatments).toEqual([]);
    expect(mapMarkers('nope', ANCHOR).treatments).toEqual([]);
  });

  it('refuses to date anything without a finite anchor', () => {
    // The failure this guards: anchoring at Date.now() would stamp every
    // historic meal with the fetch time and plot the whole day at "now".
    const res = mapMarkers([{ index: 280, type: 'MEAL', amount: 40 }], Number.NaN);
    expect(res.treatments).toEqual([]);
    expect(res.undatable).toBe(1);
  });

  it('pairs a MEAL with its bolus at the same index into one Meal Bolus', () => {
    const res = mapMarkers(
      [
        { index: 280, type: 'MEAL', amount: 45 },
        { index: 280, type: 'INSULIN', amount: 6.5 },
      ],
      ANCHOR,
    );
    const meals = res.treatments.filter((t) => t.eventType === 'Meal Bolus');
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({ carbs: 45, insulin: 6.5, created_at: atIndex(280) });
    // The paired bolus is CONSUMED by the meal — it must not also appear alone.
    expect(res.treatments.filter((t) => t.eventType === 'Correction Bolus')).toHaveLength(0);
    expect(res.treatments).toHaveLength(1);
  });

  it('still emits a separate Correction Bolus for an unpaired bolus beside a paired one', () => {
    // A meal+bolus at one index, plus a standalone correction at another. The
    // paired one is consumed; the standalone one is not.
    const res = mapMarkers(
      [
        { index: 280, type: 'MEAL', amount: 45 },
        { index: 280, type: 'INSULIN', amount: 6.5 },
        { index: 281, type: 'INSULIN', amount: 1.5 },
      ],
      ANCHOR,
    );
    expect(res.treatments.filter((t) => t.eventType === 'Meal Bolus')).toHaveLength(1);
    const corr = res.treatments.filter((t) => t.eventType === 'Correction Bolus');
    expect(corr).toHaveLength(1);
    expect(corr[0]).toMatchObject({ insulin: 1.5, created_at: atIndex(281) });
  });

  it('emits an unpaired INSULIN as a Correction Bolus', () => {
    const res = mapMarkers([{ index: 279, type: 'INSULIN', amount: 2.5 }], ANCHOR);
    expect(res.treatments).toHaveLength(1);
    expect(res.treatments[0]).toMatchObject({
      eventType: 'Correction Bolus',
      insulin: 2.5,
      created_at: atIndex(279),
    });
  });

  it('keeps the carbs of a meal that had no bolus', () => {
    const res = mapMarkers([{ index: 278, type: 'MEAL', amount: 20 }], ANCHOR);
    expect(res.treatments[0]).toMatchObject({
      eventType: 'Carb Correction',
      carbs: 20,
    });
    expect(res.treatments[0].insulin).toBeUndefined();
  });

  it('maps BG readings and calibration to a BG Check with fingerstick glucose', () => {
    const res = mapMarkers(
      [
        { index: 277, type: 'BG_READING', value: 118 },
        { index: 276, type: 'BG', value: 132 },
        { index: 275, type: 'CALIBRATION', value: 120 },
      ],
      ANCHOR,
    );
    expect(res.treatments).toHaveLength(3);
    for (const t of res.treatments) {
      expect(t.eventType).toBe('BG Check');
      expect(t.glucoseType).toBe('Finger');
    }
    expect(res.treatments.map((t) => t.glucose)).toEqual([118, 132, 120]);
  });

  it('counts the declared-but-unhandled SmartGuard markers instead of inventing a shape', () => {
    // AUTO_BASAL_DELIVERY and AUTO_MODE_STATUS are in the 11-token vocabulary
    // and are never handled by the vendor's own client either. Guessing a
    // treatment shape for them would be fabrication.
    const res = mapMarkers(
      [
        { index: 274, type: 'AUTO_BASAL_DELIVERY', value: 0.8 },
        { index: 273, type: 'AUTO_MODE_STATUS', value: 1 },
        { index: 272, type: 'EXERCISE', value: 30 },
      ],
      ANCHOR,
    );
    expect(res.treatments).toEqual([]);
    expect(res.unmapped).toEqual({
      AUTO_BASAL_DELIVERY: 1,
      AUTO_MODE_STATUS: 1,
      EXERCISE: 1,
    });
  });

  it('counts a marker it cannot date rather than dropping it silently', () => {
    const res = mapMarkers(
      [
        { index: 400, type: 'MEAL', amount: 30 }, // past the window
        { index: 270, type: 'MEAL', amount: 30 }, // fine
      ],
      ANCHOR,
    );
    expect(res.treatments).toHaveLength(1);
    expect(res.undatable).toBe(1);
  });

  it('rounds to 3dp so float noise does not reach Nightscout', () => {
    const res = mapMarkers([{ index: 269, type: 'INSULIN', amount: 0.1 + 0.2 }], ANCHOR);
    expect(res.treatments[0].insulin).toBe(0.3);
  });

  it('is idempotent — the same marker array yields identical _ids', () => {
    // CareLink re-sends a rolling 24 h of markers on EVERY fetch. Without a
    // deterministic _id, Nightscout would append a duplicate meal per poll.
    const markers = [
      { index: 268, type: 'MEAL', amount: 40 },
      { index: 268, type: 'INSULIN', amount: 5 },
    ];
    const a = mapMarkers(markers, ANCHOR);
    const b = mapMarkers(markers, ANCHOR);
    expect(a.treatments.map((t) => t._id)).toEqual(b.treatments.map((t) => t._id));
  });

  it('gives two genuinely different meals different ids', () => {
    const a = mapMarkers([{ index: 267, type: 'MEAL', amount: 40 }], ANCHOR);
    const b = mapMarkers([{ index: 266, type: 'MEAL', amount: 40 }], ANCHOR);
    expect(a.treatments[0]._id).not.toBe(b.treatments[0]._id);
  });

  it('distinguishes a meal from a carb correction at the same time', () => {
    // Same instant, same carbs, different event type — must not collide, or one
    // would overwrite the other.
    expect(treatmentId(ANCHOR, 'Meal Bolus', 40, undefined))
      .not.toBe(treatmentId(ANCHOR, 'Carb Correction', 40, undefined));
  });

  it('stamps enteredBy and notes so the provenance is visible downstream', () => {
    const res = mapMarkers([{ index: 265, type: 'INSULIN', amount: 1 }], ANCHOR);
    expect(res.treatments[0]).toMatchObject({
      enteredBy: 'carelink-bridge',
      notes: 'carelink-marker',
    });
  });

  it('does not lose insulin when two boluses share an index', () => {
    // REGRESSION. The first implementation kept boluses in a Map keyed by
    // index, so a second INSULIN at the same slot OVERWROTE the first: 3 U + 4 U
    // was recorded as 4 U. Under-counting delivered insulin is the dangerous
    // direction for a dosing record, so this is asserted on the TOTAL.
    const res = mapMarkers(
      [
        { index: 280, type: 'INSULIN', amount: 3 },
        { index: 280, type: 'INSULIN', amount: 4 },
      ],
      ANCHOR,
    );
    const total = res.treatments.reduce(
      (s, t) => s + ((t.insulin as number | undefined) ?? 0), 0,
    );
    expect(total).toBe(7);
    expect(res.treatments).toHaveLength(2);
  });

  it('gives two boluses at one index distinct ids', () => {
    // They share a timestamp and an eventType, so the id must still separate
    // them or Nightscout would dedup the second away — the same loss by another
    // route.
    const res = mapMarkers(
      [
        { index: 280, type: 'INSULIN', amount: 3 },
        { index: 280, type: 'INSULIN', amount: 4 },
      ],
      ANCHOR,
    );
    const ids = res.treatments.map((t) => t._id);
    expect(new Set(ids).size).toBe(2);
  });

  it('consumes only one bolus per meal, leaving a second as a correction', () => {
    const res = mapMarkers(
      [
        { index: 280, type: 'MEAL', amount: 40 },
        { index: 280, type: 'INSULIN', amount: 4 },
        { index: 280, type: 'INSULIN', amount: 2 },
      ],
      ANCHOR,
    );
    const meal = res.treatments.find((t) => t.eventType === 'Meal Bolus');
    expect(meal).toMatchObject({ carbs: 40, insulin: 4 });
    const corr = res.treatments.filter((t) => t.eventType === 'Correction Bolus');
    expect(corr).toHaveLength(1);
    expect(corr[0].insulin).toBe(2);
    // Total insulin is preserved across the whole mapping.
    const total = res.treatments.reduce(
      (s, t) => s + ((t.insulin as number | undefined) ?? 0), 0,
    );
    expect(total).toBe(6);
  });

  it('keeps two IDENTICAL boluses distinct, not just differently-sized ones', () => {
    // The hash reads (time, eventType, carbs, insulin) — every field two
    // identical boluses share. Without an occurrence discriminator they collide
    // on _id and Nightscout's dedup silently drops the second, which is the
    // lost-insulin defect arriving by a different route.
    const res = mapMarkers(
      [
        { index: 280, type: 'INSULIN', amount: 3 },
        { index: 280, type: 'INSULIN', amount: 3 },
      ],
      ANCHOR,
    );
    expect(res.treatments).toHaveLength(2);
    expect(new Set(res.treatments.map((t) => t._id)).size).toBe(2);
    const total = res.treatments.reduce(
      (s, t) => s + ((t.insulin as number | undefined) ?? 0), 0,
    );
    expect(total).toBe(6);
  });

  it('is still idempotent for identical markers across two calls', () => {
    // The occurrence counter must be per-CALL. If it were module-level, a second
    // fetch would mint new ids for the same markers and duplicate them.
    const markers = [
      { index: 280, type: 'INSULIN', amount: 3 },
      { index: 280, type: 'INSULIN', amount: 3 },
    ];
    const a = mapMarkers(markers, ANCHOR).treatments.map((t) => t._id);
    const b = mapMarkers(markers, ANCHOR).treatments.map((t) => t._id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });
});
