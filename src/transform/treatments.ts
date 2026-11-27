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
 * A marker's time from slot arithmetic, falling back to `relativeOffset`.
 *
 * ⚠ NOT STABLE ACROSS POLLS ON THE 780G — use only when the marker carries no
 * `dateTime` string.
 *
 * Measured 2026-11-27, the same 12 g meal marker fetched ~2 h 40 m apart:
 *
 *   capture   index   index-derived time   relativeOffset   dateTime
 *   15:22      228    10:27:04             -17726           10:27:37.000
 *   18:04      196    10:29:50             -27493           10:27:37.000
 *
 * The index moved 32 slots and the derived time by 166 s, while `dateTime` did
 * not move at all. `lastMedicalDeviceDataUpdateServerTime` — the anchor used
 * here — is not the clock the slot index is measured against, so the whole
 * calculation slides between fetches.
 *
 * That mattered: `treatmentId()` hashes the derived time, so a sliding anchor
 * minted a NEW `_id` for the same physical meal on every poll and Nightscout
 * appended duplicates instead of updating. Measured consequence — the dashboard
 * read **COB 15.1 g** because one 12 g meal had become two rows.
 *
 * `dateTime` is therefore preferred by the caller (`markerDateTime()` in
 * transform/index.ts). This function remains for payload shapes with no
 * `dateTime`, and for state markers (`index: -1`) as a last resort.
 */
