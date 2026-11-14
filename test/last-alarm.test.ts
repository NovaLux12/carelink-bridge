import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { transform } from '../src/transform/index.js';
import { evaluateLastAlarm, logLastAlarm } from '../src/last-alarm.js';
import type { CareLinkData } from '../src/types/carelink.js';
import { data } from './fixtures.js';

/**
 * P0.2-lite lastAlarm plumbing. Verification bar from the user:
 *   (a) annotation present with code/datetime/text/severity
 *   (b) WARN fires for priority-1 codes (vi.spyOn console.warn)
 *   (c) absence grep proving src/ contains zero /api/v1/treatments *call sites*
 *   (d) behavioral: alarm lives in devicestatus, not entries
 *
 * Safety contract (https://github.com/NovaLux12/carelink-api-research/blob/main/findings-log/medtronic-carelink-2026-07-21/03-data-model-and-gaps.md,
 * memo lines 23-25): priority-1 alarms get a WARN log but NEVER auto-publish
 * to Nightscout /api/v1/treatments.json.
 */

function alarmFixture(overrides?: Partial<{ code: number | string; datetime: string }>): CareLinkData['lastAlarm'] {
  return {
    type: 'ALARM',
    version: 1,
    flash: false,
    datetime: 'Oct 17, 2015 09:09:14',
    kind: 'Alarm',
    code: 4,
    ...overrides,
  };
}

