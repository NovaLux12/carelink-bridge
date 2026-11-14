import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { upload } from '../src/nightscout/upload.js';

vi.mock('axios');

/**
 * Nightscout answers HTTP 200 even when it discards the payload.
 *
 *   lib/api/entries/index.js:296-299 — a single-object POST with no `date` is
 *     replaced with `[]`: 200, nothing stored, no error.
 *   lib/server/entries.js:301-316 — entries dedup on (sysTime, type) by upsert,
 *     so a re-post UPDATES rather than inserts.
 *
 * Therefore status 200 is not proof of storage, and the response count is the
 * only honest signal. Claiming "Upload succeeded" for a discarded payload is
 * exactly the silent failure this guards.
 */
const post = vi.mocked(axios.post);

function respond(data: unknown, status = 200) {
  post.mockResolvedValue({ status, data } as never);
}

describe('upload() response verification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the number Nightscout says it stored', async () => {
    respond([{ _id: 'a' }, { _id: 'b' }]);
    await expect(upload([{}, {}], 'https://ns/api/v1/entries', 's')).resolves.toBe(2);
  });

  it('throws when Nightscout stores nothing', async () => {
    // The silent-discard case. Must not be reported as success.
    respond([]);
    await expect(upload([{ sgv: 120 }], 'https://ns/api/v1/entries', 's')).rejects.toThrow(
      /stored 0 of 1/,
    );
  });

  it('reports a lower stored count rather than assuming the sent count', async () => {
    // Dedup: 3 sent, 2 stored because one upserted an existing row.
    respond([{ _id: 'a' }, { _id: 'b' }]);
    await expect(upload([{}, {}, {}], 'https://ns/api/v1/entries', 's')).resolves.toBe(2);
  });

  it('throws on a non-200 status', async () => {
    respond({}, 500);
    await expect(upload([{}], 'https://ns/api/v1/entries', 's')).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the body is not an array, rather than claiming a stored count', async () => {
    // CORRECTED 2026-11-13. This used to assert `resolves.toBe(2)` — i.e. that
    // the bridge reported success for a payload it never verified. Measured
    // against a Nightscout behind a proxy/SSO answering `200 text/html` with a
    // login page: old code reported stored=2, nothing was written. A non-array
    // body cannot be checked, so it is a named failure, not a silent success.
    respond({ ok: true });
    await expect(upload([{}, {}], 'https://ns/api/v1/devicestatus', 's')).rejects.toThrow(
      /non-array body/,
    );
  });
});
