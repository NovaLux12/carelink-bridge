import { describe, it, expect } from 'vitest';
import { data } from './fixtures.js';
import { transform } from '../src/transform/index.js';

/**
 * The wire has TWO spellings for sensor age, depending on payload generation
 * (xDrip RecentData.java:112-113 vs :146-147):
 *
 *   legacy RecentData : sensorDurationHours,        timeToNextCalibHours
 *   v13 display/message: sensorDurationMinutes,     timeToNextCalibrationMinutes
 *
 * They sit in different blocks; `clientTimeZoneName` is in the MINUTES block,
 * so a v13 payload sends the minutes pair and omits the hours pair. Reading
 * only `*Hours` yields `undefined` for sensor age on exactly the device this
 * bridge is being prepared for.
 *
 * Nightscout's connect block is in HOURS, so minutes must be converted. Passing
 * 10080 for a 7-day sensor would be a 60x lie in a medical field.
 */
describe('sensor duration units', () => {
  it('prefers the legacy hours pair when present', () => {
    const r = transform(data({ sensorDurationHours: 72, timeToNextCalibHours: 10 }));
    expect(r.devicestatus[0].connect.sensorDurationHours).toBe(72);
    expect(r.devicestatus[0].connect.timeToNextCalibHours).toBe(10);
  });

  it('converts the newer minutes pair to hours', () => {
    const payload: any = data();
    delete payload.sensorDurationHours;
    delete payload.timeToNextCalibHours;
    payload.sensorDurationMinutes = 4320;        // 72 h
    payload.timeToNextCalibrationMinutes = 600;  // 10 h
    const r = transform(payload);
    expect(r.devicestatus[0].connect.sensorDurationHours).toBe(72);
    expect(r.devicestatus[0].connect.timeToNextCalibHours).toBe(10);
  });

  it('prefers hours over minutes when both are sent', () => {
    const payload: any = data({ sensorDurationHours: 72 });
    payload.sensorDurationMinutes = 999999;
    const r = transform(payload);
    expect(r.devicestatus[0].connect.sensorDurationHours).toBe(72);
  });

  it('never emits 10080 for a 7-day sensor (the 60x error)', () => {
    const payload: any = data();
    delete payload.sensorDurationHours;
    payload.sensorDurationMinutes = 7 * 24 * 60;
    const r = transform(payload);
    expect(r.devicestatus[0].connect.sensorDurationHours).toBe(168);
  });

  it('emits undefined rather than NaN when neither pair is present', () => {
    const payload: any = data();
    delete payload.sensorDurationHours;
    delete payload.timeToNextCalibHours;
    const r = transform(payload);
    expect(r.devicestatus[0].connect.sensorDurationHours).toBeUndefined();
  });
});
