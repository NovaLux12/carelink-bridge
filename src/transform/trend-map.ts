/**
 * CareLink `lastSGTrend` → Nightscout `{trend, direction}`.
 *
 * ── ORACLE ────────────────────────────────────────────────────────────────
 * Nightscout's numeric trend scale is defined in its own server code, not in
 * prose: `cgm-remote-monitor/lib/server/pebble.js` `DIRECTIONS` (master):
 *
 *      NONE: 0, DoubleUp: 1, SingleUp: 2, FortyFiveUp: 3, Flat: 4,
 *      FortyFiveDown: 5, SingleDown: 6, DoubleDown: 7,
 *      'NOT COMPUTABLE': 8, 'RATE OUT OF RANGE': 9
 *
 * Independently confirmed by xDrip's `Dex_Constants.TREND_ARROW_VALUES`
 * (`NONE(0) DOUBLE_UP(1) SINGLE_UP(2) UP_45(3) FLAT(4) DOWN_45(5)
 * SINGLE_DOWN(6) DOUBLE_DOWN(7) NOT_COMPUTABLE(8) OUT_OF_RANGE(9)`), which is
 * what Nightscout's own uploaders emit. Both agree on every digit used below.
 *
 * NOT the same scale as LoopKit's `GlucoseTrend` (upUpUp=1 … downDownDown=7):
 * that is a 7-state ordinal, not the 0-9 Nightscout scale, and Loop reads the
 * `direction` STRING from Nightscout rather than the integer. This is why the
 * `direction` string is the field that must be right, and the integer is the
 * one that silently misleads: `trend` is what Nightscout's pebble/watch
 * clients and any consumer parsing the integer will act on.
 *
 * ── PER-KEY VERDICTS ─────────────────────────────────────────────────────
 *   NONE        → {4, Flat}        RIGHT. Nightscout Flat is 4. The pre-fix
 *                                  {0, 'NONE'} was inherited from upstream and
 *                                  was wrong (0 is CareLink's "no reading",
 *                                  not "no change").
 *   UP_DOUBLE   → {1, DoubleUp}    RIGHT. Verbatim against the oracle.
 *   UP          → {2, SingleUp}    RIGHT.
 *   DOWN        → {6, SingleDown}  RIGHT.
 *   DOWN_DOUBLE → {7, DoubleDown}  RIGHT.
 *   UP_TRIPLE   → {1, TripleUp}    NO EXACT REPRESENTATION — 1 is the closest,
 *                                  and it is what nightscout-connect emits.
 *                                  Nightscout's 0-9 scale has no TripleUp
 *                                  digit; the string `TripleUp` is known
 *                                  (`lib/plugins/direction.js` dir2Char maps it
 *                                  to '⤊', and AAPS' `TrendArrow.TRIPLE_UP`
 *                                  text is `"TripleUp"`), but there is no
 *                                  integer for it. 1 (DoubleUp) is the
 *                                  nearest, so a consumer reading only
 *                                  `trend` understates a triple rise as a
 *                                  double. Left as-is: inventing 0 or 8 would
 *                                  be a larger lie, and the direction string
 *                                  carries the truth.
 *   DOWN_TRIPLE → {7, TripleDown}  NO EXACT REPRESENTATION — same reasoning,
 *                                  mirrored; 7 is DoubleDown.
 *
 * Also worth knowing: `UP_TRIPLE`/`DOWN_TRIPLE` have never been OBSERVED on
 * the wire. The recorded `lastSGTrend` vocabulary from a 2,961-record real
 * dataset is {NONE, DOWN, UP, DOWN_DOUBLE, UP_DOUBLE}
 * (carelink-api-research/findings-log/probe-2026-10-08/
 * APP-EMULATION-RESEARCH.md §"Also from the same dataset"), and the DP area
 * measured 6 distinct values across 41,049 occurrences. So the two triple keys
 * are speculative-but-harmless defensive entries.
 *
 * CareLink has no 45°-up/45°-down trend, so no key maps to 3 or 5. That is a
 * property of the source vocabulary, not a gap.
 */
export const CARELINK_TREND_TO_NIGHTSCOUT_TREND: Record<string, { trend: number; direction: string }> = {
  NONE: { trend: 4, direction: 'Flat' },
  UP_TRIPLE: { trend: 1, direction: 'TripleUp' },
  UP_DOUBLE: { trend: 1, direction: 'DoubleUp' },
  UP: { trend: 2, direction: 'SingleUp' },
  DOWN: { trend: 6, direction: 'SingleDown' },
  DOWN_DOUBLE: { trend: 7, direction: 'DoubleDown' },
  DOWN_TRIPLE: { trend: 7, direction: 'TripleDown' },
};
