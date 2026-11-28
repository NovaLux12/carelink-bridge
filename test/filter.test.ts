import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeRecencyFilter,
  MAX_FUTURE_SKEW_MS,
  DEFAULT_STALL_RESET_MS,
  DEFAULT_FORWARD_WINDOW_MS,
  BACKFILL_WINDOW_MS,
} from '../src/filter.js';
import * as logger from '../src/logger.js';

const H = 3_600_000;
const MIN = 60_000;

interface FakeEntry {
  type: string;
  someDateKey: number;
}

function sgv(date: number): FakeEntry {
  return { type: 'sgv', someDateKey: date };
}

/** Capture console.log lines so the warning contract can be asserted. */
function capture(fn: () => void): string[] {
  const captured: string[] = [];
  const orig = console.log;
  (console as unknown as { log: (...a: unknown[]) => void }).log = (...a: unknown[]) => {
    captured.push(a.map((x) => String(x)).join(' '));
  };
  try {
    fn();
  } finally {
    (console as unknown as { log: typeof console.log }).log = orig;
  }
  return captured;
}

beforeEach(() => {
  logger.setLogFormat('json');
  logger.setVerbose(false); // warns must be visible WITHOUT verbose
});
afterEach(() => {
  logger.setLogFormat('pretty');
});

describe('makeRecencyFilter() — duplicate suppression (the original contract)', () => {
  it('should return a stateful filter which discards items older than the most recent one seen', () => {
    // Timestamps are real time in the past so the plausibility bound is not the
    // thing doing the work here. They must also sit inside the forward window:
    // an item older than that is treated as debris, not as a late arrival.
    const base = Date.now() - 2 * H;
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);

    expect(filter([2, 3, 4].map(n => sgv(base + n)))).toHaveLength(3);

    expect(filter([2, 3, 4].map(n => sgv(base + n)))).toHaveLength(0);

    const filtered = filter([2, 3, 4, 8, 6, 7, 5].map(n => sgv(base + n)));
    expect(filtered).toHaveLength(4);
    const dates = filtered.map((f) => f.someDateKey - base);
    for (const val of [5, 6, 7, 8]) {
      expect(dates).toContain(val);
    }
  });

  it('suppresses an exact duplicate still present on the next poll', () => {
    const base = Date.now() - 2 * H;
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);

    expect(filter([sgv(base), sgv(base + 300_000)])).toHaveLength(2);
    expect(filter([sgv(base), sgv(base + 300_000)])).toHaveLength(0);
    expect(filter([sgv(base), sgv(base + 300_000), sgv(base + 600_000)])).toHaveLength(1);
  });
});

describe('makeRecencyFilter() — a late arrival is recovered, not discarded', () => {
  // The regression this file exists for, reproduced from a live 780G.
  //
  // CareLink returns a fixed 288-slot (~24 h) ring buffer and fills empty slots
  // RETROSPECTIVELY — measured 2026-11-28: a slot absent from the 10:25 poll was
  // present at 10:36. The filter used to forward only `t > mark`, so a reading
  // published behind a newer one could never be sent: 8 of 235 readings in 24 h
  // never reached Nightscout, two of them below the low target.
  it('forwards a reading the source publishes after a newer one has already gone', () => {
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });
    const t0 = now - 30 * MIN;

    // Two consecutive polls, 5 min apart, one reading each.
    expect(filter([sgv(t0)])).toHaveLength(1);
    now += 5 * MIN;
    expect(filter([sgv(t0 + 5 * MIN)])).toHaveLength(1);

    // 02:20-shaped: t0+5min was sent, then CareLink backfills a slot BETWEEN
    // the two — the exact case the old high-water mark swallowed.
    now += 5 * MIN;
    const late = filter([sgv(t0 + 2 * MIN)]);
    expect(late).toHaveLength(1);
    expect(late[0].someDateKey).toBe(t0 + 2 * MIN);

    // ...and it is not sent again on the following poll.
    now += 5 * MIN;
    expect(filter([sgv(t0 + 2 * MIN)])).toHaveLength(0);
  });

  it('recovers a late arrival even after several newer readings have gone', () => {
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });
    const t0 = now - 2 * H;

    // Ten polls forward, so the late reading is far behind the frontier.
    for (let i = 0; i < 10; i++) {
      now += 5 * MIN;
      expect(filter([sgv(t0 + i * 5 * MIN)])).toHaveLength(1);
    }

    now += 5 * MIN;
    expect(filter([sgv(t0 + 3 * MIN)])).toHaveLength(1);
  });

  it('does not re-post a whole window when nothing new arrived', () => {
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });
    const base = now - H;
    const window = [0, 1, 2, 3, 4, 5].map(i => sgv(base + i * 5 * MIN));

    expect(filter(window)).toHaveLength(6);
    // The same window again — every item is already-forwarded, so nothing goes,
    // even though every item is comfortably inside the forward window.
    expect(filter(window)).toHaveLength(0);
    expect(filter([...window, sgv(base + 6 * 5 * MIN)])).toHaveLength(1);
  });

  it('treats a timestamp older than the window as debris, not as a late arrival', () => {
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      forwardWindowMs: 6 * H,
    });

    expect(filter([sgv(now - 7 * H)])).toHaveLength(0);
    // Just inside the bound still passes.
    expect(filter([sgv(now - 5 * H)])).toHaveLength(1);
  });

  it('evicts and re-forwards consistently — eviction never re-posts the window', () => {
    // The two halves of the window bound must agree. If eviction were tighter
    // than the forwardable test, the first poll after eviction would re-post a
    // window, on every poll, for ever.
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      forwardWindowMs: 1 * H,
    });
    const t = now - 50 * MIN;

    expect(filter([sgv(t)])).toHaveLength(1);
    // Age it past the window on both sides, then bring the timestamp back into
    // range by doing nothing but letting the clock advance past it.
    now += 90 * MIN;
    expect(filter([sgv(t)])).toHaveLength(0); // outside the window: debris
    expect(filter([sgv(t + 90 * MIN)])).toHaveLength(1);
  });
});

