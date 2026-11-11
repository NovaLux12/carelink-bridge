import * as logger from './logger.js';

/**
 * Recency filter — the de-duplication stage between CareLink and Nightscout.
 *
 * PURPOSE. CareLink serves a rolling window (≈24 h of readings) on every poll,
 * so without a high-water mark every poll would re-post the whole window. The
 * filter keeps the newest timestamp it has forwarded and drops anything at or
 * behind it.
 *
 * THE DEFECT THIS FILE NOW GUARDS AGAINST. The mark used to be unbounded and
 * had no reset: one timestamp dated in the future — the exact class the
 * research corpus documents, where a skewed offset produces future-dated
 * readings that xDrip rejects with "bgreading is too far in the future"
 * (carelink-api-research `docs/10-open-questions.md`, "Timestamp semantics
 * generally", client (b) CarlosJPV) — pushed `lastTime` beyond real time, and
 * from then on EVERY genuine reading (all of which are in the past) was
 * dropped. Silently, for ever, with no log line. The CGM feed into Nightscout
 * simply stopped.
 *
 * Three separate protections now apply, and they are independent on purpose:
 *
 *   1. A plausibility bound (MAX_FUTURE_SKEW_MS). A timestamp further in the
 *      future than that is a clock FAULT, not a time zone, and is dropped with
 *      a visible warning carrying the value, the bound and the current time.
 *   2. The mark never advances past `now`. A source clock's claim about the
 *      future is not evidence that the future has been forwarded, and letting
 *      it define the suppression horizon is precisely the bug. A future-dated
 *      reading still gets sent (it may be genuine data from a mis-set pump
 *      clock), but it cannot set the horizon. Cost of the cap: while data is
 *      future-skewed the same reading can be re-sent on the next poll — see
 *      the note on duplicates below.
 *   3. A stall reset. If the source keeps answering with items yet produces
 *      nothing newer than the mark for DEFAULT_STALL_RESET_MS, the mark is
 *      wrong (backwards clock jump: DST fall-back, or a manual pump-clock
 *      correction) and is resynchronised to the source instead of stalling the
 *      feed until the clock catches up — which, for a pump set days fast, is
 *      days.
 *
 * WHY DUPLICATES ARE THE SAFE DIRECTION TO ERR IN. Nightscout upserts entries
 * on `(sysTime, type)` and silently drops duplicate devicestatus `_id`s
 * (src/nightscout/upload.ts), so a re-sent item is an UPDATE, not a second row.
 * A dropped item, by contrast, is data the pump has left behind for ever. Every
 * trade-off below therefore prefers "may re-send" over "may drop".
 */

const HOUR_MS = 3_600_000;

/**
 * How far in the future a timestamp may be and still be treated as data.
 *
 * 26 h is xDrip's own ceiling for "possibly a different time zone": it applies
 * a whole-hour correction only when `diffInHour != 0 && diffInHour < 26`
 * (CareLinkClient.correctTimeInRecentData / correctTimeInDisplayMessage). This
 * repository already adopts that number for the same reason in
 * src/transform/pump-offset.ts (MAX_OFFSET_HOURS) — one bound, one source, not
 * a second invented constant.
 *
 * Why a bound is needed at all: real UTC offsets top out at ±14 h, one DST
 * transition is 1 h, the offset rounding in pump-offset.ts absorbs ±7.5 min,
 * and a pump clock can genuinely be mis-set by hours (pump clocks do not
 * auto-DST-adjust — carelink-api-research findings-log/medtronic-carelink-
 * 2026-07-21 §P0.3). All of those fit comfortably inside 26 h. A timestamp
 * beyond it is not explained by any of them: it is a clock fault, and trusting
 * it is worse than refusing it.
 */
export const MAX_FUTURE_SKEW_MS = 26 * HOUR_MS;

/**
 * How long the source may keep answering without producing anything newer than
 * the mark before the mark is treated as wrong and resynchronised.
 *
 * CareLink's finest slot is 300 s and SGVs are produced every ~5 min
 * (src/transform/treatments.ts MARKER_SLOT_MS; the rolling window is ≈24 h), so
 * 30 min is six missed readings. A duplicate-only poll resolves within ONE
 * poll — the next reading is newer — so six consecutive polls of items with
 * nothing new is no longer a duplicate window; the mark is above the data.
 *
 * The reset loses nothing: the source re-sends its whole rolling window on the
 * next poll, so re-asserting that window is a subset of data CareLink is still
 * publishing.
 */
export const DEFAULT_STALL_RESET_MS = 30 * 60_000;

export interface RecencyFilterOptions {
  /**
   * Clock, injectable so the stall reset can be tested without waiting 30 min.
   * Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /** Override MAX_FUTURE_SKEW_MS. Tests only. */
  readonly maxFutureMs?: number;
  /** Override DEFAULT_STALL_RESET_MS. Tests only. */
  readonly stallResetMs?: number;
  /** Names the feed in log lines, e.g. "entries" / "devicestatus". */
  readonly label?: string;
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'none';
}

