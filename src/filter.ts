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

/**
 * How far back a timestamp may be and still be forwarded.
 *
 * THE DEFECT THIS BOUND FIXES. Before this, the filter kept a single
 * high-water mark and forwarded only `t > mark`. That cannot express "already
 * forwarded", so any reading that the source publishes LATE — after something
 * newer has already gone through — was discarded for ever. CareLink does
 * exactly that: `display/message` returns a fixed 288-slot (~24 h) ring buffer
 * and fills empty slots retrospectively. Measured on a live account
 * (2026-11-28): a slot absent from one poll was present 11 minutes later, and
 * 8 of 235 readings across 24 h never reached Nightscout, two of them below the
 * low target — with every fetch reporting success and zero restarts.
 *
 * The mark was also the reason a late arrival sometimes *did* appear: if the
 * late reading happened to still be newer than the mark it passed, which made
 * backfill look like a feature that half worked. It was never deliberate.
 *
 * So the filter now holds the timestamps it has forwarded, and forwards
 * anything not in that set which is newer than `now - lastAgedOutMs`. The
 * window is bounded deliberately: an unbounded set is a memory leak over a
 * 24/7 process, and Nightscout's own dedupe is on `(sysTime, type)` so the cost
 * of re-sending is an idempotent upsert — but an entry evicted from the set
 * MUST also become forwardable again, or the two halves disagree and a poll
 * after eviction re-posts a whole window. Both sides use this one constant.
 *
 * 6 h, not the ring buffer's 24 h. A marker-dated entry (`dateTime`, a full ISO
 * string) does not drift, but the slot-arithmetic fallback can land an entry a
 * slot or two off its neighbours, and `transform()` applies `SGV_LIMIT` after
 * the filter — so a window wider than the payload's own extent buys nothing.
 * Six hours is 72 consecutive 5-minute slots: far more than any observed
 * lateness, and small enough that the set stays in the hundreds of entries.
 */
export const DEFAULT_FORWARD_WINDOW_MS = 6 * HOUR_MS;

/** The constant to document; kept as an alias so the window reads naturally. */
export const BACKFILL_WINDOW_MS = DEFAULT_FORWARD_WINDOW_MS;

export interface RecencyFilterOptions {
  /**
   * Clock, injectable so the stall reset can be tested without waiting 30 min.
   * Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /** Override MAX_FUTURE_SKEW_MS. Tests only. */
  readonly maxFutureMs?: number;
  /** Override `DEFAULT_STALL_RESET_MS`. Tests only. */
  readonly stallResetMs?: number;
  /**
   * Override `DEFAULT_FORWARD_WINDOW_MS` — how far back a timestamp may be and
   * still be forwarded. Tests only; a real deployment should not shorten it,
   * because that is the range in which a late reading is recovered.
   */
  readonly forwardWindowMs?: number;
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
  const forwardWindowMs = options.forwardWindowMs ?? DEFAULT_FORWARD_WINDOW_MS;
  const label = options.label ?? 'recency-filter';

  /**
   * Timestamps already forwarded, and so to be suppressed while they remain in
   * the window. Replaces the single high-water mark, which could not tell
   * "already sent" from "older than something I sent" and therefore dropped
   * every late arrival for ever.
   *
   * Bounded by `forwardWindowMs` on BOTH sides: an entry is pruned once it is
   * older than `now - forwardWindowMs`, and the forwardable test is the same
   * bound. Keeping those two uses of one constant is what stops the pair
   * disagreeing — if eviction were tighter than the test, the first poll after
   * eviction would re-post a window, every poll, for ever.
   */
  const forwarded = new Set<number>();
  /**
   * A floor the stall reset (protection 3) has moved back to the source's own
   * timestamps, or -Infinity when normal windowing applies.
   *
   * `floor` is derived from `now`, so a backwards clock jump would otherwise
   * suppress the feed for ever: every timestamp the source publishes is behind
   * `now - forwardWindowMs` and there is nothing left to re-anchor to. The reset
   * sets this to the source's newest timestamp, and because the effective floor
   * is the MINIMUM of the two, it decays on its own — as wall-clock time
   * advances, `now - forwardWindowMs` overtakes it and normal windowing resumes
   * without a second decision.
   *
   * Starts at +Infinity so that until a reset happens `Math.min` selects the
   * ordinary window. A `-Infinity` here would make every timestamp forwardable
   * on the first poll, which is the opposite of bounding anything.
   */
  let resyncedFloor = Infinity;
  /**
   * Timestamps in (now, now + maxFutureMs] that have ALREADY been forwarded.
   *
   * Needed because the forwardable horizon is capped at `now` (protection 2):
   * without this, an accepted future-dated reading stays forwardable on every
   * poll and would be re-posted indefinitely. Keeping the cap and this small
   * set gives both properties — future data is sent once, and the horizon can
   * never run ahead of real time. Pruned each poll as time passes the entry, so
   * it holds at most one rolling window of skewed timestamps.
   */
  const forwardedFuture = new Set<number>();
  /**
   * When the current run of "items returned but nothing newer than anything
   * already forwarded" started, or null when normal progress is being made.
   * Deliberately NOT persisted: a restart rebuilds it from the first poll, and
   * a fresh process starts with an empty set, which cannot be stuck above the
   * source.
   */
  let stalledSince: number | null = null;

