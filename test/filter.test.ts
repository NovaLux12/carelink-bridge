import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeRecencyFilter,
  MAX_FUTURE_SKEW_MS,
  DEFAULT_STALL_RESET_MS,
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
    // thing doing the work here.
    const base = Date.now() - 10 * H;
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
    const base = Date.now() - 10 * H;
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);

    expect(filter([sgv(base), sgv(base + 300_000)])).toHaveLength(2);
    expect(filter([sgv(base), sgv(base + 300_000)])).toHaveLength(0);
    expect(filter([sgv(base), sgv(base + 300_000), sgv(base + 600_000)])).toHaveLength(1);
  });
});

describe('makeRecencyFilter() — future-dated reading must not poison the mark', () => {
  it('does not drop every subsequent genuine reading after one future-dated item', () => {
    const base = Date.now() - 10 * H;
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);

    expect(filter([sgv(base + 1000), sgv(base + 2000)])).toHaveLength(2);

    // The poison: one reading a year in the future. Inside no plausible bound.
    const poison = Date.now() + 365 * 24 * H;
    expect(filter([sgv(poison)])).toHaveLength(0);

    // The old filter emitted this AND set lastTime beyond now, so everything
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
  it('recovers when a DST fall-back / manual correction moves the source backwards', () => {
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      stallResetMs: 30 * MIN,
    });
    const base = now - 10 * H;

    expect(filter([sgv(base + 10 * MIN)])).toHaveLength(1);

    // The pump clock is corrected backwards by an hour: everything the source
    // now publishes is behind the mark. A filter without recovery suppresses
    // the feed until the wall clock catches up.
    const rewound = base - 50 * MIN;
    for (let i = 0; i < 3; i++) {
      now += 5 * MIN;
      expect(filter([sgv(rewound), sgv(rewound + 5 * MIN)])).toHaveLength(0);
    }

    // Past the stall window the mark resynchronises and data flows again.
    now += 30 * MIN;
    const lines = capture(() => {
      expect(filter([sgv(rewound + 10 * MIN)])).toHaveLength(1);
    });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('warn');
    expect(rec.msg).toMatch(/resynchronising/);
    expect(rec.stalledForSeconds).toBeGreaterThanOrEqual(1800);

    // ...and duplicate suppression resumes from the new mark.
    expect(filter([sgv(rewound + 10 * MIN)])).toHaveLength(0);
    expect(filter([sgv(rewound + 15 * MIN)])).toHaveLength(1);
  });

  it('does not reset on a single duplicate-only poll', () => {
    let now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, {
      now: () => now,
      stallResetMs: 30 * MIN,
    });
    const base = now - 10 * H;

    expect(filter([sgv(base)])).toHaveLength(1);
    // Duplicates: newestSeen === lastTime, which is NOT a stall.
    now += 60 * MIN;
    expect(filter([sgv(base)])).toHaveLength(0);
    now += 60 * MIN;
    expect(filter([sgv(base)])).toHaveLength(0);
    // Empty polls are not a stall either.
    now += 60 * MIN;
    expect(filter([])).toHaveLength(0);
    now += 60 * MIN;
    // Still suppressed, and the mark never moved.
    expect(filter([sgv(base + 1)])).toHaveLength(1);
  });

  it('does not advance the mark from a rejected future item', () => {
    const now = Date.now();
    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey, { now: () => now });
    const base = now - 10 * H;

    expect(filter([sgv(base)])).toHaveLength(1);
    expect(filter([sgv(now + 100 * H)])).toHaveLength(0);
    // The genuine next reading is still newer than the mark.
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
});
