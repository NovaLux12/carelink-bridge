import { createHash } from 'node:crypto';
import type { CareLinkMarker } from '../types/carelink.js';

/**
 * CareLink `markers[]` → Nightscout treatments.
 *
 * WHY THIS EXISTS. Until now the bridge posted two Nightscout documents per
 * fetch — entries and devicestatus — and silently dropped `markers`, which is
 * where CareLink puts every meal, bolus and fingerstick. That made a working
 * pump look like a CGM with no insulin history. The research repo calls this
 * the single largest "available but unused" gap
 * (carelink-api-research findings-log/medtronic-carelink-2026-07-21 §P1.1).
 *
 * THE WIRE SHAPE (OBSERVED, carelink-api-research area S4 §5.1). A marker
 * carries `index` (an INTEGER slot, NOT a timestamp), `type`, `value`, and
 * optionally `deliverySuspended`. The timestamp is derived:
 *
 *     t = anchor − (287 − index) × 300_000 ms
 *
 * where `anchor` is the newest datapoint's time and 300 s is CareLink's slot
 * width. So a marker's time is only expressible relative to an anchor — a
 * marker array with no anchor cannot be dated, and this module refuses to
 * guess (see `markerTime`).
 *
 * WHAT IS DELIBERATELY NOT MAPPED. `AUTO_BASAL_DELIVERY` and
 * `AUTO_MODE_STATUS` are declared in the 11-token vocabulary but are never
 * handled by the vendor's own client either (area S4 §5.2 — declared but
 * unreachable, falling to `default`). They are dropped here for the same
 * reason: nobody has observed their payload, and inventing a treatment shape
 * for a token whose semantics are unmeasured would be fabrication. They are
 * counted and logged instead, so an operator can see they exist and are not
 * silently lost.
 */

/**
 * Marker types the vendor's own client acts on, mapped to a Nightscout event.
 *
 * The glucose spellings are not redundant: the vendor's client branches on
 * `connectType` and matches the literal `BG_READING` on the BLE (NGP) path but
 * the enum `BG` on the non-BLE path, so a consumer switching on one alone
 * drops every marker from the other family (area S4 §5.3, "the two
 * vocabularies diverge").
 *
 * `'BG READING'` (with a space) is a third spelling documented in
 * `findings-log/medtronic-carelink-2026-07-21/03-data-model-and-gaps.md` §P1.1
 * for paradigm-era payloads, and is the spelling the 2015 sample actually
 * carries. All three mean one thing — a fingerstick — so they share a branch.
 */
const MEAL_TYPES = new Set(['MEAL']);
const INSULIN_TYPES = new Set(['INSULIN']);
const BG_TYPES = new Set(['BG_READING', 'BG', 'BG READING', 'CALIBRATION']);

/** CareLink's slot width: 287 slots of 5 minutes ≈ 24 h. */
export const MARKER_SLOT_MS = 300_000;
export const MARKER_LAST_SLOT = 287;

/**
 * Snap a marker anchor onto the marker slot grid.
 *
 * `markerTime()` places a marker at `anchor − (287 − index) × 300_000`, so a
 * marker's derived time inherits whatever sub-slot residue the anchor carries.
 * The anchor is `lastMedicalDeviceDataUpdateServerTime`, a raw server
 * millisecond value that is NOT slot-aligned (real fixtures carry residues of
 * 170_381 ms and 275_436 ms), and CareLink re-sends the same rolling 24 h of
 * markers on every poll with the anchor drifting by a couple of seconds.
 *
 * That made `treatmentId()` unstable: measured, one physical meal (index 280,
 * then 279, 7 s of anchor jitter) produced `carelink-marker-7890e2…` at
 * 11:25:00.381Z and `carelink-marker-5633cf…` at 11:25:02.881Z. Nightscout
 * dedups treatments on `_id` alone, so every poll appended another row for the
 * same meal — and its IOB/COB sums then counted that insulin and those carbs
 * twice, in the app people dose from.
 *
 * Quantising the anchor here makes both the `_id` and `created_at` land on the
 * same value for the same physical marker across polls. Flooring (not rounding)
 * is deliberate: the anchor means "the newest slot", so it belongs to the slot
 * it sits in.
 */
export function quantiseAnchor(anchorMs: number): number {
  if (!Number.isFinite(anchorMs)) return anchorMs;
  return Math.floor(anchorMs / MARKER_SLOT_MS) * MARKER_SLOT_MS;
}

