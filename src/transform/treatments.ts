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
 * carries `index` (an integer slot, NOT a timestamp), `type`, `value`, and
 * optionally `deliverySuspended`. The timestamp is derived:
 *
 *     t = anchor − (287 − index) × 300_000 ms
 *
 * where `anchor` is the newest datapoint's time and 300 s is CareLink's slot
 * width. So a marker's time is only expressible relative to an anchor — a
 * marker array with no anchor cannot be dated, and this module refuses to
 * guess (see `resolveMarkers`).
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

/** Marker types the vendor's own client acts on, mapped to a Nightscout event. */
const MEAL_TYPES = new Set(['MEAL']);
const INSULIN_TYPES = new Set(['INSULIN']);
const BG_TYPES = new Set(['BG_READING', 'BG', 'CALIBRATION']);

/** CareLink's slot width: 287 slots of 5 minutes ≈ 24 h. */
export const MARKER_SLOT_MS = 300_000;
export const MARKER_LAST_SLOT = 287;

/**
 * Derive a marker's absolute time.
 *
 * `index` is a slot in a 288-slot window whose last slot (287) is the anchor.
 * Anything outside 0..287 is rejected rather than clamped: a negative offset
 * would silently move a marker into the future, which is the exact defect that
 * produced future-dated readings in another client (research repo `docs/10`,
 * timestamp semantics row).
 */
export function markerTime(index: unknown, anchorMs: number): number | null {
  if (typeof index !== 'number' || !Number.isFinite(index)) return null;
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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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
  const out: MarkerMappingResult = { treatments: [], unmapped: {}, undatable: 0 };
  if (!Array.isArray(markers) || markers.length === 0) return out;
  if (!Number.isFinite(anchorMs)) {
    // Every marker in the array is undatable; report the population rather than
    // silently returning nothing and looking like "no markers this fetch".
    out.undatable = markers.length;
    return out;
  }

  // A Map here silently LOST insulin: two INSULIN markers sharing an index
  // overwrote one another, so 3 U + 4 U was recorded as 4 U. Under-counting
  // delivered insulin is the dangerous direction for a dosing record, so the
  // boluses are kept as a LIST and consumed one at a time. Probed and confirmed
  // before the fix (7 U in, 4 U out).
  const insulinByIndex = new Map<number, CareLinkMarker[]>();
  const meals: CareLinkMarker[] = [];
  const others: CareLinkMarker[] = [];

  for (const raw of markers) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as CareLinkMarker;
    const t = m.type;
    if (typeof t !== 'string') continue;
    if (typeof m.index === 'number' && INSULIN_TYPES.has(t)) {
      const bucket = insulinByIndex.get(m.index);
      if (bucket) bucket.push(m);
      else insulinByIndex.set(m.index, [m]);
    } else if (typeof m.index === 'number' && MEAL_TYPES.has(t)) {
      meals.push(m);
    } else {
      others.push(m);
    }
  }

  // Sibling counter: how many times this exact (time, eventType, carbs,
  // insulin) tuple has already been emitted. Keeps identical markers distinct.
  const seen = new Map<string, number>();

  const emit = (m: CareLinkMarker, eventType: string, carbs?: number, insulin?: number) => {
    const created = markerTime(m.index, anchorMs);
    if (created === null) { out.undatable++; return; }
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
  };

  for (const meal of meals) {
    const bucket = insulinByIndex.get(meal.index as number);
    // Consume exactly ONE bolus per meal. A meal split across two markers, or a
    // second bolus at the same slot, must not be absorbed into the first.
    const bolus = bucket && bucket.length > 0 ? bucket.shift() : undefined;
    // `amount` is carbs on a MEAL and units on an INSULIN; the vendor's own
    // mapping reads them from the same field name (`docs` §P1.1).
    const carbs = num(meal.amount) ?? num(meal.value);
    const insulin = bolus ? num(bolus.amount) ?? num(bolus.value) : undefined;
    if (bolus) {
      emit(meal, 'Meal Bolus', carbs === undefined ? undefined : round(carbs),
           insulin === undefined ? undefined : round(insulin));
    } else {
      // A meal with no bolus still happened; record the carbs.
      emit(meal, 'Carb Correction', carbs === undefined ? undefined : round(carbs), undefined);
    }
  }

  // Whatever boluses were left over are corrections. Iterate in index order so
  // the output is deterministic regardless of the wire order.
  for (const idx of [...insulinByIndex.keys()].sort((a, b) => a - b)) {
    for (const bolus of insulinByIndex.get(idx) ?? []) {
      const insulin = num(bolus.amount) ?? num(bolus.value);
      if (insulin === undefined) { out.unmapped['INSULIN(no amount)'] =
        (out.unmapped['INSULIN(no amount)'] ?? 0) + 1; continue; }
      emit(bolus, 'Correction Bolus', undefined, round(insulin));
    }
  }

  for (const m of others) {
    const t = String(m.type);
    if (BG_TYPES.has(t)) {
      const glucose = num(m.value) ?? num(m.amount);
      if (glucose === undefined) { out.unmapped[`${t}(no value)`] =
        (out.unmapped[`${t}(no value)`] ?? 0) + 1; continue; }
      emit(m, 'BG Check', undefined, undefined);
      const last = out.treatments[out.treatments.length - 1];
      if (last) { last.glucose = round(glucose); last.glucoseType = 'Finger'; }
      continue;
    }
    // Declared in the vocabulary but never handled by the vendor either. Count
    // them so their existence is visible rather than silently swallowed.
    out.unmapped[t] = (out.unmapped[t] ?? 0) + 1;
  }

  return out;
}
