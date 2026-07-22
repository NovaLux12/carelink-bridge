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
 * Safety contract (research/medtronic-carelink-2026-07-21/03-data-model-and-gaps.md,
 * memo lines 23-25): priority-1 alarms get a WARN log but NEVER auto-publish
 * to Nightscout /api/v1/treatments.json.
 */

function alarmFixture(overrides?: Partial<{ code: number; datetime: string }>): CareLinkData['lastAlarm'] {
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
      text: 'Insulin delivery stopped',
      severity: 'delivery_stopped',
    });
  });

  it('classifies paradigm-era delivery-stopped codes (4/5/6/16/43/61)', () => {
    for (const code of [4, 5, 6, 16, 43, 61] as const) {
      const result = evaluateLastAlarm(alarmFixture({ code }));
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('delivery_stopped');
      expect(result!.annotation.severity).toBe('delivery_stopped');
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
      text: 'Insulin delivery stopped',
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

  it('WARNs for delivery_stopped codes (paradigm 4/5/6/16/43/61)', () => {
    // Prong (b) — priority-1 codes always warn, even with verbose off.
    for (const code of [4, 5, 6, 16, 43, 61] as const) {
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

  it('WARNs with a STOP USING PUMP banner for stop_using_pump severity', () => {
    // The stop_using_pump set is empty pending real fixture, but
    // logLastAlarm must format the banner correctly when the severity is
    // 'stop_using_pump'. Construct the evaluation manually so the test
    // exercises the same code path a real fixture would.
    const evalResult = {
      annotation: {
        code: 1024,
        datetime: '2026-07-21T00:00:00Z',
        text: 'Critical Pump Error. Stop using pump.',
        severity: 'stop_using_pump' as const,
      },
      severity: 'stop_using_pump' as const,
      text: 'Critical Pump Error. Stop using pump.',
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
});

describe('safety contract: no /api/v1/treatments call sites in src/', () => {
  // Prong (c) — absence grep. Walking the entire src/ tree and asserting
  // no non-comment, non-string-literal reference to the treatments endpoint.
  // A future contributor adding `axios.post('/api/v1/treatments', ...)` or
  // `fetch('/treatments.json')` will fail this test. The contract: alarms
  // surface as Nightscout devicestatus annotations ONLY.

  const srcRoot = path.resolve(__dirname, '..', 'src');

  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (entry.name.endsWith('.ts')) yield p;
    }
  }

  it('contains no axios/fetch POST whose body/URL mentions treatments', () => {
    const offenders: { file: string; line: number; lineText: string }[] = [];
    for (const file of walk(srcRoot)) {
      const raw = fs.readFileSync(file, 'utf8');
      // Strip /*...*/ block comments and // line comments before checking,
      // so documented absence references ("NEVER publishes to /api/v1/
      // treatments.json") don't trip the assertion.
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      for (const [lineno, line] of stripped.split('\n').entries()) {
        if (
          (/\baxios\.(?:post|put|patch)\s*\(/.test(line)
            || /\bfetch\s*\(/.test(line)
            || /\bhttpClient\.(?:post|put|patch)\s*\(/.test(line))
          && /\btreatments\b/.test(line)
        ) {
          offenders.push({ file, line: lineno + 1, lineText: line });
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