export function markerTimeOrOffset(
  marker: CareLinkMarker,
  anchorMs: number,
): number | null {
  const bySlot = markerTime(marker.index, anchorMs);
  if (bySlot !== null) return bySlot;

  const offset = marker.relativeOffset;
  if (typeof offset === 'number' && Number.isFinite(offset) && Number.isFinite(anchorMs)) {
    // relativeOffset is SECONDS before the anchor (negative = in the past).
    const t = anchorMs + offset * 1000;
    // A future-dated marker is the defect this bridge already corrects for on
    // the CGM path; refuse rather than emit one.
    if (t <= anchorMs) return t;
  }
  return null;
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

/**
 * Units of insulin actually delivered by one INSULIN marker.
 *
 * TWO payload shapes exist and they must not be conflated:
 *
 *  - **BLE / NGP (780G, Instinct).** No `amount`/`value` at all. The dose is a
 *    pair of split amounts: `deliveredFastAmount` + `deliveredExtendedAmount`
 *    for a `COMBO` bolus. This is the shape the 780G actually sends, and the
 *    reason every bolus was previously counted as `INSULIN(no amount)` — the
 *    bridge looked in a field this route never populates.
 *
 *  - **Legacy / carepartner.** A single `amount` or `value`.
 *
 * **DELIVERED, never PROGRAMMED.** Measured 2026-11-27 on a real 780G: a bolus
 * was programmed at 4.4 U and delivered 1.85 U, because the pump raised
 * `BC_SID_ACTIVE_INSULIN_CLEARED_DUE_PUMP_ERROR` mid-bolus. The two differ by
 * 2.55 U. Writing the programmed figure would overstate IOB at the exact
 * moment the true figure matters, so `programmed*` is never used as a dose —
 * it is only ever the fallback when the delivered fields are absent, and then
 * only because a payload that reports nothing delivered yet is mid-bolus.
 */
function bolusDelivered(m: CareLinkMarker): number | undefined {
  const fast = num(m.deliveredFastAmount);
  const extended = num(m.deliveredExtendedAmount);

  // BLE shape: at least one delivered field present. `0` is meaningful here —
  // a pure square-wave bolus has deliveredFastAmount 0 and a real extended
  // amount, and a cancelled bolus has both zero — so treat presence, not
  // truthiness.
  if (m.deliveredFastAmount !== undefined || m.deliveredExtendedAmount !== undefined) {
    const total = (fast ?? 0) + (extended ?? 0);
    return total > 0 ? total : undefined;
  }

  // Mid-bolus on the BLE route: the delivered fields are absent because nothing
  // has been delivered yet, but the pump HAS been told an amount. Report the
  // programmed figure rather than dropping a bolus the user actually gave —
  // the next poll carries the delivered total and overwrites it, because the
  // treatment `_id` is derived from time and not from the amount.
  const programmedFast = num(m.programmedFastAmount);
  const programmedExtended = num(m.programmedExtendedAmount);
  if (programmedFast !== undefined || programmedExtended !== undefined) {
    const total = (programmedFast ?? 0) + (programmedExtended ?? 0);
    return total > 0 ? total : undefined;
  }

  // Legacy shape. A zero here is "0 U" — a prime or a cancelled bolus — which
  // is a marker with no dose, not a dose of nothing. Undefined routes it to the
  // zero-amount counter instead of emitting an empty bolus.
  const legacy = num(m.amount) ?? num(m.value);
  return legacy !== undefined && legacy > 0 ? legacy : undefined;
}

/**
 * How the event should be labelled from the pump's own bolus metadata.
 *
 * Kept in `notes` only — Nightscout's `eventType` vocabulary is closed and
 * inventing a type would break downstream filters. A stopped or incomplete
 * bolus is worth being able to find later, because it is the difference
 * between "I gave 4.4" and "the pump gave me 1.85".
 */
function bolusNote(m: CareLinkMarker): string | undefined {
  const parts: string[] = ['carelink-marker'];
  if (m.bolusType && m.bolusType !== 'FAST') parts.push(`bolus=${m.bolusType}`);
  if (m.activationType) parts.push(`activation=${m.activationType}`);
  if (m.completed === false) parts.push('INCOMPLETE');
  if (m.programmedDuration) parts.push(`extended=${m.programmedDuration}min`);

  // The shortfall is the clinically load-bearing part. A bolus programmed at
  // 4.4 U and delivered at 1.85 U explains a rise that no other field records.
  const programmed = (num(m.programmedFastAmount) ?? 0) + (num(m.programmedExtendedAmount) ?? 0);
  const delivered = (num(m.deliveredFastAmount) ?? 0) + (num(m.deliveredExtendedAmount) ?? 0);
  if (programmed > 0 && delivered >= 0 && Math.abs(programmed - delivered) > 0.01) {
    parts.push(`programmed=${round(programmed)}U delivered=${round(delivered)}U`);
  }
  return parts.join(' ');
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
  /**
   * Resolves a marker's absolute time. Injected so this module stays free of
   * `parsePumpTime` and the logger, which live in transform/index.ts.
   *
   * Defaults to slot arithmetic for callers (and tests) that have no pump clock
   * context — but every real caller should pass the `dateTime`-preferring
   * resolver, because slot arithmetic is unstable on the 780G. See
   * `markerTimeOrOffset` for the measurements.
   */
  resolveTime: (marker: CareLinkMarker) => number | null =
    (marker) => markerTimeOrOffset(marker, anchorMs),
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
    const created = resolveTime(m);
    if (created === null) { out.undatable++; return null; }
    const key = `${created}|${eventType}|${carbs ?? ''}|${insulin ?? ''}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const t: Record<string, unknown> = {
      _id: treatmentId(created, eventType, carbs, insulin, occurrence),
      eventType,
      created_at: new Date(created).toISOString(),
      // `timestamp` as well as `created_at`, because Loop requires it.
      //
      // LoopKit's `NightscoutTreatment.init?` guards on `entry["timestamp"] as
      // String` and is FAILABLE — it returns nil without it, so Loop silently
      // discards every treatment this bridge uploads. Nightscout itself never
      // synthesises the field: `lib/server/treatments.js` (v15.0.9) contains
      // zero writes of `timestamp`, so `created_at` alone is not enough.
      // AAPS is unaffected (it falls back `date ?: mills ?: timestamp ?:
      // created_at`, RemoteTreatment.kt:114), which is why this went unnoticed.
      // Same value as `created_at` deliberately: one event, one time.
      timestamp: new Date(created).toISOString(),
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
      const v = bolusDelivered(b);
      return v !== undefined && v > 0;
    });
    return i < 0 ? undefined : bucket.splice(i, 1)[0];
  };

  for (const meal of meals) {
    const datable = resolveTime(meal) !== null;
    // Only consume a bolus for a meal that actually reaches the output.
    // Otherwise an undatable meal swallowed a datable bolus and the insulin
    // vanished with no count anywhere.
    const bolus = datable ? takeBolus(insulinByIndex.get(meal.index as number)) : undefined;
    // `amount` is carbs on a MEAL and units on an INSULIN; the vendor's own
    // mapping reads them from the same field name (`docs` §P1.1).
    const carbs = num(meal.amount) ?? num(meal.value);
    const insulin = bolus ? bolusDelivered(bolus) : undefined;

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
      const t = emit(meal, 'Meal Bolus', carbs === undefined || carbs === 0 ? undefined : round(carbs),
           insulin === undefined ? undefined : round(insulin));
      if (t && bolus) {
        const note = bolusNote(bolus);
        if (note && note !== 'carelink-marker') t.notes = note;
      }
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
      const insulin = bolusDelivered(bolus);
      if (insulin === undefined) {
        // Name the reason precisely. "no amount" used to cover three different
        // failures, one of which — a BLE bolus carrying only the split
        // programmed/delivered amounts — was a total loss of insulin. Now the
        // counter says which of the three it actually was:
        //   zero amount  : the pump reported a dose of 0 (prime / cancelled)
        //   no amount    : no dose field at all, in any vocabulary
        const statedZero =
          bolus.deliveredFastAmount === 0 ||
          bolus.deliveredExtendedAmount === 0 ||
          bolus.programmedFastAmount !== undefined ||
          num(bolus.amount) === 0 ||
          num(bolus.value) === 0;
        countUnmapped(
          statedZero
            ? 'INSULIN(zero amount)'
            : `INSULIN(${amountProblem(bolus.amount ?? bolus.value) ?? 'no amount'})`,
        );
        continue;
      }
      const t = emit(bolus, 'Correction Bolus', undefined, round(insulin));
      if (t) {
        const note = bolusNote(bolus);
        if (note && note !== 'carelink-marker') t.notes = note;
      }
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
        // `units` because Loop requires it. `BGCheckNightscoutTreatment
        // .fromServer` reads `entry["units"] as String` and is failable, so
        // without this Loop discards every fingerstick as well as every carb
        // event. The value is what the bridge actually published: `glucose` has
        // already been normalised to mg/dL by `round(glucose)` off the raw
        // marker, which for a BG marker is always mg/dL in CareLink's own
        // vocabulary — a mmol/L account is converted on the SGV path, not here.
        treatment.units = 'mg/dL';
      }
      continue;
    }
    // Declared in the vocabulary but never handled by the vendor either. Count
    // them so their existence is visible rather than silently swallowed.
    //
    // ---- the three the 780G actually sends (measured 2026-11-27) ------------
    //
    // TIME_CHANGE, AUTO_MODE_STATUS and LOW_GLUCOSE_SUSPENDED all arrive on a
    // real NGP payload and were previously counted as unmapped and discarded.
    // Each one is a real event with a permanent meaning, and each explains a
    // glucose curve that otherwise has no cause recorded:
    //
    //  - TIME_CHANGE (the pump's clock was altered). Any refractory window is
    //    one of these, so a gap in treatment history that is really a clock
    //    edit looks like missing data forever.
    //  - AUTO_MODE_STATUS. SmartGuard switching on or off is the single most
    //    important context for reading a 780G trace, and from Monday it is what
    //    distinguishes "the algorithm did that" from "I did that".
    //  - LOW_GLUCOSE_SUSPENDED. Basal interrupted because of a predicted or
    //    actual low. This is an insulin DELIVERY event: without it, a rise
    //    after a suspend looks like under-bolusing.
    //
    // Written as a `Note` rather than an invented eventType, because
    // Nightscout's treatment vocabulary is closed and a novel type is dropped
    // by filters and by Loop's failable parser. A Note is permanent, greppable
    // and typed as free text by design — which is exactly what these are.
    if (t === 'TIME_CHANGE') {
      const prev = m.previousDateTime ? String(m.previousDateTime) : 'unknown';
      const note = emit(m, 'Note');
      if (note) note.notes = `pump clock changed (previous reading dated ${prev})`;
      continue;
    }
    if (t === 'AUTO_MODE_STATUS') {
      const note = emit(m, 'Note');
      if (note) {
        note.notes = `SmartGuard auto-mode ${m.autoModeOn === true ? 'ON' : 'OFF'}`;
      }
      continue;
    }
    if (t === 'LOW_GLUCOSE_SUSPENDED') {
      // `deliverySuspended` is the pump's own statement. Only the ACTIVE state
      // is an event worth recording; the "resumed" marker is the absence of
      // one, and writing both would double the note count without adding a
      // second fact.
      if (m.deliverySuspended !== true) {
        countUnmapped('LOW_GLUCOSE_SUSPENDED(resumed)');
        continue;
      }
      const note = emit(m, 'Note');
      if (note) note.notes = 'basal suspended — low glucose suspend triggered';
      continue;
    }

    countUnmapped(t);
  }

  return out;
}
