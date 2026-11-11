import { describe, it, expect } from 'vitest';
import { CARELINK_TREND_TO_NIGHTSCOUT_TREND } from '../src/transform/trend-map.js';

/**
 * Nightscout's numeric trend scale, transcribed from the AUTHORITY, not from
 * prose: `cgm-remote-monitor/lib/server/pebble.js` `DIRECTIONS` on master —
 *
 *     NONE: 0, DoubleUp: 1, SingleUp: 2, FortyFiveUp: 3, Flat: 4,
 *     FortyFiveDown: 5, SingleDown: 6, DoubleDown: 7,
 *     'NOT COMPUTABLE': 8, 'RATE OUT OF RANGE': 9
 *
 * Cross-checked digit-for-digit against xDrip's
 * `Dex_Constants.TREND_ARROW_VALUES`, which is what Nightscout's own uploaders
 * emit. Both tables agree on every value below.
 *
 * NOTE this is NOT LoopKit's `GlucoseTrend` (upUpUp=1 … downDownDown=7). That
 * is a private 7-state ordinal; Loop reads the `direction` STRING from
 * Nightscout. Confusing the two is how a "1" ends up meaning TripleUp upstream
 * and DoubleUp here.
 */
const NIGHTSCOUT_TREND = {
  NONE: 0,
  DoubleUp: 1,
  SingleUp: 2,
  FortyFiveUp: 3,
  Flat: 4,
  FortyFiveDown: 5,
  SingleDown: 6,
  DoubleDown: 7,
  'NOT COMPUTABLE': 8,
  'RATE OUT OF RANGE': 9,
} as const;

describe('trend map: directions are Nightscout-known strings', () => {
  it('every direction is a key in Nightscout\'s own dir2Char table', () => {
    // lib/plugins/direction.js `dir2Char` is the complete set of direction
    // strings Nightscout will render. A typo here yields a '-' arrow in the UI
    // and a normalized-away value for API consumers — silent, not an error.
    const NS_DIRECTIONS = new Set([
      'NONE', 'TripleUp', 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat',
      'FortyFiveDown', 'SingleDown', 'DoubleDown', 'TripleDown',
      'NOT COMPUTABLE', 'RATE OUT OF RANGE',
    ]);
    for (const [carelink, mapped] of Object.entries(CARELINK_TREND_TO_NIGHTSCOUT_TREND)) {
      expect(NS_DIRECTIONS.has(mapped.direction), `${carelink} -> ${mapped.direction}`).toBe(true);
    }
  });

  it('no direction normalises to something else (no aliasing surprises)', () => {
    // Nightscout's direction-normalizer maps e.g. 'up' -> SingleUp. If one of
    // our strings were an alias rather than a canonical name, the injected
    // value and the rendered value would disagree.
    const ALIASES = new Set([
      'up', 'down', 'slideup', 'slidedown', 'slightup', 'slightdown', 'none',
      'tripleup', 'doubleup', 'singleup', 'fortyfiveup', 'flat', 'fortyfivedown',
      'singledown', 'doubledown', 'tripledown', 'notcomputable', 'rateoutofrange',
    ]);
    for (const mapped of Object.values(CARELINK_TREND_TO_NIGHTSCOUT_TREND)) {
      expect(ALIASES.has(mapped.direction.toLowerCase().replace(/[\s_-]+/g, ''))).toBe(true);
      // ...and it is the canonical spelling, i.e. it is already normalised.
      expect(mapped.direction).not.toBe(mapped.direction.toLowerCase());
    }
  });
});