  return function recencyFilter(items: T[]): T[] {
    const nowMs = now();
    const horizon = nowMs + maxFutureMs;
    // Oldest timestamp still worth forwarding. A late arrival inside this
    // window is genuine data the source has only just published; outside it,
    // the source is presumed to have moved on and the entry is debris. The
    // stall reset can lower it (see `resyncedFloor`).
    const floor = Math.min(nowMs - forwardWindowMs, resyncedFloor);

    const out: T[] = [];
    let newestAccepted = -Infinity;
    let newestSeen = -Infinity;
    let newestRejected = -Infinity;
    let futureRejected = 0;
    let invalid = 0;
    let tooOld = 0;

    // Prune anything that has aged out of the window, on both sets, so memory
    // is bounded over a 24/7 process. `floor` is the same bound the forwardable
    // test below uses — see the note on `forwarded`.
    for (const t of forwarded) {
      if (t < floor) forwarded.delete(t);
    }
    // Entries in the future window that real time has now passed are no longer
    // "future" — the ordinary set covers them from here on.
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
        // repeat of the same instant, which is what keeps the horizon's cap
        // from turning one skewed reading into a permanent re-post.
        if (forwardedFuture.has(t)) continue;
        forwardedFuture.add(t);
        out.push(item);
        continue;
      }
      // The fix: "not already forwarded and still inside the window", rather
      // than "newer than the newest thing I ever sent". A slot the source
      // backfills behind newer readings now passes on the poll that carries it.
      if (t < floor) {
        tooOld++;
        continue;
      }
      if (forwarded.has(t)) continue;
      forwarded.add(t);
      out.push(item);
      if (t > newestAccepted) newestAccepted = t;
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
      // Protection (2): the forwardable horizon may not run past real time. A
      // future-dated item is forwarded above, but it cannot move the horizon;
      // a genuine past-dated reading therefore passes as soon as the readings'
      // own timestamps reach the cap, instead of being suppressed for as long
      // as the skew lasted.
      return out;
    }

    // Nothing forwarded. That is normal when the poll is empty or every item
    // has already been sent; only "items arrived, and every one of them is
    // behind the window" is evidence that the window — not the source — is
    // wrong.
    if (items.length === 0 || !Number.isFinite(newestSeen)) return out;
    // Anything inside the window was either forwarded above or already known,
    // so there is nothing stale to recover from.
    if (newestSeen >= floor) return out;

    if (stalledSince === null) {
      stalledSince = nowMs;
      return out;
    }
    if (nowMs - stalledSince < stallResetMs) return out;

    // Protection (3): resynchronise to what the source is publishing. Without
    // this, a backwards clock jump (DST fall-back, or an operator correcting a
    // fast pump) leaves every timestamp behind the window and suppresses the
    // feed until the clock catches up — silently, and possibly for days.
    //
    // Note the timestamps themselves are still the source's, and a backwards
    // jump means new readings can collide with already-uploaded ones; Nightscout
    // upserts on (sysTime, type), so the stored value is corrected rather than
    // duplicated. Timestamp correctness is the transform's job, not this
    // filter's — here we only stop losing data.
    const previousFloor = iso(floor);
    const stalledForMs = nowMs - stalledSince;
    stalledSince = null;
    // Re-anchor to the source. Without this the recovery would be a no-op: the
    // floor is `now - forwardWindowMs`, and after a backwards jump every
    // timestamp the source publishes is behind it.
    resyncedFloor = Math.min(newestSeen, nowMs);

    logger.warn(
      'No ' + label + ' item inside the ' + Math.round(forwardWindowMs / HOUR_MS) +
        'h forward window for ' + Math.round(stalledForMs / 1000) +
        's — resynchronising to the source',
      {
        label,
        stalledForSeconds: Math.round(stalledForMs / 1000),
        previousFloor,
        sourceNewest: iso(newestSeen),
        now: iso(nowMs),
      },
    );

    const resumed: T[] = [];
    for (const item of items) {
      const t = timeFn(item);
      if (!Number.isFinite(t) || t > horizon) continue;
      // Skip what is already known so a resync does not re-post the window on
      // the poll after this one, then RECORD what is forwarded — without the
      // record, the resumed item looks new again on every subsequent poll.
      if (t > nowMs) {
        if (forwardedFuture.has(t)) continue;
        forwardedFuture.add(t);
      } else {
        if (forwarded.has(t)) continue;
        forwarded.add(t);
      }
      resumed.push(item);
    }
    return resumed;
  };
}
