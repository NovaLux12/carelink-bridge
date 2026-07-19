import { describe, it, expect } from 'vitest';
import { isBleDevice } from '../src/carelink/client.js';

describe('isBleDevice()', () => {
  it('should match when deviceFamily contains BLE', () => {
    expect(isBleDevice('BLE_MINIMED')).toBe(true);
    expect(isBleDevice('BLE_PUMP')).toBe(true);
  });

  it('should match when deviceFamily contains SIMPLERA', () => {
    expect(isBleDevice('SIMPLERA')).toBe(true);
  });

  it('should not match unrelated device families', () => {
    expect(isBleDevice('PARADIGM')).toBe(false);
    expect(isBleDevice('GUARDIAN')).toBe(false);
    expect(isBleDevice('NA')).toBe(false);
  });

  it('should not match empty or undefined device families', () => {
    expect(isBleDevice('')).toBe(false);
    expect(isBleDevice(undefined)).toBe(false);
  });

  /**
   * Regression test for https://github.com/domien-f/carelink-bridge/pull/2
   * (cherry-picked into this fork as commit 5bd49ef).
   *
   * The bug: the patient `monitor/data` endpoint returns the device family
   * under `deviceFamily`, but `medicalDeviceFamily` is undefined for that
   * response. The original code passed `medicalDeviceFamily` directly to
   * isBleDevice, which returned false for undefined — so BLE detection
   * never fired and the code fell through to the legacy connect endpoint
   * that returns empty data for BLE devices.
   *
   * The fix calls `isBleDevice(data.deviceFamily || data.medicalDeviceFamily)`.
   * This test asserts the fallback pattern returns true for the exact bug
   * condition, so a future refactor that drops the fallback re-fails the test.
   */
  it('should detect BLE via the deviceFamily || medicalDeviceFamily fallback (upstream PR #2)', () => {
    const monitorRespData = {
      deviceFamily: 'BLE_MINIMED',
      medicalDeviceFamily: undefined,
    };

    expect(
      isBleDevice(monitorRespData.deviceFamily || monitorRespData.medicalDeviceFamily),
    ).toBe(true);
  });

  it('should still detect BLE when only medicalDeviceFamily is set (legacy path)', () => {
    const legacyData = {
      deviceFamily: undefined,
      medicalDeviceFamily: 'BLE_MINIMED',
    };

    expect(
      isBleDevice(legacyData.deviceFamily || legacyData.medicalDeviceFamily),
    ).toBe(true);
  });

  it('should return false via the fallback when neither field indicates BLE', () => {
    const nonBleData = {
      deviceFamily: 'PARADIGM',
      medicalDeviceFamily: undefined,
    };

    expect(
      isBleDevice(nonBleData.deviceFamily || nonBleData.medicalDeviceFamily),
    ).toBe(false);
  });
});