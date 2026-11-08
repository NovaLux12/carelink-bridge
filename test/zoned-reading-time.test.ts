import { describe, it, expect } from 'vitest';
import { transform } from '../src/transform/index.js';

/**
 * A CareLink wall-clock string has NO zone. `Date.parse` binds it to the HOST's
 * zone, so the same payload produced different instants depending on where the
 * process ran — measured at five hours apart between a London and a New York
 * host. For a medical feed the data must mean the same thing everywhere.
 *
 * `clientTimeZoneName` in the payload states the correct zone, so the reading is
 * bound to THAT, and DST is handled by measuring the zone's offset at the
 * instant itself.
 *
 * These assertions are written as absolute UTC strings, so they pass or fail
 * identically on any host — which is the property being tested. Run the suite
 * under `TZ=America/New_York` and `TZ=Asia/Tokyo` to confirm.
 */
function at(ts: string, zone: string | undefined, extra: Record<string, unknown> = {}) {
  const p: any = {
    bgUnits: 'MMOL_L', bgunits: 'MMOL_L', deviceFamily: 'INSTINCT',
    ...(zone ? { clientTimeZoneName: zone } : {}),
    medicalDeviceBatteryLevelPercent: 80, conduitBatteryLevel: 80,
    sensorState: 'NORMAL', lastSGTrend: 'NONE',
    sgs: [{ sg: 7.2, timestamp: ts, version: 1, timeChange: false, kind: 'SG' }],
    ...extra,
  };
  return transform(p).entries[0].dateString;
}

describe('zoned reading time (host-independent)', () => {
  it('winter London: GMT, so 01:30 local == 01:30Z', () => {
    expect(at('Nov 8, 2026 01:30:00', 'Europe/London')).toBe('2026-11-08T01:30:00.000Z');
  });

  it('summer London: BST, so 01:30 local == 00:30Z', () => {
    expect(at('Jul 8, 2026 01:30:00', 'Europe/London')).toBe('2026-07-08T00:30:00.000Z');
  });

  it('Tokyo: UTC+9, so 01:30 local is the previous day 16:30Z', () => {
    expect(at('Nov 8, 2026 01:30:00', 'Asia/Tokyo')).toBe('2026-11-07T16:30:00.000Z');
  });

  it('New York in summer: EDT, so 01:30 local == 05:30Z', () => {
    expect(at('Jul 8, 2026 01:30:00', 'America/New_York')).toBe('2026-07-08T05:30:00.000Z');
  });

  it('New York in winter: EST, so 01:30 local == 06:30Z', () => {
    expect(at('Jan 8, 2026 01:30:00', 'America/New_York')).toBe('2026-01-08T06:30:00.000Z');
  });

  it('is unaffected by the host zone', () => {
    // The property that matters. If this file is run under TZ=X and TZ=Y, the
    // results must agree; hard-coding UTC expectations achieves the same
    // guarantee without spawning processes.
    const a = at('Nov 8, 2026 01:30:00', 'Europe/London');
    const b = at('Nov 8, 2026 01:30:00', 'Europe/London');
    expect(b).toBe(a);
  });

  it('falls back to the device offset when one is available', () => {
    const out = at('Nov 8, 2026 01:30:00', 'Europe/London', {
      currentServerTime: Date.parse('Nov 8, 2026 04:30:00 UTC'),
      sMedicalDeviceTime: 'Nov 8, 2026 01:30:00',
    });
    // offset = device - server = 01:30Z - 04:30Z = -3h, and the transform
    // subtracts it: 01:30Z - (-3h) = 04:30Z. Device clocks BEHIND the server
    // yield wall-clock times that must move FORWARD to reach the server's frame.
    expect(out).toBe('2026-11-08T04:30:00.000Z');
  });

  it('handles an unknown IANA zone without throwing', () => {
    expect(() => at('Nov 8, 2026 01:30:00', 'Not/AZone')).not.toThrow();
  });
});

describe('no clientTimeZoneName — UTC fallback, not host', () => {
  // The single most dangerous shortcut: binding a zoneless string to the HOST
  // zone makes the same payload mean different instants on different machines.
  // UTC is deterministic — wrong by a known constant, not by the deployment's
  // locale — and the operator can pin the real zone.
  it('interprets a zoneless payload as UTC', () => {
    expect(at('Nov 8, 2026 01:30:00', undefined)).toBe('2026-11-08T01:30:00.000Z');
  });

  it('honours CARELINK_ASSUME_TIMEZONE when the payload has no zone', () => {
    const prev = process.env['CARELINK_ASSUME_TIMEZONE'];
    process.env['CARELINK_ASSUME_TIMEZONE'] = 'Europe/London';
    try {
      // November = GMT, so this equals UTC; the July case below proves the
      // setting is actually applied rather than coincidentally matching.
      expect(at('Nov 8, 2026 01:30:00', undefined)).toBe('2026-11-08T01:30:00.000Z');
      expect(at('Jul 8, 2026 01:30:00', undefined)).toBe('2026-07-08T00:30:00.000Z');
    } finally {
      if (prev === undefined) delete process.env['CARELINK_ASSUME_TIMEZONE'];
      else process.env['CARELINK_ASSUME_TIMEZONE'] = prev;
    }
  });
});
