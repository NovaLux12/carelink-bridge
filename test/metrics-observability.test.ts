/**
 * Metrics added for issue #134: data age, stale flag, upload failures, and
 * the token-refresh counter that previously had no call site.
 *
 * Each test pins the exposition line — metric name, TYPE, and label set — not
 * just the setter's return value. A getter that returns 7 while the renderer
 * emits nothing is exactly the bug this file exists to catch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  incUploadFailure,
  incTokenRefresh,
  setNewestReading,
  setStale,
  renderPrometheus,
  reset,
  dataAgeSeconds,
  classifyUploadFailure,
  UPLOAD_FAILURE_REASONS,
} from '../src/metrics.js';

/** Find the single exposition line beginning with `prefix`, or throw. */
function lineFor(prefix: string): string {
  const found = renderPrometheus()
    .split('\n')
    .filter((l) => l.startsWith(prefix));
  if (found.length !== 1) {
    throw new Error(`expected exactly 1 line for "${prefix}", got ${found.length}`);
  }
  return found[0]!;
}

function valueOf(prefix: string): number {
  return Number(lineFor(prefix).split(' ').pop());
}

function typeOf(metric: string): string {
  const line = renderPrometheus()
    .split('\n')
    .find((l) => l.startsWith(`# TYPE ${metric} `));
  if (!line) throw new Error(`no TYPE line for ${metric}`);
  return line.split(' ').pop()!;
}

beforeEach(() => {
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('carelink_data_age_seconds', () => {
  it('is present as a gauge and reports -1 when no reading has been seen', () => {
    expect(typeOf('carelink_data_age_seconds')).toBe('gauge');
    expect(lineFor('carelink_data_age_seconds ')).toBe('carelink_data_age_seconds -1');
    expect(dataAgeSeconds()).toBeNull();
  });

  it('reports the age of the newest reading in seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    // A reading stamped five minutes before now.
    setNewestReading(Date.parse('2026-11-14T11:55:00Z'));
    expect(dataAgeSeconds()).toBe(300);
    expect(lineFor('carelink_data_age_seconds ')).toBe('carelink_data_age_seconds 300');
  });

  it('clamps a future-dated reading to 0 rather than emitting a negative age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    setNewestReading(Date.parse('2026-11-14T12:05:00Z'));
    expect(valueOf('carelink_data_age_seconds ')).toBe(0);
  });

  it('reset returns the series to the never-seen sentinel', () => {
    setNewestReading(Date.now() - 60_000);
    reset();
    expect(lineFor('carelink_data_age_seconds ')).toBe('carelink_data_age_seconds -1');
  });
});

describe('carelink_stale', () => {
  it('is a gauge, 0 by default', () => {
    expect(typeOf('carelink_stale')).toBe('gauge');
    expect(lineFor('carelink_stale ')).toBe('carelink_stale 0');
  });

  it('moves to 1 and back', () => {
    setStale(true);
    expect(lineFor('carelink_stale ')).toBe('carelink_stale 1');
    setStale(false);
    expect(lineFor('carelink_stale ')).toBe('carelink_stale 0');
  });

  it('reset clears the flag', () => {
    setStale(true);
    reset();
    expect(lineFor('carelink_stale ')).toBe('carelink_stale 0');
  });
});

describe('carelink_upload_failures_total', () => {
  it('is a counter with endpoint and reason labels', () => {
    expect(typeOf('carelink_upload_failures_total')).toBe('counter');
    const line = lineFor('carelink_upload_failures_total{endpoint="entries",reason="http_5xx"} ');
    expect(line).toBe('carelink_upload_failures_total{endpoint="entries",reason="http_5xx"} 0');
  });

  it('emits every endpoint/reason pair up front so alerts can read a zero', () => {
    // 3 endpoints x 5 reasons = 15 series, all present before any failure.
    const series = renderPrometheus()
      .split('\n')
      .filter((l) => l.startsWith('carelink_upload_failures_total{'));
    expect(series).toHaveLength(15);
    for (const reason of ['network', 'http_4xx', 'http_5xx', 'discarded', 'unknown']) {
      for (const endpoint of ['entries', 'devicestatus', 'treatments']) {
        expect(series).toContain(
          `carelink_upload_failures_total{endpoint="${endpoint}",reason="${reason}"} 0`,
        );
      }
    }
  });

  it('increments only the matching endpoint/reason pair', () => {
    incUploadFailure('entries', 'network');
    incUploadFailure('entries', 'network');
    incUploadFailure('treatments', 'http_4xx');

    expect(valueOf('carelink_upload_failures_total{endpoint="entries",reason="network"} ')).toBe(2);
    expect(valueOf('carelink_upload_failures_total{endpoint="treatments",reason="http_4xx"} ')).toBe(1);
    // Untouched pairs stay zero — no cross-talk between labels.
    expect(valueOf('carelink_upload_failures_total{endpoint="devicestatus",reason="network"} ')).toBe(0);
    expect(valueOf('carelink_upload_failures_total{endpoint="entries",reason="http_4xx"} ')).toBe(0);
  });

  it('does not leak an untyped reason into the label set', () => {
    // TypeScript already forbids this; the assert documents the runtime reason
    // the label is a closed union rather than a free-form error string.
    const rendered = renderPrometheus();
    expect(rendered).not.toMatch(/reason="[^"]*(timeout|ECONNREFUSED)[^"]*"/);
  });
});

