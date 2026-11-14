/**
 * `carelink_stale` must track the STALE WATCHDOG, not just the stale-payload
 * branch.
 *
 * These are different conditions and only one of them was wired at first:
 *
 *   1. a payload CareLink serves that is itself hours old → `transform()` marks
 *      it stale and the loop sets the gauge. Covered.
 *   2. every fetch FAILING for hours (circuit open, network dead, auth broken,
 *      Nightscout unreachable) → `checkStale()` fires the STALE warning and the
 *      webhook, but the gauge was never touched, so it still read 0.
 *
 * The second is the likelier one in production and it is exactly the "flat green
 * graph means nothing" failure the metric was added to fix. A gauge reading
 * healthy while the watchdog is shouting is worse than no gauge.
 *
 * The first draft of this file re-implemented the predicate and then asserted on
 * its own copy — which would have passed even if `main.ts` never called
 * `setStale` at all. The logic now lives in `src/stale-watchdog.ts` so the test
 * exercises the real function, and the wiring in `main.ts` calls it.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { decideStale } from '../src/stale-watchdog.js';
import { setStale, renderPrometheus, reset } from '../src/metrics.js';

const THRESH = 15 * 60_000;
const NOW = 1_760_000_000_000;

function staleGauge(): number {
  const line = renderPrometheus()
    .split('\n')
    .find((l) => l.startsWith('carelink_stale '));
  expect(line, 'carelink_stale must appear in the exposition').toBeDefined();
  return Number(line!.split(' ')[1]);
}

describe('decideStale — the watchdog predicate', () => {
  it('is not stale 30s after a success', () => {
    expect(decideStale(NOW - 30_000, NOW, THRESH)).toEqual({
      stale: false,
      elapsedMs: 30_000,
    });
  });

  it('IS stale after 40 minutes with no successful fetch', () => {
    // The case that was missed: no payload arrives at all, so the stale-PAYLOAD
    // branch never runs, but the watchdog fires.
    const d = decideStale(NOW - 40 * 60_000, NOW, THRESH);
    expect(d.stale).toBe(true);
    expect(d.elapsedMs).toBe(40 * 60_000);
  });

  it('returns null — not false — when there has never been a success', () => {
    // A null must not be read as "fine": /healthz reports this as `degraded`,
    // and the gauge must not invent an age.
    expect(decideStale(null, NOW, THRESH)).toEqual({ stale: null, elapsedMs: null });
  });

  it('the threshold boundary is exclusive, matching the pre-existing watchdog', () => {
    expect(decideStale(NOW - THRESH, NOW, THRESH).stale).toBe(false);
    expect(decideStale(NOW - THRESH - 1, NOW, THRESH).stale).toBe(true);
  });

  it('a clock that jumps backwards does not produce a negative age', () => {
    // NTP step or DST handling could hand us a "success" in the future; the
    // watchdog must not then report a negative elapsed and never fire.
    expect(decideStale(NOW + 60_000, NOW, THRESH).elapsedMs).toBe(0);
  });

  it('honours a caller-supplied threshold rather than a baked-in default', () => {
    const custom = 2 * 60_000;
    expect(decideStale(NOW - 5 * 60_000, NOW, custom).stale).toBe(true);
    expect(decideStale(NOW - 5 * 60_000, NOW, THRESH).stale).toBe(false);
  });
});

describe('the gauge reflects the same decision', () => {
  beforeEach(() => reset());

  it('reads 1 when the watchdog says stale and 0 when it recovers', () => {
    const staleDecision = decideStale(NOW - 40 * 60_000, NOW, THRESH);
    setStale(staleDecision.stale!);
    expect(staleGauge()).toBe(1);

    const recovered = decideStale(NOW - 1_000, NOW, THRESH);
    setStale(recovered.stale!);
    expect(staleGauge()).toBe(0);
  });

  it('a never-succeeded bridge leaves the gauge at 0 rather than claiming stale', () => {
    // main.ts returns early on a null decision and never calls setStale.
    expect(decideStale(null, NOW, THRESH).stale).toBeNull();
    expect(staleGauge()).toBe(0);
  });
});