describe('evaluateLastAlarm', () => {
  it('returns an annotation with code, datetime, text, severity', () => {
    // Prong (a) — annotation shape present and complete.
    const result = evaluateLastAlarm(alarmFixture({ code: 4, datetime: '2026-07-21T00:00:00Z' }));
    expect(result).not.toBeNull();
    expect(result!.annotation).toEqual({
      code: 4,
      datetime: '2026-07-21T00:00:00Z',
      text: 'Pump Error. Delivery Stopped',
      severity: 'delivery_stopped',
    });
  });

  it('classifies paradigm-era delivery-stopped codes as delivery_stopped', () => {
    // Codes whose vendor string says "Delivery Stopped". 6 is excluded on
    // purpose: the vendor's text for 6 is "Pump Battery Out Limit", which is
    // `attention` — see the ATTENTION_CODES test below.
    for (const code of [4, 16, 43, 61] as const) {
      const result = evaluateLastAlarm(alarmFixture({ code }));
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('delivery_stopped');
      expect(result!.annotation.severity).toBe('delivery_stopped');
    }
  });

  it('tiers by the VENDOR text, not by group membership', () => {
    // The defect this replaces: every non-critical vendor group was assumed to
    // mean "delivery stopped", so a battery reminder fired a priority-1
    // "Delivery stopped" line. Severity now follows what the vendor's own string
    // says the alarm IS.
    const cases: [number, string, string][] = [
      [6, 'attention', 'Pump Battery Out Limit'],
      [11, 'attention', 'Replace Pump Battery Now'],
      [84, 'attention', 'Pump Battery Removed. Replace Battery'],
      [62, 'other', 'New notification received from CareLink'],
      [51, 'other', 'Bolus Stopped'],
      [7, 'delivery_stopped', 'Delivery Stopped. Check BG'],
      [809, 'delivery_stopped', 'Suspend On Low. Delivery Stopped. Check BG'],
      [810, 'delivery_stopped', 'Suspend Before Low. Delivery Stopped. Check BG'],
      [24, 'stop_using_pump', 'Critical Pump Error. Stop Pump Use. Use Other Treatment'],
    ];
    for (const [code, severity, text] of cases) {
      const r = evaluateLastAlarm(alarmFixture({ code }));
      expect(r, `code ${code}`).not.toBeNull();
      expect(r!.severity, `code ${code} severity`).toBe(severity);
      expect(r!.text, `code ${code} text`).toBe(text);
    }
  });

  it('classifies unknown codes as severity=other and synthesises "Unknown alarm code <n>"', () => {
    // Defensive: never silently drop an alarm; unknown codes still surface.
    const result = evaluateLastAlarm(alarmFixture({ code: 9999 }));
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('other');
    expect(result!.text).toBe('Unknown alarm code 9999');
  });

  it('returns null when alarm is undefined or code is non-numeric', () => {
    expect(evaluateLastAlarm(undefined)).toBeNull();
    // @ts-expect-error — runtime guard, intentional shape mismatch
    expect(evaluateLastAlarm({ ...alarmFixture(), code: 'four' })).toBeNull();
  });

  // Issue #84 — NGP "N"-prefixed string form. The unauthenticated search
  // for the codes' canonical form is exhausted; the wire form that 780G
  // pumps send is unverified. Both forms must be accepted so neither
  // silently drops a "Critical Pump Error".
  it('normalises NGP "N24" string code to stop_using_pump severity (#84)', () => {
    const result = evaluateLastAlarm(alarmFixture({ code: 'N24' }));
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('stop_using_pump');
    expect(result!.annotation.severity).toBe('stop_using_pump');
    // Canonical numeric form is what downstream Nightscout consumers see.
    expect(result!.annotation.code).toBe(24);
    // Original wire form is preserved for operator-visible logging.
    expect(result!.annotation.wireCode).toBe('N24');
    expect(result!.wireCode).toBe('N24');
    expect(result!.text).toBe('Critical Pump Error. Stop Pump Use. Use Other Treatment');
  });

  it('classifies every NGP stop_using_pump code (mddub a95dc120d9d1414a433d, #84)', () => {
    for (const code of [24, 35, 40, 47, 48, 50, 55, 131] as const) {
      // Both the numeric wire form and the "N"-prefixed string form.
      for (const wireForm of [code, `N${code}`, `n${code}`] as const) {
        const result = evaluateLastAlarm(alarmFixture({ code: wireForm }));
        expect(result, `code=${JSON.stringify(wireForm)}`).not.toBeNull();
        expect(result!.severity, `code=${JSON.stringify(wireForm)}`).toBe('stop_using_pump');
        expect(result!.annotation.code, `code=${JSON.stringify(wireForm)}`).toBe(code);
      }
    }
  });

  it('classifies NGP delivery-stopped codes as delivery_stopped (#84)', () => {
    // The NGP-era additions; paradigm-era codes are already covered above.
    // 25 is excluded: the vendor's string is "Pump Power Error. Record
    // Settings", which is `attention`, not a stopped delivery.
    for (const code of [1, 22, 33, 42, 63, 67, 76, 130] as const) {
      for (const wireForm of [code, `N${code}`] as const) {
        const result = evaluateLastAlarm(alarmFixture({ code: wireForm }));
        expect(result, `code=${JSON.stringify(wireForm)}`).not.toBeNull();
        expect(result!.severity, `code=${JSON.stringify(wireForm)}`).toBe('delivery_stopped');
      }
    }
  });

  it('parses plain numeric strings leniently (issue #84 regression)', () => {
    // A stringified paradigm code is a real alarm, not junk — surface it
    // rather than silently drop it.
    const result = evaluateLastAlarm(alarmFixture({ code: '4' }));
    expect(result).not.toBeNull();
    expect(result!.annotation.code).toBe(4);
    expect(result!.severity).toBe('delivery_stopped');
    expect(result!.annotation.wireCode).toBe('4');
  });

  it('rejects malformed NGP strings (issue #84 regression)', () => {
    // Anchored /^N(\d+)$/ — partial matches, negatives, junk must still
    // return null rather than silently firing a wrong-severity WARN.
    for (const code of ['N24x', 'N-1', 'N', 'N ', 'Nab', '4.5', '-4', '']) {
      const result = evaluateLastAlarm(alarmFixture({ code }));
      expect(result, `code=${JSON.stringify(code)}`).toBeNull();
    }
  });

  it('rejects non-finite numbers (issue #84 regression)', () => {
    // NaN/Infinity would otherwise flow into the lookup tables and produce
    // a spurious "Unknown alarm code NaN" annotation. Return null instead.
    expect(evaluateLastAlarm(alarmFixture({ code: NaN }))).toBeNull();
    expect(evaluateLastAlarm(alarmFixture({ code: Infinity }))).toBeNull();
  });

  it('does not set wireCode when the wire form was a number (#84)', () => {
    // Backward compatibility — pre-existing Nightscout consumers do not see
    // a new field appear in the JSON shape they already accepted.
    const result = evaluateLastAlarm(alarmFixture({ code: 4 }));
    expect(result!.annotation.wireCode).toBeUndefined();
    expect(result!.wireCode).toBeUndefined();
  });
});

describe('transform surfaces data.lastAlarm in devicestatus.annotation', () => {
  it('attaches last_alarm with code/datetime/text/severity', () => {
    // Prong (a) end-to-end: typed payload reaches Nightscout shape.
    const result = transform(data({
      lastAlarm: alarmFixture({ code: 4, datetime: '2026-07-21T00:00:00Z' }),
    }));

    expect(result.devicestatus[0].last_alarm).toEqual({
      code: 4,
      datetime: '2026-07-21T00:00:00Z',
      text: 'Pump Error. Delivery Stopped',
      severity: 'delivery_stopped',
    });
  });

  it('does not propagate last_alarm into the entries array', () => {
    // Prong (d) — alarm shape never bleeds into SGV entries.
    const result = transform(data({
      lastAlarm: alarmFixture({ code: 4 }),
    }));

    for (const entry of result.entries) {
      expect(entry).not.toHaveProperty('last_alarm');
      expect(entry).not.toHaveProperty('lastAlarm');
    }
  });

  it('leaves last_alarm undefined when data.lastAlarm is absent', () => {
    const result = transform(data({ lastAlarm: undefined }));
    expect(result.devicestatus[0].last_alarm).toBeUndefined();
  });
});

