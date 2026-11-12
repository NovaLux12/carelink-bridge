/**
 * Metric label correctness for the three upload targets.
 *
 * The bridge posts to three Nightscout collections — `entries`, `devicestatus`
 * and `treatments`. The metric label used to be derived with a two-way test
 * (`endpoint.includes('entries') ? 'entries' : 'devicestatus'`), which was
 * correct while there were only two targets and silently wrong the moment
 * treatments became a third: every treatment upload incremented the
 * *devicestatus* counter, so an operator reading `/metrics` after enabling pump
 * data would see devicestatus climb and treatments stay at zero.
 *
 * These tests pin the label mapping so that failure cannot recur.
 */

import { describe, expect, it } from 'vitest';
import { incUpload, renderPrometheus, reset } from '../src/metrics.js';

function valueFor(endpoint: string): number {
  const line = renderPrometheus()
    .split('\n')
    .find((l) => l.startsWith(`carelink_uploads_total{endpoint="${endpoint}"}`));
  if (!line) throw new Error(`no metrics line for endpoint ${endpoint}`);
  return Number(line.split(' ').pop());
}

describe('carelink_uploads_total endpoint labels', () => {
  it('counts treatments separately from devicestatus', () => {
    reset();
    incUpload('treatments', 7);
    expect(valueFor('treatments')).toBe(7);
    expect(valueFor('devicestatus')).toBe(0);
    expect(valueFor('entries')).toBe(0);
  });

  it('keeps all three counters independent', () => {
    reset();
    incUpload('entries', 3);
    incUpload('devicestatus', 5);
    incUpload('treatments', 2);
    expect(valueFor('entries')).toBe(3);
    expect(valueFor('devicestatus')).toBe(5);
    expect(valueFor('treatments')).toBe(2);
  });

  it('exposes a treatments series at all', () => {
    reset();
    const rendered = renderPrometheus();
    expect(rendered).toContain('carelink_uploads_total{endpoint="treatments"}');
  });

  it('reset zeroes every endpoint including treatments', () => {
    reset();
    incUpload('treatments', 9);
    reset();
    expect(valueFor('treatments')).toBe(0);
  });
});
