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

  /**
   * https://github.com/NovaLux12/carelink-bridge/issues/73
   *
   * Medtronic's own portal defines its device-family enum value as
   * `SIMPLERA_SYSTEM = "Simplera™ system"` — the value is mixed case while
   * the old check was uppercase, and `String.includes()` is case-sensitive,
   * so `"Simplera™ system".includes('SIMPLERA')` was false and BLE
   * detection silently failed. Matching is normalised (uppercased,
   * non-alphanumerics stripped) so the display string, the enum key and
   * lowercase all hit.
   *
   * Whether the wire value arrives as the display string or as the enum key
   * is unverified (needs a real CareLink token) — which is why every spelling
   * is asserted here.
   */
  it('should match Simplera regardless of case, punctuation or spacing', () => {
    expect(isBleDevice('Simplera™ system')).toBe(true);
    expect(isBleDevice('SIMPLERA_SYSTEM')).toBe(true);
    expect(isBleDevice('simplera')).toBe(true);
    expect(isBleDevice('Simplera Sync')).toBe(true);
    expect(isBleDevice('  simpl-era  system ')).toBe(true);
  });

  it('should match BLE regardless of case', () => {
    expect(isBleDevice('ble_minimed')).toBe(true);
    expect(isBleDevice('Ble_MiniMed')).toBe(true);
  });

  it('should not match a family with no BLE or Simplera token', () => {
    // "Guardian™ 4 system" is mixed case like Simplera, but has no BLE and
    // no Simplera token — the guard sensor itself is not a BLE family.
    expect(isBleDevice('Guardian™ 4 system')).toBe(false);
    expect(isBleDevice('GUARDIAN_4_SYSTEM')).toBe(false);
  });

  it('should treat NO_SENSOR as "no sensor" and not a match', () => {
    expect(isBleDevice('NO_SENSOR')).toBe(false);
    expect(isBleDevice('no_sensor')).toBe(false);
    expect(isBleDevice(undefined, 'NO_SENSOR')).toBe(false);
  });

  /**
   * The model half of issue #73: the bridge read neither `deviceModel` nor
   * `sensorModel`, so a device whose family string carries no BLE token was
   * invisible to detection even though the model number identifies it.
   *
   * The prefix table is an OFFLINE heuristic transcribed from Medtronic's
   * published device table — Medtronic serves the live mapping
   * (`deviceModelMapping` / `deviceToFamilyMapping`) to their own client, so
   * the server mapping wins when it is available and this is the fallback.
   */
  it('should match known BLE / standalone-CGM device models as the 2nd arg', () => {
    // Guardian 4 Sensor, Simplera Sync, Instinct Sensor
    expect(isBleDevice(undefined, 'MMT-7841')).toBe(true);
    expect(isBleDevice(undefined, 'MMT-5120')).toBe(true);
    expect(isBleDevice(undefined, 'MMT-5420')).toBe(true);
    // 780G pump (also the MMT-1884XCU/XCE/XCF suffixes)
    expect(isBleDevice(undefined, 'MMT-1884')).toBe(true);
    expect(isBleDevice(undefined, 'MMT-1884XCE')).toBe(true);
    // Guardian Connect, Instinct Go SKU
    expect(isBleDevice(undefined, 'CSS-7200')).toBe(true);
    expect(isBleDevice(undefined, 'SKU-78959-01')).toBe(true);
  });

  it('should match a model even when the family says nothing useful', () => {
    // Real-world shape: family is a generic pump family, model carries the
    // BLE identity. Pre-#73 this returned false.
    expect(isBleDevice('PARADIGM', 'MMT-7841')).toBe(true);
    expect(isBleDevice('GUARDIAN', 'MMT-5120')).toBe(true);
    // The NO_SENSOR sentinel in the family slot must not veto the model.
    expect(isBleDevice('NO_SENSOR', 'MMT-1884')).toBe(true);
  });

  it('should match a model with an explicitly empty family', () => {
    expect(isBleDevice('', 'MMT-7841')).toBe(true);
  });

  it('should not match a non-BLE device model', () => {
    // MMT-1510 = MiniMed 620G: a real pump, but not a BLE family.
    expect(isBleDevice(undefined, 'MMT-1510')).toBe(false);
    expect(isBleDevice('PARADIGM', 'MMT-1510')).toBe(false);
    // Adjacent SKU with no row in the table — the match is a prefix test, so
    // a model must not slip through on a partial overlap.
    expect(isBleDevice(undefined, 'SKU-78961')).toBe(false);
    expect(isBleDevice(undefined, 'CSS-7100')).toBe(false);
  });

  it('requires the model prefix at the START, not as a substring (NF1)', () => {
    // NF1: this branch's matcher uses startsWith(), not includes(). Swapping
    // that back leaves the suite green, and a model string that merely
    // CONTAINS a BLE prefix would then silently route a non-BLE account onto
    // the cumulus BLE endpoint — the F4 failure mode, one matcher over.
    expect(isBleDevice(undefined, 'XCU-MMT1884')).toBe(false);
    expect(isBleDevice(undefined, 'A-MMT1884')).toBe(false);
    expect(isBleDevice(undefined, 'XSKU78959Y')).toBe(false);
    // The real suffixed 780G codes still match, via the leading prefix.
    expect(isBleDevice(undefined, 'MMT-1884XCU')).toBe(true);
    expect(isBleDevice(undefined, 'MMT-1886XCF')).toBe(true);
  });

  it('should ignore empty and missing model values', () => {
    expect(isBleDevice(undefined, '')).toBe(false);
    expect(isBleDevice(undefined, undefined)).toBe(false);
    expect(isBleDevice(undefined, '   ')).toBe(false);
  });

  /**
   * N4 — pins the model-table rows that issue #73's fix relies on.
   *
   * Without these, the whole of BLE_DEVICE_MODELS could be reverted (or rows
   * silently deleted) and the suite would still pass green: a 770G account
   * would be re-routed off /patient/monitor/data onto the cumulus BLE
   * endpoint, and the Guardian 4 *System* would go undetected again. That is
   * the same "tests pass but nothing is pinned" class the review flagged.
   */
  it('routes 770G pumps to monitor/data, NOT the BLE endpoint (issue #74 #73)', () => {
    // F4: 770G was briefly added to the table without evidence, which silently
    // re-routed working 770G accounts. Must stay false via the model arg.
    for (const m of ['MMT-1880', 'MMT-1881', 'MMT-1882', 'MMT-1880XCU']) {
      expect(isBleDevice(undefined, m), m).toBe(false);
    }
    // ...but a 770G whose family string carries a BLE token still takes the
    // BLE path — that is the legitimate route and must not regress.
    expect(isBleDevice('BLE_MINIMED', 'MMT-1880')).toBe(true);
  });

  it('detects the standalone CGM system families and the gm4 sentinel (issue #73)', () => {
    for (const m of [
      'gm4_snapshot',
      'MMT-8200', 'MMT-8201', // Guardian 4 system
      'MMT-6500', 'MMT-6501', 'MMT-8400', 'MMT-8401', // Simplera system
    ]) {
      expect(isBleDevice(undefined, m), m).toBe(true);
    }
  });

  it('does not treat ordinary words containing BLE as a BLE device', () => {
    // Prefix, not substring: after normalising these all contain "BLE".
    for (const f of ['ENABLE', 'DISABLE', 'DOUBLE', 'TABLE', 'TROUBLE']) {
      expect(isBleDevice(f), f).toBe(false);
    }
  });

  it('matches every observed family spelling after normalisation', () => {
    for (const f of ['BLE_MINIMED', 'BLE_PUMP', 'BLE', 'SIMPLERA', 'SIMPLERA_SYSTEM', 'Simplera™ system', 'simplera']) {
      expect(isBleDevice(f), f).toBe(true);
    }
  });

  it('vetoes only the exact NO_SENSOR sentinel, not every substring', () => {
    expect(isBleDevice('NO_SENSOR')).toBe(false);
    expect(isBleDevice(undefined, 'NO_SENSOR')).toBe(false);
    // An earlier iteration of this branch's own matcher vetoed these on a
    // substring test; review caught it and the veto never merged — what
    // remains is the exact-sentinel check above.
    expect(isBleDevice('NO', 'MMT-7841')).toBe(true);
    expect(isBleDevice('N', 'MMT-7841')).toBe(true);
    expect(isBleDevice('O', 'MMT-7841')).toBe(true);
  });

  /**
   * #91 — Minimed Flex (MMT-8062 family). Reported live upstream
   * (domien-f/carelink-bridge#3): silent zero-data fetch after a 780G-to-Flex
   * upgrade. The Flex sends neither a BLE/SIMPLERA family token nor a
   * previously-known model, so both spellings are covered.
   */
  it('detects the Minimed Flex by model number (#91)', () => {
    for (const m of ['MMT-8062', 'MMT-8063', 'MMT-8082', 'MMT-8083', 'MMT-8084', 'MMT-8085']) {
      expect(isBleDevice(undefined, m), m).toBe(true);
    }
  });

  it('detects the Minimed Flex by family string (#91)', () => {
    for (const f of ['Minimed Flex', 'MINIMEDFLEX', 'FLEX']) {
      expect(isBleDevice(f), f).toBe(true);
    }
  });

  it('does not false-positive any known non-Flex family on the FLEX token (#91)', () => {
    // The audit behind the includes('FLEX') choice: none of these contain it
    // (checked post-normalisation, as the matcher sees them).
    const cases: Array<[string, boolean]> = [
      ['GUARDIAN', false], ['NGP', false], ['CGM', false], ['CC', false],
      ['PARADIGM', false], ['ENABLE', false], ['TABLE', false],
      ['BLE_MINIMED', true], ['SIMPLERA_SYSTEM', true], ['Simplera™ system', true],
    ];
    for (const [f, expected] of cases) {
      expect(isBleDevice(f), f).toBe(expected);
    }
  });
});