describe('logLastAlarm fires console.warn for priority-1 codes', () => {
  let warnSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('WARNs for delivery_stopped codes, and says the vendor text', () => {
    // Prong (b) — priority-1 codes always warn, even with verbose off.
    for (const code of [4, 16, 43, 61] as const) {
      warnSpy.mockClear();
      const evaluation = evaluateLastAlarm(alarmFixture({ code }));
      expect(evaluation).not.toBeNull();
      logLastAlarm(evaluation!);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] ?? '';
      expect(message).toMatch(/Delivery stopped/);
      expect(message).toContain(`code=${code}`);
    }
  });

  it('WARNs for attention codes WITHOUT claiming delivery stopped', () => {
    // A battery reminder must not read as "basal has stopped": the operator has
    // to be able to tell the two apart, or the priority-1 line stops meaning
    // anything.
    for (const [code, text] of [
      [6, 'Pump Battery Out Limit'],
      [84, 'Pump Battery Removed. Replace Battery'],
    ] as [number, string][]) {
      warnSpy.mockClear();
      const evaluation = evaluateLastAlarm(alarmFixture({ code }));
      logLastAlarm(evaluation!);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] ?? '';
      expect(message).toContain('Attention');
      expect(message).not.toContain('Delivery stopped');
      expect(message).toContain(text);
    }
  });

  it('does NOT warn for benign CareLink notification pings', () => {
    // 062 "New notification received from CareLink" is a push confirmation.
    // The vendor's own client suppresses its display name for this reason.
    for (const code of [62, 70] as const) {
      warnSpy.mockClear();
      const evaluation = evaluateLastAlarm(alarmFixture({ code }));
      logLastAlarm(evaluation!);
      expect(warnSpy).not.toHaveBeenCalled();
      // ...but it is still annotated, never dropped.
      expect(evaluation!.text).toBe('New notification received from CareLink');
    }
  });

  it('WARNs with a STOP USING PUMP banner for stop_using_pump severity', () => {
    // The stop_using_pump set is empty pending real fixture, but
    // logLastAlarm must format the banner correctly when the severity is
    // 'stop_using_pump'. Construct the evaluation manually so the test
    // exercises the same code path a real fixture would.
    const evalResult = {
      annotation: {
        code: 1024,
        datetime: '2026-07-21T00:00:00Z',
        text: 'Critical Pump Error. Stop Pump Use. Use Other Treatment',
        severity: 'stop_using_pump' as const,
      },
      severity: 'stop_using_pump' as const,
      text: 'Critical Pump Error. Stop Pump Use. Use Other Treatment',
    };
    logLastAlarm(evalResult);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(message).toMatch(/STOP USING PUMP/);
    expect(message).toContain('code=1024');
    expect(message).toContain('Critical Pump Error');
  });

  it('does NOT call console.warn for "other" severity alarms', () => {
    const evalResult = evaluateLastAlarm(alarmFixture({ code: 9999 }));
    expect(evalResult!.severity).toBe('other');
    logLastAlarm(evalResult!);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs the wire form (e.g. "N24") not just the parsed number (#84)', () => {
    // Operator-visible journald line must show what the pump sent, so an
    // operator investigating a "STOP USING PUMP" warning can correlate
    // directly with the pump's event log without translating prefixes.
    warnSpy.mockClear();
    const evalResult = evaluateLastAlarm(alarmFixture({ code: 'N24' }));
    expect(evalResult!.severity).toBe('stop_using_pump');
    logLastAlarm(evalResult!);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(message).toMatch(/STOP USING PUMP/);
    expect(message).toContain('code=N24');
    expect(message).toContain('Critical Pump Error');
  });

  it('logs the numeric form when the wire sent a number (#84)', () => {
    warnSpy.mockClear();
    const evalResult = evaluateLastAlarm(alarmFixture({ code: 16 }));
    expect(evalResult!.severity).toBe('delivery_stopped');
    logLastAlarm(evalResult!);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('code=16');
    expect(message).not.toMatch(/code=N16/);
  });
});

