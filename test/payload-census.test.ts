import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  payloadCensus,
  logPayloadCensus,
  resetPayloadCensusDedup,
  SHIELD_STATES,
  PLGM_STATES,
  SUPPRESSED_ALARM_CODES,
  ALARM_CODE_TABLE_SIZE,
  ALARM_NAME_KEYS,
} from '../src/payload-census.js';
import type { CareLinkData } from '../src/types/carelink.js';

/**
 * A payload shaped like what area DP predicts a 780G would send. Nothing here
 * is a real capture — it is built from the vendor's own client parser, which is
 * the whole point: validation day exists to find out which of these fields
 * actually arrive.
 */
function fullPayload(): CareLinkData {
  return {
    sgs: [{ sg: 120 }, { sg: 121 }],
    lastSGTrend: 'FLAT',
    bgUnits: 'MGDL',
    pumpModelNumber: 'MMT-1884',
    medicalDeviceFamily: 'BLE',
    deviceFamily: 'BLE',
    sensorState: 'SG_VALID',
    calibStatus: 'CAL_OK',
    sensorDurationHours: 100,
    timeToNextCalibHours: 4,
    activeInsulin: { amount: 1.2 },
    reservoirRemainingUnits: 82,
    reservoirAmount: 82,
    reservoirLevelPercent: 75,
    medicalDeviceBatteryLevelPercent: 74,
    conduitBatteryLevel: 60,
    conduitInRange: true,
    systemStatusMessage: 'NO_ERROR_MESSAGE',
    medicalDeviceSuspended: false,
    therapyAlgorithmState: { autoModeShieldState: 'AUTO_BASAL', plgmLgsState: 'MONITORING' },
    lastAlarm: { code: '024', type: 'ALARM', info: '', flash: false },
    markers: [
      { index: 280, type: 'MEAL', amount: 40 },
      { index: 280, type: 'INSULIN', amount: 5 },
      { index: 279, type: 'BG_READING', value: 118 },
    ],
  } as CareLinkData;
}

describe('payloadCensus', () => {
  it('reports every predicted field as present on a full payload', () => {
    const c = payloadCensus(fullPayload());
    expect(c.absent).toEqual([]);
    expect(c.present).toContain('therapyAlgorithmState');
    expect(c.present).toContain('markers');
    expect(c.present).toContain('sgs');
  });

  it('lists predicted-but-absent fields rather than staying quiet', () => {
    // An empty payload is the most informative case on validation day: it says
    // none of the predicted schema arrived.
    const c = payloadCensus({} as CareLinkData);
    expect(c.present).toEqual([]);
    expect(c.absent.length).toBeGreaterThan(15);
    expect(c.absent).toContain('therapyAlgorithmState');
    expect(c.absent).toContain('markers');
  });

  it('treats null, undefined and empty string as absent', () => {
    const c = payloadCensus({
      reservoirRemainingUnits: null,
      activeInsulin: undefined,
      pumpModelNumber: '',
    } as unknown as CareLinkData);
    expect(c.absent).toContain('reservoirRemainingUnits');
    expect(c.absent).toContain('activeInsulin');
    expect(c.absent).toContain('pumpModelNumber');
  });

  it('classifies both auto-mode tokens against the recorded vocabulary', () => {
    const c = payloadCensus(fullPayload());
    expect(c.autoMode).toEqual({
      shieldState: 'AUTO_BASAL',
      shieldKnown: true,
      plgmState: 'MONITORING',
      plgmKnown: true,
    });
  });

  it('flags an auto-mode token that is NOT in the recorded vocabulary', () => {
    // This is the finding the census exists to catch: the vocabularies came from
    // the vendor's parser, never from a captured payload, so a new token is data
    // rather than corruption and must be surfaced.
    const c = payloadCensus({
      therapyAlgorithmState: { autoModeShieldState: 'DEEP_SLEEP', plgmLgsState: 'MONITORING' },
    } as unknown as CareLinkData);
    expect(c.autoMode?.shieldState).toBe('DEEP_SLEEP');
    expect(c.autoMode?.shieldKnown).toBe(false);
    expect(c.autoMode?.plgmKnown).toBe(true);
  });

  it('flags an unknown plgm token too', () => {
    const c = payloadCensus({
      therapyAlgorithmState: { autoModeShieldState: 'AUTO_BASAL', plgmLgsState: 'SUSPEND_FIRED_V3' },
    } as unknown as CareLinkData);
    expect(c.autoMode?.plgmKnown).toBe(false);
  });

  it('reports an alarm code with its suppression status, never its info text', () => {
    const c = payloadCensus(fullPayload());
    expect(c.alarm).toEqual({ code: '024', suppressed: false, nullNamed: false });
    // The free-text `info` field is personal-ish and must never reach the census.
    expect(JSON.stringify(c)).not.toContain('ALARM');
  });

  it('recognises the two codes the vendor suppresses outright', () => {
    for (const code of SUPPRESSED_ALARM_CODES) {
      const c = payloadCensus({ lastAlarm: { code } } as unknown as CareLinkData);
      expect(c.alarm?.suppressed).toBe(true);
    }
  });

  it('recognises a code the vendor null-names', () => {
    const c = payloadCensus({ lastAlarm: { code: '070' } } as unknown as CareLinkData);
    expect(c.alarm?.nullNamed).toBe(true);
    expect(c.alarm?.suppressed).toBe(false);
  });

  it('handles a numeric alarm code by stringifying it', () => {
    // The wire form is a NUMBER on the BLE path (the corpus records `y<10?"00"+y`
    // zero-padding), so a census that only accepted strings would miss every one.
    const c = payloadCensus({ lastAlarm: { code: 16 } } as unknown as CareLinkData);
    expect(c.alarm?.code).toBe('16');
  });

  it('counts marker types as a multiset', () => {
    const c = payloadCensus(fullPayload());
    expect(c.markers?.count).toBe(3);
    expect(c.markers?.types).toEqual({ MEAL: 1, INSULIN: 1, BG_READING: 1 });
    expect(c.markers?.unknownTypes).toEqual([]);
  });

  it('flags marker types outside the 11-token vocabulary', () => {
    const c = payloadCensus({
      markers: [
        { type: 'MEAL' },
        { type: 'SMARTGUARD_WHISPER' },
      ],
    } as unknown as CareLinkData);
    expect(c.markers?.unknownTypes).toEqual(['SMARTGUARD_WHISPER']);
  });

  it('counts the declared-but-unhandled SmartGuard markers without flagging them', () => {
    // AUTO_BASAL_DELIVERY and AUTO_MODE_STATUS ARE in the recorded vocabulary —
    // they are declared by the vendor and simply never handled. So they are
    // counted and NOT reported as unknown, which is the correct distinction.
    const c = payloadCensus({
      markers: [{ type: 'AUTO_BASAL_DELIVERY' }, { type: 'AUTO_MODE_STATUS' }],
    } as unknown as CareLinkData);
    expect(c.markers?.types).toEqual({ AUTO_BASAL_DELIVERY: 1, AUTO_MODE_STATUS: 1 });
    expect(c.markers?.unknownTypes).toEqual([]);
  });

  it('skips markers with no type rather than counting an empty key', () => {
    const c = payloadCensus({ markers: [{}, { type: 'MEAL' }] } as unknown as CareLinkData);
    expect(c.markers?.count).toBe(2);
    expect(c.markers?.types).toEqual({ MEAL: 1 });
  });

  it('reports the reading shape', () => {
    const c = payloadCensus(fullPayload());
    expect(c.readings).toEqual({ sgvCount: 2, hasTrend: true, bgUnits: 'MGDL' });
  });

  it('carries no glucose, carb, insulin or reservoir VALUE', () => {
    // The privacy invariant, asserted rather than assumed. A validation-day log
    // is pasted into a public issue.
    const c = payloadCensus(fullPayload());
    const s = JSON.stringify(c);
    expect(s).not.toContain('120');   // an sg value
    expect(s).not.toContain('1.2');   // active insulin
    expect(s).not.toContain('82');    // reservoir
    expect(s).not.toContain('MMT-1884'); // exact pump model — counted, not printed
  });

  it('publishes the vocabularies the research recovered', () => {
    // Constants, so a future edit that silently shortens a vocabulary fails here.
    expect(SHIELD_STATES).toHaveLength(3);
    expect(PLGM_STATES).toHaveLength(5);
    expect(ALARM_CODE_TABLE_SIZE).toBe(73);
    expect(ALARM_NAME_KEYS).toBe(19);
  });
});