describe('classifyUploadFailure', () => {
  it('reads an axios response status', () => {
    expect(classifyUploadFailure({ response: { status: 503 } })).toBe('http_5xx');
    expect(classifyUploadFailure({ response: { status: 401 } })).toBe('http_4xx');
  });

  it('reads the status out of upload.ts its own thrown message', () => {
    // src/nightscout/upload.ts:44 — 'Error uploading to Nightscout: HTTP 502'
    expect(
      classifyUploadFailure(new Error('Error uploading to Nightscout: HTTP 502')),
    ).toBe('http_5xx');
    expect(
      classifyUploadFailure(new Error('Error uploading to Nightscout: HTTP 400')),
    ).toBe('http_4xx');
  });

  it('gives the silent-discard case its own reason', () => {
    // src/nightscout/upload.ts:54-57 — 200 but nothing stored.
    expect(
      classifyUploadFailure(
        new Error(
          'Nightscout accepted the request but stored 0 of 3 item(s) — the payload was silently discarded',
        ),
      ),
    ).toBe('discarded');
    expect(
      classifyUploadFailure(
        new Error(
          'Nightscout returned a non-array body (object) — cannot verify what was stored; treating as a failed upload',
        ),
      ),
    ).toBe('discarded');
  });

  it('classifies transport failures as network', () => {
    expect(classifyUploadFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe(
      'network',
    );
    expect(classifyUploadFailure(new Error('socket hang up'))).toBe('network');
    expect(classifyUploadFailure(new Error('timeout of 30000ms exceeded'))).toBe('network');
  });

  it('falls back to unknown rather than inventing a reason', () => {
    expect(classifyUploadFailure(new Error('something odd'))).toBe('unknown');
    expect(classifyUploadFailure(null)).toBe('unknown');
    expect(classifyUploadFailure(undefined)).toBe('unknown');
    expect(classifyUploadFailure('string thrown')).toBe('unknown');
  });

  it('never returns a value outside the closed set', () => {
    const inputs: unknown[] = [
      new Error('x'),
      { response: { status: 500 } },
      { response: { status: 200 } },
      null,
      42,
    ];
    for (const input of inputs) {
      expect(UPLOAD_FAILURE_REASONS).toContain(classifyUploadFailure(input));
    }
  });
});

describe('carelink_token_refreshes_total', () => {
  it('is a counter with a result label, rendered as zero before any refresh', () => {
    expect(typeOf('carelink_token_refreshes_total')).toBe('counter');
    expect(lineFor('carelink_token_refreshes_total{result="success"} ')).toBe(
      'carelink_token_refreshes_total{result="success"} 0',
    );
    expect(lineFor('carelink_token_refreshes_total{result="failure"} ')).toBe(
      'carelink_token_refreshes_total{result="failure"} 0',
    );
  });

  it('increments both result labels independently', () => {
    incTokenRefresh('success');
    incTokenRefresh('success');
    incTokenRefresh('failure');
    expect(valueOf('carelink_token_refreshes_total{result="success"} ')).toBe(2);
    expect(valueOf('carelink_token_refreshes_total{result="failure"} ')).toBe(1);
  });

  it('reset zeroes both', () => {
    incTokenRefresh('success');
    reset();
    expect(valueOf('carelink_token_refreshes_total{result="success"} ')).toBe(0);
  });
});
