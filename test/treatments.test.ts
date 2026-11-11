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

  describe('malformed markers', () => {
    it('dates nothing for a non-integer index and reports it', () => {
      // 280.5 is not a coarser slot — it is a malformed one. Honouring it
      // produced a timestamp at :27:30 that matches no CareLink slot.
      const res = mapMarkers([{ index: 280.5, type: 'MEAL', amount: 45 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.undatable).toBe(1);
    });

    it('reports a mappable type with no index as undatable, not as an unmapped type', () => {
      // Blaming the vocabulary for a missing field sends an operator looking
      // at the wrong thing: MEAL is a perfectly well-known type.
      const res = mapMarkers([{ type: 'MEAL', amount: 45 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.undatable).toBe(1);
      expect(res.unmapped).toEqual({});
    });

    it('reports a string index rather than silently ignoring the marker', () => {
      const res = mapMarkers([{ index: '280', type: 'MEAL', amount: 45 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.undatable).toBe(1);
    });

    it('counts a marker with no type instead of returning an empty census', () => {
      // Previously `{index: 280, amount: 45}` produced no treatments AND an
      // empty `unmapped`, so a dropped meal was completely unobservable.
      const res = mapMarkers([{ index: 280, amount: 45 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ '(no type)': 1 });
    });

    it('counts a non-string type', () => {
      const res = mapMarkers([{ index: 280, type: 7, amount: 45 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ '(non-string type)': 1 });
    });

    it('counts a non-object array entry', () => {
      const res = mapMarkers([null, 42, 'marker', []], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ '(not an object)': 4 });
    });

    it('does not corrupt the census when a marker type is a prototype name', () => {
      // Keying the census on a plain `{}` meant `constructor` resolved to
      // Object's own function and the count became the string
      // "function Object() { [native code] }1", while `__proto__` was dropped.
      const res = mapMarkers(
        [
          { index: 280, type: 'constructor' },
          { index: 281, type: 'toString' },
          { index: 282, type: '__proto__' },
          { index: 283, type: 'hasOwnProperty' },
        ],
        ANCHOR,
      );
      expect(res.treatments).toEqual([]);
      // Built with Object.fromEntries on purpose: `__proto__: 1` inside an
      // object LITERAL sets the prototype instead of creating a key, so a
      // literal expectation would silently compare against three keys.
      expect(res.unmapped).toEqual(Object.fromEntries([
        ['constructor', 1], ['toString', 1], ['__proto__', 1], ['hasOwnProperty', 1],
      ]));
      expect(Object.getPrototypeOf(res.unmapped)).toBeNull();
      expect(typeof res.unmapped['constructor']).toBe('number');
    });

    it('accepts a numeric string amount instead of dropping the value', () => {
      // The wire is documented numeric, but a stringified number is a lossless
      // variant. Previously this emitted a Carb Correction with NO carbs.
      const res = mapMarkers([{ index: 280, type: 'MEAL', amount: '45' }], ANCHOR);
      expect(res.treatments).toHaveLength(1);
      expect(res.treatments[0]).toMatchObject({ eventType: 'Carb Correction', carbs: 45 });
    });

    it('accepts a numeric string on both halves of a paired event', () => {
      const res = mapMarkers(
        [
          { index: 280, type: 'MEAL', amount: '45' },
          { index: 280, type: 'INSULIN', amount: '6.5' },
        ],
        ANCHOR,
      );
      expect(res.treatments[0]).toMatchObject({ eventType: 'Meal Bolus', carbs: 45, insulin: 6.5 });
    });

    it('refuses a NEGATIVE insulin amount rather than subtracting from the record', () => {
      // A negative dose is physically impossible; `-1` is a sentinel elsewhere
      // in this payload (activeInsulin "no IOB"). Writing insulin: -3 would
      // reduce a dosing total.
      const res = mapMarkers([{ index: 280, type: 'INSULIN', amount: -3 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ 'INSULIN(negative amount)': 1 });
    });

    it('refuses a negative carb amount', () => {
      const res = mapMarkers([{ index: 280, type: 'MEAL', amount: -45 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ 'MEAL(negative amount)': 1 });
    });

    it('treats NaN and Infinity amounts as absent, and counts them', () => {
      const nan = mapMarkers([{ index: 280, type: 'INSULIN', amount: Number.NaN }], ANCHOR);
      expect(nan.treatments).toEqual([]);
      expect(nan.unmapped).toEqual({ 'INSULIN(no amount)': 1 });
      const inf = mapMarkers([{ index: 280, type: 'MEAL', amount: Infinity }], ANCHOR);
      expect(inf.treatments).toEqual([]);
      expect(inf.unmapped).toEqual({ 'MEAL(no amount)': 1 });
    });

    it('does not write a treatment for a meal with no carbs and no bolus', () => {
      const res = mapMarkers([{ index: 280, type: 'MEAL' }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ 'MEAL(no amount)': 1 });
    });

    it('maps a MEAL at an index where a zero-amount INSULIN sits, keeping the carbs', () => {
      // A cancelled/prime bolus does not consume the meal's carbs.
      const res = mapMarkers(
        [
          { index: 280, type: 'MEAL', amount: 45 },
          { index: 280, type: 'INSULIN', amount: 0 },
        ],
        ANCHOR,
      );
      expect(res.treatments).toHaveLength(1);
      expect(res.treatments[0]).toMatchObject({ eventType: 'Carb Correction', carbs: 45 });
      expect(res.unmapped).toEqual({ 'INSULIN(zero amount)': 1 });
    });

    it('pairs the REAL bolus when a zero-amount one arrives first at the same index', () => {
      // Measured before the fix: the 0 U marker was consumed by the meal, so
      // the record said "45 g, 0 U" and the actual 4 U became a correction.
      const res = mapMarkers(
        [
          { index: 280, type: 'MEAL', amount: 45 },
          { index: 280, type: 'INSULIN', amount: 0 },
          { index: 280, type: 'INSULIN', amount: 4 },
        ],
        ANCHOR,
      );
      const meals = res.treatments.filter((t) => t.eventType === 'Meal Bolus');
      expect(meals).toHaveLength(1);
      expect(meals[0]).toMatchObject({ carbs: 45, insulin: 4 });
      expect(res.treatments.filter((t) => t.eventType === 'Correction Bolus')).toHaveLength(0);
    });

    it('drops a lone zero-amount bolus without inventing a 0 U event', () => {
      const res = mapMarkers([{ index: 280, type: 'INSULIN', amount: 0 }], ANCHOR);
      expect(res.treatments).toEqual([]);
      expect(res.unmapped).toEqual({ 'INSULIN(zero amount)': 1 });
    });

    it('keeps a MEAL and a BG reading that share one index as two events', () => {
      // Types beyond meal/bolus still share the slot; neither may overwrite.
      const res = mapMarkers(
        [
          { index: 280, type: 'MEAL', amount: 45 },
          { index: 280, type: 'BG_READING', value: 118 },
        ],
        ANCHOR,
      );
      expect(res.treatments).toHaveLength(2);
      expect(res.treatments.map((t) => t.eventType).sort())
        .toEqual(['BG Check', 'Carb Correction']);
    });

    it('maps the "BG READING" spelling used by paradigm-era payloads', () => {
      // Area S4 §5.3 covers BG_READING vs BG; the 2015 memo §P1.1 records the
      // spaced spelling too, and it was previously counted as unmapped.
      const res = mapMarkers([{ index: 279, type: 'BG READING', value: 118 }], ANCHOR);
      expect(res.treatments).toHaveLength(1);
      expect(res.treatments[0]).toMatchObject({ eventType: 'BG Check', glucose: 118 });
    });

    it('reads a numeric string glucose without dropping the fingerstick', () => {
      const res = mapMarkers([{ index: 279, type: 'BG_READING', value: '118' }], ANCHOR);
      expect(res.treatments[0]).toMatchObject({ eventType: 'BG Check', glucose: 118 });
    });
  });

  describe('BG Check attribution', () => {
    it('never attaches a fingerstick to a PREVIOUS treatment when it is undatable', () => {
      // THE BUG THIS GUARDS. `glucose` used to be written to
      // out.treatments[length - 1]. When the BG marker could not be dated,
      // emit() returned early and the glucose landed on the meal bolus that
      // preceded it — corrupting a DIFFERENT event's permanent record.
      // Measured pre-fix: Meal Bolus carried glucose 118, glucoseType Finger.
      const res = mapMarkers(
        [
          { index: 280, type: 'MEAL', amount: 45 },
          { index: 280, type: 'INSULIN', amount: 6.5 },
          { index: 400, type: 'BG_READING', value: 118 }, // past the window
        ],
        ANCHOR,
      );
      expect(res.undatable).toBe(1);
      expect(res.treatments).toHaveLength(1);
      expect(res.treatments[0]).toMatchObject({ eventType: 'Meal Bolus', carbs: 45, insulin: 6.5 });
      expect(res.treatments[0].glucose).toBeUndefined();
      expect(res.treatments[0].glucoseType).toBeUndefined();
    });

    it('attaches the glucose to its own treatment when it IS datable', () => {
      const res = mapMarkers(
        [
          { index: 280, type: 'INSULIN', amount: 3 },
          { index: 279, type: 'BG_READING', value: 118 },
        ],
        ANCHOR,
      );
      expect(res.treatments).toHaveLength(2);
      expect(res.treatments[0]).toMatchObject({ eventType: 'Correction Bolus', insulin: 3 });
      expect(res.treatments[0].glucose).toBeUndefined();
      expect(res.treatments[1]).toMatchObject({
        eventType: 'BG Check', glucose: 118, glucoseType: 'Finger', created_at: atIndex(279),
      });
    });

    it('does not swallow a datable bolus when the MEAL at its index is undatable', () => {
      // The meal could not be dated, so it never reached the output; consuming
      // its bolus anyway made the insulin vanish with no count anywhere.
      const res = mapMarkers(
        [
          { index: 400, type: 'MEAL', amount: 45 },
          { index: 400, type: 'INSULIN', amount: 4 },
        ],
        ANCHOR,
      );
      // The bolus is keyed by index 400 → also undatable, but it must be
      // REPORTED rather than consumed into nothing.
      expect(res.undatable).toBe(2);
      expect(res.treatments).toEqual([]);
    });
  });

  describe('scale', () => {
    it('is not quadratic: 10,000 markers at one index map without stalling', () => {
      // A nested scan over the bolus bucket per meal would be O(n²) here.
      // Asserted as a wall-clock budget, which is deliberately loose — the
      // failure mode is seconds-to-minutes, not milliseconds.
      const markers: unknown[] = [];
      for (let i = 0; i < 5000; i++) markers.push({ index: 280, type: 'MEAL', amount: 10 });
      for (let i = 0; i < 5000; i++) markers.push({ index: 280, type: 'INSULIN', amount: 1 });
      const started = Date.now();
      const res = mapMarkers(markers, ANCHOR);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(2000);
      // Conservation: every bolus is accounted for.
      const insulin = res.treatments.reduce((s, t) => s + ((t.insulin as number) ?? 0), 0);
      expect(insulin).toBe(5000);
      expect(res.treatments.length).toBe(5000);
    });
  });
});