/**
 * Derive a marker's absolute time.
 *
 * `index` is a slot in a 288-slot window whose last slot (287) is the anchor.
 * Anything outside 0..287 is rejected rather than clamped: a negative offset
 * would silently move a marker into the future, which is the exact defect that
 * produced future-dated readings in another client (research repo `docs/10`,
 * timestamp semantics row).
 *
 * A non-integer index is rejected too. The slot is an integer by definition
 * (area S4 §5.1), so `280.5` is not a coarser time — it is a malformed slot,
 * and honouring it would mint a timestamp at :27:30 that corresponds to no
 * CareLink slot and can never be reconciled with the pump's own log.
 */
export function markerTime(index: unknown, anchorMs: number): number | null {
  if (typeof index !== 'number' || !Number.isFinite(index)) return null;
  if (!Number.isInteger(index)) return null;
  if (index < 0 || index > MARKER_LAST_SLOT) return null;
  if (!Number.isFinite(anchorMs)) return null;
  return anchorMs - (MARKER_LAST_SLOT - index) * MARKER_SLOT_MS;
}

/**
 * A stable `_id` so a re-post UPDATES rather than inserts.
 *
 * Nightscout dedups entries on (sysTime, type) but treatments only on `_id`,
 * and it silently drops a duplicate `_id`. Without a deterministic id, every
 * poll would append a second copy of the same meal — CareLink re-sends the
 * same rolling 24 h of markers on every fetch.
 *
 * The id is derived from the fields that define the event, not from its
 * arrival time, so the same meal always hashes the same.
 */
export function treatmentId(
  createdMs: number,
  eventType: string,
  carbs: number | undefined,
  insulin: number | undefined,
  /**
   * Position among same-keyed siblings, 0 for the first. Two IDENTICAL boluses
   * at the same marker index share every field the hash reads — timestamp,
   * eventType, and both amounts — so without this they hash to one id and
   * Nightscout's `_id` dedup silently discards the second. That is the same
   * lost-insulin defect as the Map overwrite, arriving by a different route.
   */
  occurrence = 0,
): string {
  const digest = createHash('sha1')
    .update(`${createdMs}|${eventType}|${carbs ?? ''}|${insulin ?? ''}|${occurrence}`)
    .digest('hex');
  return `carelink-marker-${digest.slice(0, 24)}`;
}

/**
 * Read a numeric field that may arrive as a number or a numeric string.
 *
 * The wire is documented as numeric (`value` is "numeric, clamped by the
 * consumer", area S4 §5.1), but a stringified number is a lossless variant and
 * refusing it silently deleted the carbs off a meal. Measured before this
 * change: `{type:'MEAL', amount:'45'}` emitted a `Carb Correction` with NO
 * `carbs` field at all — an event that says a meal happened and not how big.
 *
 * Negative values are rejected, not clamped. The corpus records `-1` as a
 * sentinel on `activeInsulin.amount` ("no IOB", `field-census.json`), so a
 * negative amount is a flag rather than a dose, and a negative insulin or carb
 * value is physically impossible. Writing `insulin: -3` would subtract from a
 * dosing record; dropping the event and counting it is the honest direction.
 */
function num(v: unknown): number | undefined {
  let n: number | undefined;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n < 0) return undefined;
  return n;
}

/** Why a value was unusable, for the `unmapped` census. */
function amountProblem(v: unknown): 'no amount' | 'negative amount' | undefined {
  if (num(v) !== undefined) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n < 0
    ? 'negative amount'
    : 'no amount';
}

/** Trim to 3dp without float noise — insulin values are reported to 0.05 U. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface MarkerMappingResult {
  treatments: Record<string, unknown>[];
  /** Marker types present but deliberately unmapped, with their counts. */
  unmapped: Record<string, number>;
  /** Markers dropped because they could not be dated. */
  undatable: number;
}

/**
 * Map a CareLink marker array to Nightscout treatments.
 *
 * PAIRING. A meal and its bolus arrive as two markers sharing one `index`.
 * They are emitted as a single `Meal Bolus` carrying both carbs and insulin,
 * because that is what the user did and what every downstream report expects.
 * An INSULIN marker with no MEAL partner is a correction.
 *
 * Returns an empty list when `anchorMs` is not finite — a marker array with no
 * anchor is undatable, and emitting `Date.now()` there would stamp every
 * historic meal with the fetch time. That is the failure this bridge already
 * carries a correction for on the CGM path, and it is not repeated here.
 */