describe('safety contract: no ALARM reaches /api/v1/treatments in src/', () => {
  // Prong (c) — absence grep, SCOPED TO ALARMS.
  //
  // THE CONTRACT IS ABOUT ALARMS, NOT ABOUT THE TREATMENTS ENDPOINT.
  // Several NGP alarm codes mean "Critical Pump Error. Stop using pump" or
  // "Insulin delivery stopped". Auto-publishing those as Nightscout treatments
  // would put a machine-generated medical instruction into a record that reads
  // like a user entry, with no operator in the loop. So alarms surface as
  // devicestatus annotations ONLY.
  //
  // This guard was written as a blanket ban on the string `treatments` anywhere
  // in src/, which was correct while nothing legitimately posted there. Meals
  // and boluses now do (src/transform/treatments.ts): that is pump event data,
  // not an alarm, and dropping it was the bridge's largest missing-data gap.
  // The guard is therefore narrowed to what it protects — no code path may
  // carry an ALARM into a treatments payload.
  //
  // Narrowed, not weakened: the reviewed-file list below must be updated
  // deliberately when a new file posts treatments, and the assertion after it
  // fails if any of them mentions an alarm.
  const TREATMENTS_FILES = [
    'src/main.ts',
    'src/metrics.ts',
    'src/transform/index.ts',
    'src/transform/treatments.ts',
    'src/types/nightscout.ts',
  ];

  const srcRoot = path.resolve(__dirname, '..', 'src');

  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (entry.name.endsWith('.ts')) yield p;
    }
  }

  // F7 (R6) — the old guard was line-scoped and required the receiver to be
  // literally `axios.`, so it missed every form this codebase actually uses:
  // `this.axiosInstance.post(...)` (the idiom in client.ts), a multi-line call
  // with the URL on the next line, and any literal with a path prefix. Four of
  // five injected treatments call sites passed a green suite.
  //
  // The contract is zero non-comment references, so assert exactly that. There
  // are only four mentions of `treatments` in src/ at baseline, all in comments,
  // which this check confirms rather than assumes.
  it('every src file that mentions treatments is on the reviewed list', () => {
    const found: string[] = [];
    for (const file of walk(srcRoot)) {
      const raw = fs.readFileSync(file, 'utf8');
      const rel = path.relative(path.resolve(__dirname, '..'), file).split(path.sep).join('/');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (/\btreatments\b/i.test(line)) {
          if (!found.includes(rel)) found.push(rel);
          break;
        }
      }
    }
    // A new file posting treatments must be added here deliberately — that is
    // the whole point of the list. A file quietly starting to post treatments
    // fails, which is what the original blanket grep was protecting.
    expect(found.sort()).toEqual([...TREATMENTS_FILES].sort());
  });

  it('none of the treatments-posting files shapes an alarm into a treatment', () => {
    // THE ACTUAL CONTRACT. An alarm must never become a treatment.
    //
    // Scope matters here, and narrowing it is what makes this test honest:
    // `transform/index.ts` legitimately IMPORTS the alarm evaluator and writes
    // it to `last_alarm` on devicestatus — that is the approved channel. What
    // must not exist is alarm data reaching a treatments payload. So the
    // assertion is on alarm references that sit in a treatments context, not on
    // the bare word `alarm`.
    const offenders: { file: string; line: number; lineText: string }[] = [];
    for (const rel of TREATMENTS_FILES) {
      const file = path.resolve(__dirname, '..', rel);
      const raw = fs.readFileSync(file, 'utf8');
      for (const [lineno, line] of raw.split('\n').entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        // A line that mentions both an alarm and treatments is the shape this
        // forbids: it is where an alarm would be carried into a treatment.
        if (/\balarm/i.test(line) && /\btreatments?\b/i.test(line)) {
          offenders.push({ file: rel, line: lineno + 1, lineText: trimmed.slice(0, 120) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('treatments.ts never reads an alarm field', () => {
    // The mapper itself must be blind to alarms: it takes `markers` only.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/transform/treatments.ts'),
      'utf8',
    );
    const code = src
      .split('\n')
      .filter((l) => !(l.trim().startsWith('//') || l.trim().startsWith('*')))
      .join('\n');
    expect(code).not.toMatch(/lastAlarm|alarmCode|sLastAlarm/i);
  });

  it('contains no POST/PUT/PATCH call site targeting treatments, any receiver or line span', () => {
    const offenders: { file: string; line: number; lineText: string }[] = [];
    for (const file of walk(srcRoot)) {
      const raw = fs.readFileSync(file, 'utf8');
      // Drop only full-line comments — never regex-stripped block comments, per
      // the note above — then flatten whitespace so a call and its URL may be
      // split across lines without evading the check.
      const flat = raw
        .split('\n')
        .filter((l) => !(l.trim().startsWith('//') || l.trim().startsWith('*')))
        .join(' ')
        .replace(/\s+/g, ' ');
      for (const m of flat.matchAll(
        /\b(?:axios|axiosInstance|httpClient|request|client)\s*\.\s*(?:post|put|patch)\s*\(/g,
      )) {
        const window = flat.slice(m.index, m.index + 400);
        if (/\btreatments\b/.test(window)) {
          offenders.push({ file, line: 0, lineText: window.slice(0, 160) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no string literal matching "treatments.json"', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (/['"`]treatments\.json['"`]/.test(raw)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
