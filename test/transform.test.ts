import { describe, it, expect } from 'vitest';
import { data, makeSG } from './fixtures.js';
import { missingLastSgv } from './samples.js';
import { transform } from '../src/transform/index.js';

describe('transform()', () => {
  it('should obey sgvLimit', () => {
    const d = data();
    expect(transform(d).entries).toHaveLength(d.sgs.length);
    expect(transform(d, 4).entries).toHaveLength(4);
  });

  it('should include pump device family', () => {
    const result = transform(data({ medicalDeviceFamily: 'foo' }));
    expect(result.entries[0].device).toBe('connect-foo');
  });

  it('should discard data more than 20 minutes old', () => {
    const pumpTimeString = 'Oct 17, 2015 09:06:33';
    const now = Date.parse('Oct 17, 2015 09:09:14');
    const THRESHOLD = 20;
    const boundary = now - THRESHOLD * 60 * 1000;

    expect(
      transform(data({
        sMedicalDeviceTime: pumpTimeString,
        currentServerTime: now,
        lastMedicalDeviceDataUpdateServerTime: boundary,
      })).entries.length,
    ).toBeGreaterThan(0);

    expect(
      transform(data({
        sMedicalDeviceTime: pumpTimeString,
        currentServerTime: now,
        lastMedicalDeviceDataUpdateServerTime: boundary - 1,
      })).entries,
    ).toHaveLength(0);
  });

  describe('active insulin', () => {
    it('should include active insulin', () => {
      const pumpStatus = transform(
        data({
          activeInsulin: {
            datetime: 'Oct 17, 2015 09:09:14',
            version: 1,
            amount: 1.275,
            kind: 'Insulin',
          },
        }),
      ).devicestatus[0];

      expect(pumpStatus.pump?.iob.bolusiob).toBe(1.275);
    });

    it('should ignore activeInsulin values of -1', () => {
      const pumpStatus = transform(
        data({
          activeInsulin: {
            datetime: 'Oct 17, 2015 09:09:14',
            version: 1,
            amount: -1,
            kind: 'Insulin',
          },
        }),
      ).devicestatus[0];

      expect(pumpStatus.pump?.iob.bolusiob).toBeUndefined();
    });
  });

  describe('trend', () => {
    const sgs: [number, string][] = [
      [95, 'Oct 20, 2015 08:05:00'],
      [105, 'Oct 20, 2015 08:10:00'],
      [108, 'Oct 20, 2015 08:15:00'],
    ];

    function transformedSGs(valDatePairs: [number, string?][]) {
      return transform(
        data({
          lastSGTrend: 'UP_DOUBLE',
          sgs: valDatePairs.map(([sg, time]) => makeSG(sg, time)),
        }),
      ).entries;
    }

    it('should add the trend to the last sgv', () => {
      const sgvs = transformedSGs(sgs);
      expect(sgvs).toHaveLength(3);
      expect(sgvs[sgvs.length - 1].sgv).toBe(108);
      expect(sgvs[sgvs.length - 1].direction).toBe('DoubleUp');
      expect(sgvs[sgvs.length - 1].trend).toBe(1);
    });

    it('should not add a trend if the most recent sgv is absent', () => {
      const sgvs = transformedSGs([...sgs, [0, 'Oct 20, 2015 08:20:00']]);
      expect(sgvs).toHaveLength(3);
      expect(sgvs[sgvs.length - 1].sgv).toBe(108);
      expect(sgvs[sgvs.length - 1].direction).toBeUndefined();
      expect(sgvs[sgvs.length - 1].trend).toBeUndefined();
    });
    it('should map NONE trend to Flat (Nightscout trend=4) using a real fixture', () => {
      // P3 fix. CareLink's "NONE" trend means "no-change" — Nightscout
      // convention is trend=4 direction='Flat'. nightscout-connect maps the
      // same key identically; the pre-fix {trend:0, direction:'NONE'} was
      // inherited from upstream domien-f and didn't match any other CGM
      // source's "flat". This regression uses a real fixture (missingLastSgv
      // from test/samples.ts) where lastSGTrend is literally 'NONE' rather
      // than fabricating via data() — matches the documented fixture
      // requirement in the data-model memo.
      // Clone the fixture and drop the trailing sg=0 entry so the
      // "trend attaches only when the most recent SG is real" guard at
      // transform/index.ts:108 fires. The fixture's final entry has
      // sg=0 by design (the whole point of `missingLastSgv` is "what
      // happens when the last SGV is missing") — we honour that test in
      // the existing describe('trend') sibling test ("should not add a
      // trend if the most recent sgv is absent"); here we want to
      // exercise the NONE->Flat mapping against a real latest SG.
      const result = transform({
        ...missingLastSgv,
        lastSGTrend: 'NONE',
        sgs: missingLastSgv.sgs.slice(0, -1),
      });

      // The fixture has at least one SG; trend attaches to the most recent.
      const entries = result.entries;
      expect(entries.length).toBeGreaterThan(0);
      const last = entries[entries.length - 1];
      expect(last.trend).toBe(4);
      expect(last.direction).toBe('Flat');
    });
  });

  describe('uploader battery', () => {
    it('should use the Connect battery level as uploader.battery', () => {
      const pumpStatus = transform(data({ conduitBatteryLevel: 76 })).devicestatus[0];
      expect(pumpStatus.uploader.battery).toBe(76);
    });
  });

  describe('device battery precedence (#82)', () => {
    // Mirrors the reference client's getDeviceBatteryLevel(): prefer
    // pumpBatteryLevelPercent, fall back to medicalDeviceBatteryLevelPercent
    // only when the former is 0 or absent. INFERRED from the reference
    // client's model — unverified on the wire.
    it('prefers pumpBatteryLevelPercent when present', () => {
      const ds = transform(data({
        medicalDeviceBatteryLevelPercent: 65,
        pumpBatteryLevelPercent: 82,
      })).devicestatus[0];
      expect(ds.pump?.battery).toEqual({ percent: 82 });
    });

    it('falls back to medicalDeviceBatteryLevelPercent when pump is 0', () => {
      const ds = transform(data({
        medicalDeviceBatteryLevelPercent: 65,
        pumpBatteryLevelPercent: 0,
      })).devicestatus[0];
      expect(ds.pump?.battery).toEqual({ percent: 65 });
    });

    it('is unchanged when only medicalDeviceBatteryLevelPercent is present (older devices)', () => {
      const ds = transform(data({
        medicalDeviceBatteryLevelPercent: 65,
      })).devicestatus[0];
      expect(ds.pump?.battery).toEqual({ percent: 65 });
    });

    it('prefers pumpBatteryLevelPercent on the GUARDIAN branch too', () => {
      // The helper is also wired into the GUARDIAN uploader.battery read, so
      // pin it there as well — a GUARDIAN payload carrying a nonzero pump
      // value must report it, not the medical-device value.
      const ds = transform(data({
        medicalDeviceFamily: 'GUARDIAN',
        medicalDeviceBatteryLevelPercent: 65,
        pumpBatteryLevelPercent: 82,
      })).devicestatus[0];
      expect(ds.uploader.battery).toBe(82);
    });

    it('passes pumpBatteryLevelPercent through on the connect mirror', () => {
      const ds = transform(data({
        medicalDeviceBatteryLevelPercent: 65,
        pumpBatteryLevelPercent: 82,
      })).devicestatus[0];
      expect(ds.connect?.pumpBatteryLevelPercent).toBe(82);
      expect(ds.connect?.medicalDeviceBatteryLevelPercent).toBe(65);
    });
  });

  describe('reservoir source (#83)', () => {
    it('keeps using the units fields, not reservoirLevelPercent', () => {
      const ds = transform(data({
        reservoirRemainingUnits: 42,
        reservoirAmount: 40,
        reservoirLevelPercent: 55,
      })).devicestatus[0];
      // Units win: downstream looping clients read this value, and the
      // percent is quantised while the units are rounded.
      expect(ds.pump?.reservoir).toBe(42);
    });

    it('falls back through the units fields as before', () => {
      expect(transform(data({ reservoirAmount: 40 })).devicestatus[0].pump?.reservoir).toBe(40);
    });

    it('keeps reservoirLevelPercent typed (type-level pin)', () => {
      // CareLinkData carries [key: string]: unknown, so deleting the declared
      // field breaks neither vitest nor tsc. This assignment errors
      // ("unknown not assignable") if the declaration is removed.
      const pct: number | undefined = data({ reservoirLevelPercent: 55 }).reservoirLevelPercent;
      expect(pct).toBe(55);
    });
  });

  describe('per-reading SG fields (#85)', () => {
    it('carries sensorState and relativeOffset on the type without changing output', () => {
      // Typing only: the transform does not consume these yet, and must not
      // change SGV timestamp semantics in this change. This pins that a payload
      // carrying them transforms exactly like one without.
      const withFields = data({});
      withFields.sgs = withFields.sgs.map((sg) => ({
        ...sg, sensorState: 'NORMAL', relativeOffset: 0,
      }));
      const plain = data({});
      expect(transform(withFields).entries).toEqual(transform(plain).entries);
    });

    it('keeps sensorState and relativeOffset typed on CareLinkSG (type-level pin)', () => {
      // The spread above is not excess-property-checked, so removing the
      // declarations would still pass. Direct property reads error
      // ("property does not exist") if the fields are removed — CareLinkSG
      // has no index signature to hide behind.
      const sg0 = makeSG(70);
      const st: string | undefined = sg0.sensorState;
      const off: number | undefined = sg0.relativeOffset;
      expect([st, off]).toEqual([undefined, undefined]);
    });
  });

  describe('mmol/L unit conversion (P0.1 safety)', () => {
    // CareLink accounts report their preferred unit via bgunits/bgUnits.
    // mmol/L values must be converted to mg/dL before reaching Nightscout;
    // otherwise looping clients (Loop, xDrip, AAPS) interpret the value as
    // mg/dL and over-deliver insulin. See research/medtronic-carelink-2026-07-21/03-data-model-and-gaps.md (P0.1).

    it('converts 5.5 mmol/L to 99 mg/dL (round-half-up via factor 18.0182)', () => {
      const result = transform(data({
        bgunits: 'MMOL_L',
        sgs: [makeSG(5.5, 'Oct 20, 2015 11:09:00')],
      }));

      // 5.5 * 18.0182 = 99.1001, rounded → 99. The numeric assertion
      // catches an off-by-one, factor-flipped, or zero-passthrough bug —
      // any of those would leave the SGV unconverted and over-deliver
      // insulin downstream.
      expect(result.entries[0].sgv).toBe(99);
    });

    it('handles the upper edge: 22.2 mmol/L → 400 mg/dL (severe hyperglycemia)', () => {
      const result = transform(data({
        bgunits: 'MMOL_L',
        sgs: [makeSG(22.2, 'Oct 20, 2015 11:09:00')],
      }));

      // 22.2 * 18.0182 = 400.00404, rounded → 400.
      expect(result.entries[0].sgv).toBe(400);
    });

    it('handles the lower edge: 2.0 mmol/L → 36 mg/dL (severe hypoglycemia)', () => {
      const result = transform(data({
        bgunits: 'MMOL_L',
        sgs: [makeSG(2.0, 'Oct 20, 2015 11:09:00')],
      }));

      // 2.0 * 18.0182 = 36.0364, rounded → 36.
      expect(result.entries[0].sgv).toBe(36);
    });

    it('passes through mg/dL values unchanged (no over-conversion)', () => {
      const result = transform(data({
        bgunits: 'MGDL',
        sgs: [makeSG(120, 'Oct 20, 2015 11:09:00')],
      }));

      expect(result.entries[0].sgv).toBe(120);
    });

    it('falls back to the upper-case bgUnits key when bgunits is absent', () => {
      const result = transform(data({
        bgUnits: 'MMOL_L',
        bgunits: undefined,
        sgs: [makeSG(10.0, 'Oct 20, 2015 11:09:00')],
      }));

      // 10.0 * 18.0182 = 180.182, rounded → 180.
      expect(result.entries[0].sgv).toBe(180);
    });

    it('does not silently convert unknown unit strings', () => {
      // Defensive: future CareLink keys/casing should fail loud, not
      // convert-as-mg/dL. If bgunits says something we don't recognise,
      // we treat the value as already-mg/dL — same shape as MGDL today.
      const result = transform(data({
        bgunits: 'FOO_BAR',
        sgs: [makeSG(120, 'Oct 20, 2015 11:09:00')],
      }));

      expect(result.entries[0].sgv).toBe(120);
    });
  });
 });