export function makeRecencyFilter<T>(
  timeFn: (item: T) => number,
  options: RecencyFilterOptions = {},
): (items: T[]) => T[] {
  const now = options.now ?? Date.now;
  const maxFutureMs = options.maxFutureMs ?? MAX_FUTURE_SKEW_MS;
  const stallResetMs = options.stallResetMs ?? DEFAULT_STALL_RESET_MS;
  const label = options.label ?? 'recency-filter';

  let lastTime = 0;
  /**
   * Timestamps in (now, now + maxFutureMs] that have ALREADY been forwarded.
   *
   * Needed because the mark is capped at `now` (protection 2): without this, an
   * accepted future-dated reading stays "newer than the mark" on every poll and
   * would be re-posted indefinitely. Keeping the cap and this small set gives
   * both properties — future data is sent once, and the suppression horizon can
   * never run ahead of real time. Pruned each poll as time passes the entry, so
   * it holds at most one rolling window of skewed timestamps.
   */
  const forwardedFuture = new Set<number>();
  /**
   * When the current run of "items returned but nothing newer than the mark"
   * started, or null when the mark is being advanced normally. Deliberately
   * NOT persisted: a restart rebuilds it from the first poll, and a fresh
   * process starts with lastTime = 0, which cannot be stuck above the source.
   */
  let stalledSince: number | null = null;

  return function recencyFilter(items: T[]): T[] {
    const nowMs = now();
    const horizon = nowMs + maxFutureMs;

    const out: T[] = [];
    let newestAccepted = -Infinity;
    let newestSeen = -Infinity;
    let newestRejected = -Infinity;
    let futureRejected = 0;
    let invalid = 0;

    // Entries in the future window that real time has now passed are no longer
    // "future" — the ordinary mark covers them from here on.
    for (const t of forwardedFuture) {
      if (t <= nowMs) forwardedFuture.delete(t);
    }

    for (const item of items) {
      const t = timeFn(item);
      if (!Number.isFinite(t)) {
        // Previously dropped in silence by `NaN > lastTime === false`. Same
        // defect class as the future-date poison: data disappearing with no
        // trace. Counted and reported below; still not forwarded, because a
        // timestamp that is not a number cannot be positioned in time.
        invalid++;
        continue;
      }
      if (t > newestSeen) newestSeen = t;
      if (t > horizon) {
        futureRejected++;
        if (t > newestRejected) newestRejected = t;
        continue;
      }
      if (t > nowMs) {
        // Inside the plausibility bound but ahead of real time. Forward it —
        // it may be genuine data from a mis-set pump clock — but suppress a
        // repeat of the same instant, which is what keeps the mark's cap from
        // turning one skewed reading into a permanent re-post.
        if (forwardedFuture.has(t)) continue;
        forwardedFuture.add(t);
        out.push(item);
        continue;
      }
      if (t > lastTime) {
        out.push(item);
        if (t > newestAccepted) newestAccepted = t;
      }
    }

    if (futureRejected > 0) {
      logger.warn(
        'Discarding ' + futureRejected + ' ' + label + ' timestamp(s) beyond the ' +
          maxFutureMs / HOUR_MS + 'h future bound — treating as a clock fault, not a time zone',
        {
          label,
          discarded: futureRejected,
          newestDiscarded: iso(newestRejected),
          boundHours: maxFutureMs / HOUR_MS,
          now: iso(nowMs),
        },
      );
    }

    if (invalid > 0) {
      logger.warn('Discarding ' + invalid + ' ' + label + ' item(s) with an unusable timestamp', {
        label,
        discarded: invalid,
      });
    }

    if (out.length > 0) {
      stalledSince = null;
      // Protection (2): the mark may not advance past real time. A future-dated
      // item is forwarded above, but it cannot make the horizon outrun the
      // clock; a genuine past-dated reading therefore passes on the next poll
      // (or as soon as the readings' own timestamps reach the cap), instead of
      // being suppressed for as long as the skew lasted.
      lastTime = Math.max(lastTime, Math.min(newestAccepted, nowMs));
      return out;
    }

    // Nothing forwarded. That is normal when the poll is empty or every item is
    // an exact duplicate; only "items arrived, all strictly behind the mark"
    // is evidence about the mark.
    if (items.length === 0 || !Number.isFinite(newestSeen)) return out;
    if (newestSeen >= lastTime) return out; // equality = exact duplicates

    if (stalledSince === null) {
      stalledSince = nowMs;
      return out;
    }
    if (nowMs - stalledSince < stallResetMs) return out;

    // Protection (3): resynchronise to what the source is publishing. Without
    // this, a backwards clock jump (DST fall-back, or an operator correcting a
    // fast pump) leaves the mark in the future of the data and suppresses the
    // feed until the clock catches up — silently, and possibly for days.
    //
    // Note the timestamps themselves are still the source's, and a backwards
    // jump means new readings can collide with already-uploaded ones; Nightscout
    // upserts on (sysTime, type), so the stored value is corrected rather than
    // duplicated. Timestamp correctness is the transform's job, not this
    // filter's — here we only stop losing data.
    const previousMark = lastTime;
    const stalledForMs = nowMs - stalledSince;
    lastTime = Math.max(0, Math.min(newestSeen, nowMs));
    stalledSince = null;

    logger.warn(
      'No ' + label + ' item newer than the high-water mark for ' +
        Math.round(stalledForMs / 1000) + 's — resynchronising the mark to the source',
      {
        label,
        stalledForSeconds: Math.round(stalledForMs / 1000),
        previousMark: iso(previousMark),
        sourceNewest: iso(newestSeen),
        now: iso(nowMs),
      },
    );

    const resumed: T[] = [];
    for (const item of items) {
      const t = timeFn(item);
      if (!Number.isFinite(t) || t > horizon) continue;
      resumed.push(item);
    }
    return resumed;
  };
}
