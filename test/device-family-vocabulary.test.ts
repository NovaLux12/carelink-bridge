import { describe, it, expect } from 'vitest';
import { isBleDevice } from '../src/carelink/client.js';

/** Mirrors the client's own normalise(), restated here so the audit is explicit. */
const normaliseForTest = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Medtronic publishes its complete device-family vocabulary, unauthenticated, at
 *
 *   GET https://carelink.minimed.eu/patient/v2/configuration/public
 *
 * under the key `personal.device.family.to.model.mapping`. As of 2026-10-09
 * that document lists exactly sixteen families (see VENDOR_FAMILIES below), and
 * a second key in the same document —
 * `system.settings.transfer.feature.config.device.mapping` — independently maps
 * `"CC880": "MiniMed™ Flex"`, which is what identifies CC880 as the family
 * behind issue #91.
 *
 * This table is deliberately COMPLETE rather than a selection of the families
 * that happen to work today. The point is that a family Medtronic adds is a
 * decision someone has to make, with a stated reason, instead of a silent
 * false-negative that surfaces weeks later as "the bridge uploaded nothing".
 *
 * The `expected` column is the contract, not a description of current behaviour:
 * every entry has a reason, including the ones that are false.
 */
const VENDOR_FAMILIES: ReadonlyArray<readonly [family: string, expected: boolean, why: string]> = [
  // --- Matched: BLE-prefixed, already covered before #95 ---
  ['BLE700', true, 'BLE 700G pump'],
  ['BLE720', true, 'BLE 720G pump'],
  ['BLE740', true, 'BLE 740G pump'],
  ['BLE770', true, 'BLE 770G pump'],
  ['BLE780', true, 'BLE 780G pump (the "780G" the vendor names)'],
  ['SIMPLERA', true, 'Simplera'],
  ['SIMPLERACC', true, 'Simplera CC variant'],
  ['SIMPLERACCOLID', true, 'Simplera CC OLID variant'],

  // --- Matched as of #95 ---
  [
    'CC880',
    true,
    'vendor names this "MiniMed™ Flex"; contains MMT-8062/8063/8082-8085, the six models #93 added',
  ],

  // --- Deliberately NOT matched -------------------------------------------
  // Each of these is a real published family that nothing confirms is
  // BLE-paired. Routing a non-BLE device to the BLE endpoint is its own silent
  // failure (wrong shape of response), so the default is false until evidence
  // says otherwise. Revisit with a real token, not with a guess.
  ['CC840', false, 'same CC family, but nothing confirms BLE pairing'],
  ['EAGLE', false, 'MMT-9015/9017/9115/9117 — undocumented device, no pairing evidence'],
  ['GST', false, 'MMT-7811 — generation unconfirmed'],
  ['NMX7', false, 'MMT-1906-1909 — generation unconfirmed'],
  ['NMX8', false, 'MMT-8162/8163 appear inside CC880, so probably the same generation, but unconfirmed'],
  ['GM', false, 'legacy single-token family'],
  ['INSTINCT', false, 'SKU-788xx; community reports say Instinct uses a different Cumulus API'],
];

describe('published device-family vocabulary (#95)', () => {
  it('VENDOR_FAMILIES and this list agree', () => {
    // A self-consistency check, NOT a vendor-change detector: both sides live
    // in this file, so it can only fail if an edit left them out of sync.
    // Medtronic publishing a 17th family is invisible here until someone
    // re-reads the published config and updates the table.
    //
    // What it does buy: anyone editing the vocabulary has to confront the full
    // set of sixteen rather than appending one row.
    expect(VENDOR_FAMILIES.map(([f]) => f).sort()).toEqual(
      [
        'BLE700',
        'BLE720',
        'BLE740',
        'BLE770',
        'BLE780',
        'CC840',
        'CC880',
        'EAGLE',
        'GM',
        'GST',
        'INSTINCT',
        'NMX7',
        'NMX8',
        'SIMPLERA',
        'SIMPLERACC',
        'SIMPLERACCOLID',
      ].sort(),
    );
  });

  it.each(VENDOR_FAMILIES)(
    'family %s -> %s (%s)',
    (family, expected) => {
      expect(isBleDevice(family)).toBe(expected);
    },
  );
});