describe('makeRecencyFilter() — future-dated reading must not poison the horizon', () => {
  it('does not drop every subsequent genuine reading after one future-dated item', () => {
    const base = Date.now() - 2 * H;
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);

    expect(filter([sgv(base + 1000), sgv(base + 2000)])).toHaveLength(2);

    // The poison: one reading a year in the future. Inside no plausible bound.
    const poison = Date.now() + 365 * 24 * H;
    expect(filter([sgv(poison)])).toHaveLength(0);

    // The old filter emitted this AND set the mark beyond now, so everything
    // below returned []. That is the regression under test.
    expect(filter([sgv(base + 3000), sgv(base + 4000)])).toHaveLength(2);
    expect(filter([sgv(base + 3000), sgv(base + 4000)])).toHaveLength(0);
    expect(filter([sgv(base + 5000)])).toHaveLength(1);
  });

  it('logs the rejection with the value and the bound — never silent', () => {
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { label: 'sgv' });
    const poison = Date.now() + 365 * 24 * H;

    const lines = capture(() => {
      expect(filter([sgv(poison)])).toHaveLength(0);
    });

    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('warn');
    expect(rec.msg).toMatch(/future bound/);
    expect(rec.label).toBe('sgv');
    expect(rec.discarded).toBe(1);
    expect(rec.boundHours).toBe(26);
    expect(new Date(rec.newestDiscarded).getTime()).toBe(poison);
  });

  it('accepts a reading skewed forward by a mis-set pump clock, but caps the mark at now', () => {
    // A pump set 3 h fast is a real scenario, not a theoretical one: pump
    // clocks do not auto-DST-adjust. Inside 26 h, so it is data, not a fault.
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
    });

    const skewed = now + 3 * H;
    expect(filter([sgv(skewed)])).toHaveLength(1);
    // ...but only once — the mark is capped at now, so the set is what stops it
    // being re-posted on every following poll.
    expect(filter([sgv(skewed)])).toHaveLength(0);

    // A genuine, past-dated reading still flows. Under the OLD behaviour this
    // returned [] because lastTime was now + 3 h.
    expect(filter([sgv(now - MIN)])).toHaveLength(1);
  });

  it('accepts exactly the 26 h bound and rejects one millisecond beyond it', () => {
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });

    expect(filter([sgv(now + MAX_FUTURE_SKEW_MS)])).toHaveLength(1);

    const beyond = now + MAX_FUTURE_SKEW_MS + 1;
    const lines = capture(() => {
      expect(filter([sgv(beyond)])).toHaveLength(0);
    });
    expect(lines).toHaveLength(1);
  });

  it('bounds the mark so a poisoned filter cannot outlive the skew', () => {
    // Two future items inside the bound, one beyond it, then real data.
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });

    expect(filter([sgv(now + 20 * H), sgv(now + 40 * H)])).toHaveLength(1);
    expect(filter([sgv(now - 5 * MIN)])).toHaveLength(1);
  });
});

