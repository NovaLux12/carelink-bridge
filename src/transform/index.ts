import * as logger from '../logger.js';
import type { CareLinkData } from '../types/carelink.js';
import { evaluateLastAlarm, logLastAlarm } from '../last-alarm.js';

import type { NightscoutSGVEntry, NightscoutDeviceStatus, NightscoutLastAlarmAnnotation, TransformResult } from '../types/nightscout.js';
import { CARELINK_TREND_TO_NIGHTSCOUT_TREND } from './trend-map.js';
import { guessPumpOffset, guessPumpOffsetMilliseconds } from './pump-offset.js';

const STALE_DATA_THRESHOLD_MINUTES = 20;

const MMOL_L_TO_MGDL = 18.0182;

/**
 * Detects whether a CareLink payload reports glucose in mmol/L. CareLink has
 * shipped both `bgUnits` and `bgunits` casing historically; we prefer the
 * lower-case one and accept either. Returns true only for the explicit mmol
 * marker — any other/unknown unit is treated as mg/dL (do not silently
 * convert).
 */
function isMmolL(data: CareLinkData): boolean {
  const u = (data.bgunits ?? data.bgUnits ?? '').toUpperCase();
  return u === 'MMOL_L' || u === 'MMOL/L' || u === 'MMOL';
}

function normalizeSgToMgdl(sg: number, data: CareLinkData): number {
  if (!isMmolL(data)) return sg;
  // Round to the nearest integer mg/dL — Nightscout is mg/dL-native and
  // fractional entries are confusing downstream (Loop, xDrip, AAPS all
  // expect whole-number mg/dL).
  return Math.round(sg * MMOL_L_TO_MGDL);
}

function parsePumpTime(
  pumpTimeString: string,
  _offset: string,
  offsetMilliseconds: number,
): number {
  return Date.parse(pumpTimeString) - offsetMilliseconds;
}

function timestampAsString(timestamp: number): string {
  if (!timestamp || isNaN(timestamp)) {
    return new Date().toISOString();
  }
  return new Date(timestamp).toISOString();
}

function deviceName(data: CareLinkData): string {
  return 'connect-' + data.medicalDeviceFamily.toLowerCase();
}

function deviceStatusEntry(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): NightscoutDeviceStatus {
  // Compute lastAlarm annotation + side-effect log once per transform call.
  // Both branches (GUARDIAN, pump) attach the same annotation. NEVER
  // publishes to /api/v1/treatments.json — see src/last-alarm.ts.
  const lastAlarmEval = evaluateLastAlarm(data.lastAlarm);
  if (lastAlarmEval) {
    logLastAlarm(lastAlarmEval); // priority-1 codes always warn
  }
  const lastAlarm: NightscoutLastAlarmAnnotation | undefined =
    lastAlarmEval?.annotation;

  if (data.medicalDeviceFamily === 'GUARDIAN') {
    return {
      created_at: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
      device: deviceName(data),
      uploader: {
        battery: data.medicalDeviceBatteryLevelPercent,
      },
      last_alarm: lastAlarm,


      connect: {
        sensorState: data.sensorState,
        calibStatus: data.calibStatus,
        sensorDurationHours: data.sensorDurationHours,
        timeToNextCalibHours: data.timeToNextCalibHours,
        conduitInRange: data.conduitInRange,
        conduitMedicalDeviceInRange: data.conduitMedicalDeviceInRange,
        conduitSensorInRange: data.conduitSensorInRange,
        medicalDeviceBatteryLevelPercent: data.medicalDeviceBatteryLevelPercent,
        medicalDeviceFamily: data.medicalDeviceFamily,
      },
    };
  }

  return {
    created_at: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
    device: deviceName(data),
    uploader: {
      battery: data.conduitBatteryLevel,
    },
    last_alarm: lastAlarm,


    pump: {
      battery: { percent: data.medicalDeviceBatteryLevelPercent },
      reservoir: data.reservoirRemainingUnits ?? data.reservoirAmount,
      iob: {
        timestamp: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
        bolusiob: data.activeInsulin?.amount != null && data.activeInsulin.amount >= 0
          ? data.activeInsulin.amount
          : undefined,
      },
      clock: timestampAsString(
        parsePumpTime(data.sMedicalDeviceTime, offset, offsetMilliseconds)
      ),
    },
    connect: {
      sensorState: data.sensorState,
      calibStatus: data.calibStatus,
      sensorDurationHours: data.sensorDurationHours,
      timeToNextCalibHours: data.timeToNextCalibHours,
      conduitInRange: data.conduitInRange,
      conduitMedicalDeviceInRange: data.conduitMedicalDeviceInRange,
      conduitSensorInRange: data.conduitSensorInRange,
    },
  };
}

function sgvEntries(
  data: CareLinkData,
  offset: string,
  offsetMilliseconds: number,
): NightscoutSGVEntry[] {
  if (!data.sgs?.length) {
    return [];
  }

  const sgvs: NightscoutSGVEntry[] = data.sgs
    .filter(entry => entry.kind === 'SG' && entry.sg !== 0)
    .map(sgv => {
      const timestamp = parsePumpTime(sgv.datetime, offset, offsetMilliseconds);
      return {
        type: 'sgv' as const,
        sgv: normalizeSgToMgdl(sgv.sg, data),
        date: timestamp,
        dateString: timestampAsString(timestamp),
        device: deviceName(data),
      };
    });

  // Apply trend data to the most recent SGV
  if (sgvs.length > 0 && data.sgs[data.sgs.length - 1].sg !== 0) {
    const trendData = CARELINK_TREND_TO_NIGHTSCOUT_TREND[data.lastSGTrend];
    if (trendData) {
      sgvs[sgvs.length - 1] = { ...sgvs[sgvs.length - 1], ...trendData };
    }
  }

  return sgvs;
}

export function transform(data: CareLinkData, sgvLimit?: number): TransformResult {
  const recency =
    (data.currentServerTime - data.lastMedicalDeviceDataUpdateServerTime) / (60 * 1000);

  if (recency > STALE_DATA_THRESHOLD_MINUTES) {
    logger.log('Stale CareLink data: ' + recency.toFixed(2) + ' minutes old');
    return { devicestatus: [], entries: [] };
  }

  const offset = guessPumpOffset(data);
  const offsetMilliseconds = guessPumpOffsetMilliseconds(data);
  const limit = sgvLimit ?? Infinity;

  return {
    devicestatus: [deviceStatusEntry(data, offset, offsetMilliseconds)],
    entries: sgvEntries(data, offset, offsetMilliseconds).slice(-limit),
  };
}