describe('CC880 specifics (#95)', () => {
  it('matches the Flex family with no model at all — the hard case', () => {
    // monitor/data returns `deviceFamily` while `medicalDeviceFamily` is
    // undefined on the patient path, and models are not guaranteed. This is
    // exactly the payload #91 reported as a silent zero-data fetch.
    expect(isBleDevice('CC880', undefined)).toBe(true);
  });

  it('matches regardless of casing or separators', () => {
    // normalise() uppercases and strips non-alphanumerics, so a display-name
    // spelling lands on the same token.
    for (const spelling of ['CC880', 'cc880', 'CC-880', 'CC 880', 'cc_880']) {
      expect(isBleDevice(spelling), spelling).toBe(true);
    }
  });

  it('matches the vendor display name too, since that spelling was the old guess', () => {
    expect(isBleDevice('MiniMed™ Flex')).toBe(true);
    expect(isBleDevice('Minimed Flex')).toBe(true);
  });

  it('does not over-match: CC-prefixed near misses stay false', () => {
    // Exact-token matching, not a CC prefix rule — so a future CC8xx family is
    // a decision rather than an accident.
    for (const family of ['CC', 'CC88', 'CC8800', 'XCC880', 'CC84', 'AC880']) {
      expect(isBleDevice(family), family).toBe(false);
    }
  });

  it('detects CC880 by token, independent of the display-name fallback', () => {
    // CC880 contains no "FLEX" at all, so this can only pass via the exact
    // published token. That is the point of #95: the fix does not rest on a
    // guess about a marketing name.
    expect(normaliseForTest('CC880')).toBe('CC880');
    expect('CC880'.includes('FLEX')).toBe(false);
    expect(isBleDevice('CC880')).toBe(true);
  });
  it('the display-name fallback covers the spellings the vendor publishes', () => {
    // The vendor labels CC880 "MiniMed™ Flex", and some responses carry a
    // display name in place of the token (the same way SIMPLERA_SYSTEM arrives
    // as "Simplera™ system"), so the substring fallback stays.
    expect(isBleDevice('Minimed™ Flex')).toBe(true);
    expect(isBleDevice('Minimed Flex')).toBe(true);
    expect(isBleDevice('MINIMED™ FLEX')).toBe(true);

    // Known, accepted residual risk, deliberately NOT asserted as a contract:
    // a substring match also accepts nonsense like "REFLEX"/"FLEXIBLE". No
    // published family contains "FLEX" — CC880 included — so no real device is
    // misrouted today. This test does not lock that looseness in, so a future
    // contributor may tighten the matcher to /MINIMED.*FLEX/ without rewriting
    // an assertion that enshrined it.
    for (const [family] of VENDOR_FAMILIES) {
      expect(normaliseForTest(family).includes('FLEX'), family).toBe(false);
    }
  });

  it('still detects the Flex by model when only the model is present', () => {
    // #93's model prefixes must keep working; #95 adds the family, it does not
    // replace the model path.
    for (const model of ['MMT-8062', 'MMT-8063', 'MMT-8082', 'MMT-8083', 'MMT-8084', 'MMT-8085']) {
      expect(isBleDevice(undefined, model), model).toBe(true);
    }
  });

  it('handles the vendor map’s trailing-whitespace padding', () => {
    // Several entries in the published family→model map are padded, e.g.
    // "MMT-5120       ". A naive exact-match parser over that map breaks on
    // them; normalise() strips the padding, so those still detect. (The family
    // match covers most of these regardless — this pins the model path.)
    expect(isBleDevice(undefined, 'MMT-5120       ')).toBe(true);
    expect(isBleDevice(undefined, 'MMT-1886XCF    ')).toBe(true);
  });
});