export function mapMarkers(
  markers: unknown,
  anchorMs: number,
): MarkerMappingResult {
  const out: MarkerMappingResult = {
    treatments: [],
    // Null prototype on purpose. This object is keyed by WIRE-SUPPLIED text, so
    // with a plain `{}` a marker whose type is `constructor` or `toString`
    // resolved to an inherited function and the count became the string
    // "function Object() { [native code] }1", while `__proto__` was silently
    // discarded (measured). A census that corrupts itself is worse than none.
    unmapped: Object.create(null) as Record<string, number>,
    undatable: 0,
  };
  if (!Array.isArray(markers) || markers.length === 0) return out;
  // Snap once, here, so every marker in this payload is dated off the same
  // slot-aligned grid — see quantiseAnchor() for why the raw anchor is unusable.
  const alignedAnchor = quantiseAnchor(anchorMs);
  if (!Number.isFinite(alignedAnchor)) {
    // Every marker in the array is undatable; report the population rather than
    // silently returning nothing and looking like "no markers this fetch".
    out.undatable = markers.length;
    return out;
  }

  const countUnmapped = (key: string): void => {
    out.unmapped[key] = (out.unmapped[key] ?? 0) + 1;
  };

  // A Map here silently LOST insulin: two INSULIN markers sharing an index
  // overwrote one another, so 3 U + 4 U was recorded as 4 U. Under-counting
  // delivered insulin is the dangerous direction for a dosing record, so the
  // boluses are kept as a LIST and consumed one at a time. Probed and confirmed
  // before the fix (7 U in, 4 U out).
  const insulinByIndex = new Map<number, CareLinkMarker[]>();
  const meals: CareLinkMarker[] = [];
  const others: CareLinkMarker[] = [];

  const MAPPER_TYPES = new Set([...MEAL_TYPES, ...INSULIN_TYPES, ...BG_TYPES]);

  for (const raw of markers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      // A non-object entry cannot be classified at all. Count it rather than
      // skipping in silence — the caller's log is the only way an operator
      // learns the array carried something unexpected.
      countUnmapped('(not an object)');
      continue;
    }
    const m = raw as CareLinkMarker;
    const t = m.type;
    if (typeof t !== 'string') {
      // No `type` means no dispatch is possible; measured before this change,
      // `{index: 280, amount: 45}` produced an EMPTY result with an empty
      // census, i.e. a dropped meal that nothing reported.
      countUnmapped(t === undefined ? '(no type)' : '(non-string type)');
      continue;
    }
    if (typeof m.index !== 'number') {
      // A mappable type with no usable slot is UNDATABLE, not an unmapped
      // type. Reporting it as `unmapped['MEAL']` would blame the vocabulary
      // for a missing field and point an operator at the wrong thing.
      if (MAPPER_TYPES.has(t)) { out.undatable++; continue; }
      countUnmapped(t);
      continue;
    }
    if (INSULIN_TYPES.has(t)) {
      const bucket = insulinByIndex.get(m.index);
      if (bucket) bucket.push(m);
      else insulinByIndex.set(m.index, [m]);
    } else if (MEAL_TYPES.has(t)) {
      meals.push(m);
    } else {
      others.push(m);
    }
  }

  // Sibling counter: how many times this exact (time, eventType, carbs,
  // insulin) tuple has already been emitted. Keeps identical markers distinct.
  const seen = new Map<string, number>();

  /**
   * Emit one treatment, or `null` when the marker cannot be dated.
   *
   * RETURNING the treatment rather than letting callers index back into
   * `out.treatments` is the fix for a mis-attribution bug: the BG branch used
   * to write `glucose` onto `out.treatments[length - 1]`, and when the BG
   * marker was undatable `emit` returned early, so the glucose landed on
   * whatever had been pushed BEFORE it. Measured: a fingerstick at index 400
   * stamped `glucose: 118, glucoseType: 'Finger'` onto an unrelated
   * `Meal Bolus` at index 280 — corrupting a different event's permanent
   * record. A null return makes that state unrepresentable.
   */
  const emit = (
    m: CareLinkMarker,
    eventType: string,
    carbs?: number,
    insulin?: number,
  ): Record<string, unknown> | null => {
    const created = markerTime(m.index, alignedAnchor);
    if (created === null) { out.undatable++; return null; }
    const key = `${created}|${eventType}|${carbs ?? ''}|${insulin ?? ''}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const t: Record<string, unknown> = {
      _id: treatmentId(created, eventType, carbs, insulin, occurrence),
      eventType,
      created_at: new Date(created).toISOString(),
      enteredBy: 'carelink-bridge',
      notes: 'carelink-marker',
    };
    if (carbs !== undefined) t.carbs = carbs;
    if (insulin !== undefined) t.insulin = insulin;
    out.treatments.push(t);
    return t;
  };

  /**
   * Take the bolus that best represents what the pump was told for this meal.
   *
   * A zero-amount INSULIN marker is a real marker (a prime, or a bolus the user
   * cancelled) but it is not a dose. Measured before this change: a meal
   * followed by `0 U` then `4 U` paired with the zero, so Nightscout recorded
   * a 45 g meal bolused 0 U while the actual 4 U appeared as an unrelated
   * correction. Only a POSITIVE bolus is eligible to pair; zero-amount markers
   * stay in the bucket and are reported by the leftover pass.
   */
  const takeBolus = (bucket: CareLinkMarker[] | undefined): CareLinkMarker | undefined => {
    if (!bucket || bucket.length === 0) return undefined;
    const i = bucket.findIndex((b) => {
      const v = num(b.amount) ?? num(b.value);
      return v !== undefined && v > 0;
    });
    return i < 0 ? undefined : bucket.splice(i, 1)[0];
  };

  for (const meal of meals) {
    const datable = markerTime(meal.index, alignedAnchor) !== null;
    // Only consume a bolus for a meal that actually reaches the output.
    // Otherwise an undatable meal swallowed a datable bolus and the insulin
    // vanished with no count anywhere.
    const bolus = datable ? takeBolus(insulinByIndex.get(meal.index as number)) : undefined;
    // `amount` is carbs on a MEAL and units on an INSULIN; the vendor's own
    // mapping reads them from the same field name (`docs` §P1.1).
    const carbs = num(meal.amount) ?? num(meal.value);
    const insulin = bolus ? num(bolus.amount) ?? num(bolus.value) : undefined;

    if (carbs === undefined && insulin === undefined) {
      // A meal with neither carbs nor a bolus would become a treatment that
      // asserts a meal happened while carrying no information about it. Count
      // it instead of writing an empty event.
      countUnmapped(`MEAL(${amountProblem(meal.amount ?? meal.value) ?? 'no amount'})`);
      continue;
    }
    if (bolus) {
      // A paired 0 g meal is a bolus with no carbs; writing `carbs: 0` would
      // assert a carb entry that does not exist.
      emit(meal, 'Meal Bolus', carbs === undefined || carbs === 0 ? undefined : round(carbs),
           insulin === undefined ? undefined : round(insulin));
    } else if (carbs !== undefined && carbs > 0) {
      // A meal with no bolus still happened; record the carbs.
      emit(meal, 'Carb Correction', round(carbs));
    } else {
      // 0 g of carbs corrects nothing and asserts nothing: an empty event.
      countUnmapped('MEAL(zero amount)');
    }
  }

  // Whatever boluses were left over are corrections. Iterate in index order so
  // the output is deterministic regardless of the wire order.
  for (const idx of [...insulinByIndex.keys()].sort((a, b) => a - b)) {
    for (const bolus of insulinByIndex.get(idx) ?? []) {
      const raw = bolus.amount ?? bolus.value;
      const insulin = num(raw);
      if (insulin === undefined) {
        countUnmapped(`INSULIN(${amountProblem(raw) ?? 'no amount'})`);
        continue;
      }
      if (insulin === 0) {
        // "0 U delivered" is not an event Nightscout should hold as a bolus;
        // it is a marker with no dose. Reported, not emitted.
        countUnmapped('INSULIN(zero amount)');
        continue;
      }
      emit(bolus, 'Correction Bolus', undefined, round(insulin));
    }
  }

  for (const m of others) {
    const t = String(m.type);
    if (BG_TYPES.has(t)) {
      const glucose = num(m.value) ?? num(m.amount);
      if (glucose === undefined) {
        countUnmapped(`${t}(${amountProblem(m.value ?? m.amount) ?? 'no value'})`);
        continue;
      }
      // Attach the glucose to the treatment emit() RETURNED — never to
      // `out.treatments[out.treatments.length - 1]`, which is the previous
      // event whenever this marker could not be dated.
      const treatment = emit(m, 'BG Check');
      if (treatment) {
        treatment.glucose = round(glucose);
        treatment.glucoseType = 'Finger';
      }
      continue;
    }
    // Declared in the vocabulary but never handled by the vendor either. Count
    // them so their existence is visible rather than silently swallowed.
    countUnmapped(t);
  }

  return out;
}