describe('logPayloadCensus', () => {
  beforeEach(() => resetPayloadCensusDedup());

  it('emits exactly one line', () => {
    const log = vi.fn();
    logPayloadCensus('display/message', fullPayload(), log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('Payload census (display/message)');
  });

  it('dedups an identical shape', () => {
    // A 5-minute poll loop must not emit 288 identical lines a day.
    const log = vi.fn();
    logPayloadCensus('e', fullPayload(), log);
    logPayloadCensus('e', fullPayload(), log);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('dedups even when the counts change', () => {
    // SGV and marker counts change on every fetch by design; including them in
    // the signature would defeat the dedup entirely.
    const log = vi.fn();
    logPayloadCensus('e', fullPayload(), log);
    const more = fullPayload();
    more.sgs = [{ sg: 1 }, { sg: 2 }, { sg: 3 }, { sg: 4 }] as CareLinkData['sgs'];
    logPayloadCensus('e', more, log);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('emits again when the SHAPE changes', () => {
    const log = vi.fn();
    logPayloadCensus('e', fullPayload(), log);
    logPayloadCensus('e', {} as CareLinkData, log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('emits again when the auto-mode token changes', () => {
    const log = vi.fn();
    logPayloadCensus('e', fullPayload(), log);
    const flipped = fullPayload();
    flipped.therapyAlgorithmState = { autoModeShieldState: 'SAFE_BAL', plgmLgsState: 'MONITORING' };
    logPayloadCensus('e', flipped, log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('emits again for a different endpoint', () => {
    const log = vi.fn();
    logPayloadCensus('monitor/data', fullPayload(), log);
    logPayloadCensus('connect/data', fullPayload(), log);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('never logs an alarm info string', () => {
    const log = vi.fn();
    const p = fullPayload();
    p.lastAlarm = { code: '024', type: 'ALARM', info: 'CHECK BLOOD GLUCOSE', flash: false } as unknown as CareLinkData['lastAlarm'];
    logPayloadCensus('e', p, log);
    expect(log.mock.calls[0]?.[0]).not.toContain('CHECK BLOOD GLUCOSE');
  });
});
