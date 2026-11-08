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

/**
 * The device family as it should appear in Nightscout's `device` field.
 *
 * `medicalDeviceFamily` is declared non-optional on `CareLinkData`, but that is
 * a description of the legacy payload, not a guarantee: the BLE endpoint
 * (`blePereodicDataEndpoint`, used for 780G / Guardian / Instinct-era devices)
 * returns the family under `deviceFamily` and MAY omit `medicalDeviceFamily`
 * entirely. Reading it blind threw
 * `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`
 * inside transform() — a crash on the very first real BLE payload, which is
 * exactly the shape arriving when the Instinct sensor enters service.
 *
 * Falls through `deviceFamily` before giving up, and never throws: an unnamed
 * device is a cosmetic wart; a crashed transform is a total data outage.
 */
function deviceFamilyName(data: CareLinkData): string | undefined {
  const candidates = [data.medicalDeviceFamily, data.deviceFamily];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return undefined;
}

function deviceName(data: CareLinkData): string {
  const family = deviceFamilyName(data);
  // Lowercase matches the historical `connect-paradigm` / `connect-guardian`
  // shape Nightscout already holds, so existing series are not split.
  return family ? 'connect-' + family.toLowerCase() : 'connect-unknown';
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

/**
 * Device battery level, preferring the pump-reported value (#82). The
 * reference client reads `pumpBatteryLevelPercent` first and falls back to
 * `medicalDeviceBatteryLevelPercent` only when the former is 0 or absent, so
 * a device reporting only the new field does not surface as 0% battery.
 * `||` (not `??`) mirrors that: 0 means "not reported" here.
 */
function deviceBatteryPercent(data: CareLinkData): number {
  return data.pumpBatteryLevelPercent || data.medicalDeviceBatteryLevelPercent;
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

  // Resolve once: on a BLE payload the family may arrive only as
  // `deviceFamily`, so reading `medicalDeviceFamily` directly would miss the
  // GUARDIAN branch as well as crash in deviceName(). Same fix, same reason.
  const family = deviceFamilyName(data);

  if (family === 'GUARDIAN') {
    return {
      created_at: timestampAsString(data.lastMedicalDeviceDataUpdateServerTime),
      device: deviceName(data),
      uploader: {
        battery: deviceBatteryPercent(data),
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
        pumpBatteryLevelPercent: data.pumpBatteryLevelPercent,
        medicalDeviceFamily: family,
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
      battery: { percent: deviceBatteryPercent(data) },
      // Units fields win over reservoirLevelPercent (#83): the percent is
      // quantised and the units are rounded, so they can disagree slightly,
      // and downstream looping clients read the units value.
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
      medicalDeviceBatteryLevelPercent: data.medicalDeviceBatteryLevelPercent,
      pumpBatteryLevelPercent: data.pumpBatteryLevelPercent,
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
