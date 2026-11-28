# 0012 — Forward by a bounded window, not a high-water mark

## Status

Proposed (2026-11-28). Supersedes the single-high-water-mark behaviour that
`src/filter.ts` has carried since it was written, while keeping its three
named protections.

## Context

CareLink's `display/message` endpoint returns a **fixed 288-slot ring buffer**
(≈24 h of 5-minute slots). Slots the pump had no reading for come back as
`sg === 0` with a `sensorState` such as `NO_DATA_FROM_PUMP`, and — critically —
**CareLink fills those slots retrospectively**. Measured on a live 780G account
on 2026-11-28: a slot absent from the 10:25 poll was present at 10:36.

The bridge's recency filter was a single high-water mark: it forwarded an item
only when `item.time > mark`. That predicate cannot express "I have already sent
this"; it expresses "this is newer than the newest thing I ever sent". So a
reading published *behind* an already-forwarded reading could never be sent.

Measured consequence, same account, 24 h window:

| | Count |
|---|---|
| Readings CareLink held | 235 |
| Never reached Nightscout | **8** (3.4%) |
| Of those, at or below the 4.0 target | **2** |
| Fetch failures during the window | 0 |
| Restarts during the window | 0 |

The same defect explains an observation that had been read as a feature working
half the time: a late arrival *did* appear whenever it happened to still be
newer than the mark. Backfill was never implemented; it was leakage through a
predicate that is not the predicate anyone wanted.

This matters clinically rather than cosmetically. A reading below the target that
never reaches Nightscout is invisible to every downstream consumer — the
dashboard, `ns-alert`, any Loop/AAPS instance, and the weekly review.

## Decision

The filter keeps **the set of timestamps it has forwarded**, not a mark, and
forwards an item when it is not in that set and is newer than
`now - DEFAULT_FORWARD_WINDOW_MS` (6 h).

The window is bounded on **both** sides by the same constant: entries older than
the floor are evicted, and the floor is also the forwardable bound. Keeping the
two uses in agreement is what prevents the failure mode where eviction is
tighter than the test — which would re-post a whole window on every poll, for
ever.

Three consequences that are load-bearing:

1. **The stall reset (protection 3) is now a floor re-anchor.** The floor derives
   from `now`, so a clock jump backwards of more than the window leaves nothing
   forwardable. The reset sets `resyncedFloor` to the source's newest timestamp;
   the effective floor is the minimum of the two, so it decays on its own as
   wall-clock time advances. Without this the "recovery" would be a no-op and the
   feed would stay suppressed — which is exactly what a first implementation of
   this ADR did, caught by the DST test.
2. **The forward window absorbs ordinary DST.** A one-hour fall-back is now an
   inside-the-window late arrival, not a stall. Protection 3 is retained for the
   much larger backwards jump (an operator correcting a badly mis-set pump clock).
3. **The future-dated cap is unchanged.** Readings ahead of `now` are still
   forwarded once and cannot move the horizon past real time.

6 h is chosen as "obviously more than any observed lateness, obviously less than
the ring buffer". The widest lateness measured was ~11 min. It is not a tuning
constant for that figure; it is the boundary between "late arrival" and "debris",
and anything wider than the payload's own extent buys nothing because
`transform()` applies `SGV_LIMIT` after the filter.

## Consequences

- **Easier:** a late reading is recovered automatically, with no operator action
  and no backfill job. The failure became "a reading may arrive a few minutes
  late", which is what the data already looks like.
- **Harder:** the filter holds state proportional to the window. At one reading
  per 5 min and a 6 h window that is ~72 numbers per feed, two feeds. Negligible,
  but it is no longer O(1) and the pruning loop must run.
- **Harder:** correctness now depends on `timeFn` returning a stable value per
  item across polls. A timestamp recomputed from a drifting anchor would mint a
  "new" entry identity every poll and re-send. This is already a hard
  requirement of the transform (`dateTime`, never slot arithmetic), and the
  treatment-id scheme documents the same trap, but the filter now shares the
  assumption rather than being immune to it.
- **Tradeoff:** a re-sent item relies on Nightscout's `(sysTime, type)` upsert
  to be idempotent. That is the same trade the filter's header already documents
  as the safe direction to err in.
- **Not addressed:** nothing recovers readings older than the window, readings
  the pump never produced, or readings already discarded before this shipped.
  Those 8 are gone.

**What would justify reversing this decision:** evidence that `timeFn` is not
stable across polls, which would turn the set into a duplicate generator; or
Nightscout's upsert key changing such that a re-send appends instead of
replacing. Either would make the mark the safer choice again, at the cost of the
late-arrival loss this ADR exists to remove.

## Notes

- Implemented in `src/filter.ts` (`DEFAULT_FORWARD_WINDOW_MS`, `resyncedFloor`,
  the `forwarded` set).
- Regression tests: `test/filter.test.ts` — the
  `a late arrival is recovered, not discarded` block, which includes a test that
  eviction and the forwardable test agree.
- Related: the treatment path already dates markers from `marker.dateTime`
  precisely because a drifting anchor mints duplicate ids. Same class of bug,
  opposite symptom.
- Field evidence and the full 24 h reconciliation:
  `~/.hermes/profiles/islet/workspace/knowledge/medical/diabetes/carelink-feed-gaps.md`
  (outside this repo).
