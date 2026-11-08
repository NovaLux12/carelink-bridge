import { describe, it, expect } from 'vitest';
import { data, makeSG } from './fixtures.js';
import { transform } from '../src/transform/index.js';
import { deviceIdentitySnapshot } from '../src/carelink/client.js';

/**
 * A BLE-endpoint payload carries the family under `deviceFamily` and may omit
 * `medicalDeviceFamily` entirely (#111). Before this fix, transform() threw
 * `Cannot read properties of undefined (reading 'toLowerCase')` on exactly
 * that shape — a total data outage on the first real Instinct/780G response.
 */
function blePayload(overrides: Record<string, unknown> = {}) {
  const base = data();
  // Delete rather than set undefined: the point is that the key is ABSENT.
  delete (base as Record<string, unknown>)['medicalDeviceFamily'];
  return { ...base, deviceFamily: 'INSTINCT', ...overrides } as typeof base;
}

describe('BLE payload shape (#111)', () => {
  it('does not throw when medicalDeviceFamily is absent', () => {
    expect(() => transform(blePayload())).not.toThrow();
  });

  it('names the device from deviceFamily when medicalDeviceFamily is absent', () => {
    const result = transform(blePayload());
    expect(result.devicestatus[0].device).toBe('connect-instinct');
    expect(result.entries[0].device).toBe('connect-instinct');
  });

  it('prefers medicalDeviceFamily when both are present (legacy shape unchanged)', () => {
    const result = transform(data({ deviceFamily: 'INSTINCT' }));
    expect(result.devicestatus[0].device).toBe('connect-paradigm');
  });

  it('falls back to a stable placeholder when neither family is present', () => {
    const payload = blePayload();
    delete (payload as Record<string, unknown>)['deviceFamily'];
    const result = transform(payload);
    expect(result.devicestatus[0].device).toBe('connect-unknown');
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('still emits glucose readings, not just a device status, on a BLE payload', () => {
    const payload = blePayload({
      bgunits: 'MMOL_L',
      sgs: [makeSG(7.2, 'Oct 17, 2015 09:09:00')],
    });
    const result = transform(payload);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sgv).toBe(130); // 7.2 * 18.0182 = 129.73 -> 130
  });

  it('takes the GUARDIAN device-status branch when the family arrives only as deviceFamily', () => {
    const payload = blePayload({ deviceFamily: 'GUARDIAN' });
    const result = transform(payload);
    // The GUARDIAN branch reports conduitBatteryLevel as the uploader battery
    // and has no `pump` block, unlike the pump branch.
    expect(result.devicestatus[0].pump).toBeUndefined();
    expect(result.devicestatus[0].device).toBe('connect-guardian');
  });
});

describe('deviceIdentitySnapshot (#111)', () => {
  it('captures the identity keys a payload actually carries', () => {
    const snapshot = deviceIdentitySnapshot(
      blePayload({ deviceModel: 'MMT-5420', sensorModel: 'MMT-5420' }) as never,
    );
    expect(snapshot).toEqual({
      deviceFamily: 'INSTINCT',
      deviceModel: 'MMT-5420',
      sensorModel: 'MMT-5420',
    });
  });

  it('omits absent, null and empty values rather than logging noise', () => {
    const snapshot = deviceIdentitySnapshot({
      deviceFamily: '',
      medicalDeviceFamily: null,
      deviceModel: 'MMT-1884',
    } as never);
    expect(snapshot).toEqual({ deviceModel: 'MMT-1884' });
  });

  it('never dumps glucose or alarm fields', () => {
    const snapshot = deviceIdentitySnapshot(blePayload() as never);
    expect(Object.keys(snapshot)).not.toContain('sgs');
    expect(Object.keys(snapshot)).not.toContain('lastSG');
    expect(Object.keys(snapshot)).not.toContain('lastAlarm');
  });

  it('tolerates undefined input', () => {
    expect(deviceIdentitySnapshot(undefined)).toEqual({});
  });
});

describe('display/message reading shape (#111)', () => {
  it('reads the time from `timestamp` when `datetime` is absent', () => {
    // The display/message route sends timestamp, not datetime. Dropping it
    // would silently mis-date every reading from that path.
    const payload = data({
      sgs: [
        { sg: 120, timestamp: 'Oct 17, 2015 09:09:00', version: 1, timeChange: false, kind: 'SG' },
      ],
    });
    const result = transform(payload);
    expect(result.entries).toHaveLength(1);
    expect(Number.isNaN(result.entries[0].date)).toBe(false);
    expect(result.entries[0].dateString).not.toBe(
      new Date(0).toISOString(),
    );
  });

  it('prefers `datetime` over `timestamp` when both are present', () => {
    // xDrip SensorGlucose.getDate() (SensorGlucose.java:31-36) returns
    // datetimeAsDate when non-null and only falls back to timestamp. An earlier
    // version of this bridge had the precedence backwards and claimed it
    // "matched the reference client" — it did not.
    const payload = data({
      sgs: [
        {
          sg: 120,
          timestamp: 'Jan 01, 2000 00:00:00',
          datetime: 'Oct 17, 2015 09:09:00',
          version: 1,
          timeChange: false,
          kind: 'SG',
        },
      ],
    });
    const result = transform(payload);
    expect(/2015/.test(result.entries[0].dateString)).toBe(true);
  });

  it('still reads `datetime` when `timestamp` is absent (legacy payload)', () => {
    const result = transform(data());
    expect(result.entries.length).toBeGreaterThan(0);
    expect(/2015/.test(result.entries[0].dateString)).toBe(true);
  });
});

describe('no device clock in payload (#114)', () => {
  // v13 display/message carries neither sMedicalDeviceTime nor
  // currentServerTime. Before this fix the offset became NaN, which
  // propagated into every reading's date, and timestampAsString() quietly
  // substituted new Date() — stamping every reading with the FETCH time.
  // Nightscout accepts that, so the failure is invisible and corrupts the
  // series. Reproduced: date NaN, dateString <now>.
  function noClockPayload(overrides: Record<string, unknown> = {}) {
    const base = data();
    delete (base as Record<string, unknown>)['sMedicalDeviceTime'];
    delete (base as Record<string, unknown>)['currentServerTime'];
    delete (base as Record<string, unknown>)['lastMedicalDeviceDataUpdateServerTime'];
    return {
      ...base,
      deviceFamily: 'INSTINCT',
      clientTimeZoneName: 'Europe/London',
      sgs: [
        { sg: 7.2, timestamp: 'Nov 8, 2026 01:30:00', version: 1, timeChange: false, kind: 'SG' },
      ],
      ...overrides,
    } as typeof base;
  }

  it('dates readings from their own timestamp, not from now', () => {
    const result = transform(noClockPayload());
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].dateString).toBe('2026-11-08T01:30:00.000Z');
  });

  it('never produces the current time', () => {
    const before = Date.now();
    const result = transform(noClockPayload());
    const stamped = result.entries[0].date;
    // Must be the reading's time, and must not be within a minute of now.
    expect(Math.abs(stamped - before)).toBeGreaterThan(60_000);
  });

  it('reports created_at from the newest reading, not from now', () => {
    const result = transform(noClockPayload());
    expect(result.devicestatus[0].created_at).toBe('2026-11-08T01:30:00.000Z');
  });

  it('skips the staleness gate rather than silently passing it on NaN', () => {
    // A payload with no device clock cannot be measured for staleness. It must
    // still yield entries — refusing the payload would discard good glucose.
    const result = transform(noClockPayload());
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('drops a reading whose time cannot be parsed at all', () => {
    const payload = noClockPayload({
      sgs: [
        { sg: 7.2, timestamp: 'not a date', version: 1, timeChange: false, kind: 'SG' },
        { sg: 6.8, timestamp: 'Nov 8, 2026 01:35:00', version: 1, timeChange: false, kind: 'SG' },
      ],
    });
    const result = transform(payload);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].dateString).toBe('2026-11-08T01:35:00.000Z');
  });

  it('still uses the device-clock offset when the payload HAS one', () => {
    // Legacy path must be unchanged: the offset correction still applies.
    const result = transform(data());
    expect(/2015/.test(result.entries[0].dateString)).toBe(true);
    expect(Number.isNaN(result.entries[0].date)).toBe(false);
  });
});
