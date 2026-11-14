/**
 * The stale-watchdog decision, extracted so it can be tested.
 *
 * It lived inline in `src/main.ts`, which is a top-level script that starts a
 * fetch loop on import and therefore cannot be unit-tested. That is the same
 * shape as the v0.4.0 gate defect: the file that decides whether things are
 * healthy was the one file with no coverage, so a wrong decision in it survived
 * a green suite.
 *
 * There are two DIFFERENT conditions in play and conflating them is what let
 * `carelink_stale` read 0 while the watchdog was shouting:
 *
 *   1. The payload CareLink served is itself old  → `transform()` refuses it and
 *      returns `stale: true`. Handled in the loop.
 *   2. Every fetch is failing, so no payload arrives at all → only the watchdog
 *      notices.
 *
 * Both must move the gauge. This module owns condition 2.
 */

export interface StaleDecision {
  /**
   * Whether the data is stale. `null` means "no opinion": the bridge has never
   * had a successful fetch, so it has no age to compare against. Callers must
   * not treat null as false — `/healthz` reports that case as `degraded`, which
   * is the honest signal.
   */
  stale: boolean | null;
  /** Age of the last success in ms, or null when there has never been one. */
  elapsedMs: number | null;
}

/**
 * @param lastSuccessTimestamp epoch ms of the last successful fetch, or null
 * @param nowMs                current time, injected so tests are deterministic
 * @param staleThresholdMs     age past which the data counts as stale
 */
export function decideStale(
  lastSuccessTimestamp: number | null,
  nowMs: number,
  staleThresholdMs: number,
): StaleDecision {
  if (lastSuccessTimestamp === null) return { stale: null, elapsedMs: null };
  const elapsedMs = Math.max(0, nowMs - lastSuccessTimestamp);
  // Strictly greater, matching the pre-existing watchdog: exactly at the
  // threshold is not yet stale.
  return { stale: elapsedMs > staleThresholdMs, elapsedMs };
}