describe('trend map: numeric values against Nightscout\'s table', () => {
  /** The five keys with an EXACT Nightscout representation. */
  const EXACT: Array<[string, number, string]> = [
    ['NONE', NIGHTSCOUT_TREND.Flat, 'Flat'],
    ['UP_DOUBLE', NIGHTSCOUT_TREND.DoubleUp, 'DoubleUp'],
    ['UP', NIGHTSCOUT_TREND.SingleUp, 'SingleUp'],
    ['DOWN', NIGHTSCOUT_TREND.SingleDown, 'SingleDown'],
    ['DOWN_DOUBLE', NIGHTSCOUT_TREND.DoubleDown, 'DoubleDown'],
  ];

  it.each(EXACT)('%s -> {trend:%i, direction:%s}', (key, trend, direction) => {
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND[key]).toEqual({ trend, direction });
  });

  it('NONE maps to Flat/4, not to NONE/0', () => {
    // The pre-fix value {0, 'NONE'} was inherited from upstream domien-f and was
    // wrong on both halves: Nightscout's 0 means "no trend at all" (and is what
    // its own pebble endpoint uses as the *default*), while CareLink's NONE
    // means a real, measured "no change" reading. Flat=4 is that measurement.
    // A consumer reading 0 sees a missing trend; one reading 4 sees a flat line.
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['NONE']).toEqual({ trend: 4, direction: 'Flat' });
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['NONE'].trend).not.toBe(NIGHTSCOUT_TREND.NONE);
  });

  it('no key maps to 0, 8 or 9 — those mean "no trend", "not computable", "out of range"', () => {
    for (const [key, mapped] of Object.entries(CARELINK_TREND_TO_NIGHTSCOUT_TREND)) {
      expect([0, 8, 9], `${key} -> ${mapped.trend}`).not.toContain(mapped.trend);
    }
  });

  it('no key maps to 3 or 5 — CareLink has no 45° trend', () => {
    // CareLink's lastSGTrend vocabulary is NONE/UP/UP_DOUBLE/UP_TRIPLE/DOWN/
    // DOWN_DOUBLE/DOWN_TRIPLE. Bare directional steps only. 3 and 5 must stay
    // unused: mapping UP to 3 would overstate it as FortyFiveUp.
    const used = new Set(Object.values(CARELINK_TREND_TO_NIGHTSCOUT_TREND).map((m) => m.trend));
    expect(used.has(NIGHTSCOUT_TREND.FortyFiveUp)).toBe(false);
    expect(used.has(NIGHTSCOUT_TREND.FortyFiveDown)).toBe(false);
  });

  it('direction sign agrees with trend sign across the whole table', () => {
    // Guards against a right integer with a wrong string (or vice versa) —
    // e.g. {6, 'SingleUp'} would pass any single-field check.
    for (const [key, mapped] of Object.entries(CARELINK_TREND_TO_NIGHTSCOUT_TREND)) {
      const rising = /Up$/.test(mapped.direction);
      const falling = /Down$/.test(mapped.direction);
      if (rising) expect(mapped.trend, key).toBeLessThan(NIGHTSCOUT_TREND.Flat);
      else if (falling) expect(mapped.trend, key).toBeGreaterThan(NIGHTSCOUT_TREND.Flat);
      else expect(mapped.trend, key).toBe(NIGHTSCOUT_TREND.Flat);
    }
  });
});

describe('trend map: the two TRIPLE keys have no exact Nightscout integer', () => {
  /**
   * Nightscout's 0-9 scale has NO digit for a triple arrow. The STRINGS exist
   * ('TripleUp' in direction.js dir2Char, 'TripleDown' likewise, and AAPS'
   * TrendArrow.TRIPLE_UP/TEXT is "TripleUp"), but the integer stops at
   * DoubleDown=7. So 1 and 7 are the nearest available and are what
   * nightscout-connect emits. Pinned so the compromise is deliberate and
   * visible rather than mistaken for an exact mapping.
   */
  it('UP_TRIPLE keeps the TripleUp string but borrows DoubleUp\'s integer', () => {
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['UP_TRIPLE']).toEqual({
      trend: NIGHTSCOUT_TREND.DoubleUp,
      direction: 'TripleUp',
    });
    // The string is in Nightscout's vocabulary; the integer is not its own.
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['UP_TRIPLE'].trend)
      .toBe(CARELINK_TREND_TO_NIGHTSCOUT_TREND['UP_DOUBLE'].trend);
  });

  it('DOWN_TRIPLE keeps the TripleDown string but borrows DoubleDown\'s integer', () => {
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['DOWN_TRIPLE']).toEqual({
      trend: NIGHTSCOUT_TREND.DoubleDown,
      direction: 'TripleDown',
    });
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['DOWN_TRIPLE'].trend)
      .toBe(CARELINK_TREND_TO_NIGHTSCOUT_TREND['DOWN_DOUBLE'].trend);
  });

  it('the triples never claim a *larger* magnitude than the doubles', () => {
    // The failure mode to avoid is understating, i.e. mapping a triple to Flat
    // or to 0. Equal-magnitude is the documented compromise; less-than would be
    // a bug.
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['UP_TRIPLE'].trend)
      .toBeLessThanOrEqual(CARELINK_TREND_TO_NIGHTSCOUT_TREND['UP_DOUBLE'].trend);
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['DOWN_TRIPLE'].trend)
      .toBeGreaterThanOrEqual(CARELINK_TREND_TO_NIGHTSCOUT_TREND['DOWN_DOUBLE'].trend);
  });
});

describe('trend map: shape', () => {
  it('has exactly the seven CareLink keys, no extras and none missing', () => {
    expect(Object.keys(CARELINK_TREND_TO_NIGHTSCOUT_TREND).sort()).toEqual(
      ['DOWN', 'DOWN_DOUBLE', 'DOWN_TRIPLE', 'NONE', 'UP', 'UP_DOUBLE', 'UP_TRIPLE'],
    );
  });

  it('every entry has exactly the two Nightscout fields', () => {
    for (const [key, mapped] of Object.entries(CARELINK_TREND_TO_NIGHTSCOUT_TREND)) {
      expect(Object.keys(mapped).sort(), key).toEqual(['direction', 'trend']);
      expect(Number.isInteger(mapped.trend), key).toBe(true);
      expect(typeof mapped.direction, key).toBe('string');
    }
  });

  it('an unrecorded trend token is simply absent (callers must not invent one)', () => {
    // The transform does `if (trendData)` and otherwise leaves the SGV without
    // a trend. That is correct: a missing arrow is honest, an invented one is
    // what makes Loop/AAPS misjudge direction.
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['UP_45']).toBeUndefined();
    expect(CARELINK_TREND_TO_NIGHTSCOUT_TREND['NOT_COMPUTABLE']).toBeUndefined();
  });
});