describe('makeRecencyFilter() — backwards clock jump', () => {
  it('recovers when the pump clock is corrected backwards past the window', () => {
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      stallResetMs: 30 * MIN,
    });
    const base = now - 2 * H;

    expect(filter([sgv(base + 10 * MIN)])).toHaveLength(1);

    // A pump clock corrected backwards by EIGHT hours — not DST, which the
    // interval forward window now absorbs on its own (see the test below), but
    // the operator-corrected-a-mis-set-clock case the reset still exists for.
    // Everything the source now publishes is behind the window.
    const rewound = now - 9 * H;
    for (let i = 0; i < 3; i++) {
      now += 5 * MIN;
      expect(filter([sgv(rewound), sgv(rewound + 5 * MIN)])).toHaveLength(0);
    }

    // Past the stall window the filter resynchronises and data flows again.
    now += 30 * MIN;
    const lines = capture(() => {
      expect(filter([sgv(rewound + 10 * MIN)])).toHaveLength(1);
    });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('warn');
    expect(rec.msg).toMatch(/resynchronising/);
    expect(rec.stalledForSeconds).toBeGreaterThanOrEqual(1800);

    // ...and suppression resumes against the re-anchored floor, rather than
    // re-posting the same reading every poll.
    expect(filter([sgv(rewound + 10 * MIN)])).toHaveLength(0);
    expect(filter([sgv(rewound + 15 * MIN)])).toHaveLength(1);
  });

  it('absorbs a one-hour DST fall-back without needing the reset at all', () => {
    // A consequence worth pinning: the forward window removes the DST case from
    // protection 3's job. Readings an hour behind are inside the window, so they
    // are forwarded as ordinary late arrivals and no resync is required.
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      stallResetMs: 30 * MIN,
    });

    expect(filter([sgv(now - 10 * MIN)])).toHaveLength(1);

    now += 5 * MIN;
    const earlier = now - H - 10 * MIN; // one hour, plus the 5 min just elapsed
    const lines = capture(() => {
      expect(filter([sgv(earlier)])).toHaveLength(1);
    });
    expect(lines).toHaveLength(0); // no warning: this is not a stall
  });

  it('does not resynchronise on duplicate-only or empty polls', () => {
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      stallResetMs: 30 * MIN,
    });
    const base = now - 2 * H;

    expect(filter([sgv(base)])).toHaveLength(1);

    // Four polls over four hours: repeats, then an empty one, then a repeat.
    // None of them is evidence that the window is wrong, so none may warn.
    const lines = capture(() => {
      now += 60 * MIN;
      expect(filter([sgv(base)])).toHaveLength(0);
      now += 60 * MIN;
      expect(filter([sgv(base)])).toHaveLength(0);
      now += 60 * MIN;
      expect(filter([])).toHaveLength(0);
      now += 60 * MIN;
      expect(filter([sgv(base)])).toHaveLength(0);
    });
    expect(lines).toHaveLength(0);
  });

  it('does not forward from the window a rejected future item would have set', () => {
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });
    const base = now - 2 * H;

    expect(filter([sgv(base)])).toHaveLength(1);
    expect(filter([sgv(now + 100 * H)])).toHaveLength(0);
    // The genuine next reading still flows.
    expect(filter([sgv(base + 5 * MIN)])).toHaveLength(1);
  });
});

describe('makeRecencyFilter() — unusable timestamps are reported, not swallowed', () => {
  it('warns and drops items whose time is NaN (e.g. an unparseable created_at)', () => {
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);
    const lines = capture(() => {
      expect(filter([{ type: 'sgv', someDateKey: Number.NaN }])).toHaveLength(0);
    });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.msg).toMatch(/unusable timestamp/);
    expect(rec.discarded).toBe(1);
  });
});

describe('makeRecencyFilter() — constants', () => {
  it('uses xDrip’s 26 h ceiling, not an invented number', () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(26 * H);
  });

  it('uses a stall window that is several missed readings, not one poll', () => {
    expect(DEFAULT_STALL_RESET_MS).toBe(30 * MIN);
    expect(vi.isFakeTimers()).toBe(false);
  });

  it('uses a forward window that covers the observed lateness with headroom', () => {
    // 6 h = 72 consecutive 5-minute slots. The observed lateness that motivated
    // this was ~11 min; the window is not a tuning knob for that, it is the
    // boundary between "late arrival" and "debris". Anything wider than the
    // payload's own extent (SGV_LIMIT after the filter) buys nothing.
    expect(DEFAULT_FORWARD_WINDOW_MS).toBe(6 * H);
    expect(BACKFILL_WINDOW_MS).toBe(DEFAULT_FORWARD_WINDOW_MS);
  });
});
