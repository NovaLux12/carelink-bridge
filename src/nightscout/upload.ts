import crypto from 'node:crypto';
import axios from 'axios';
import * as logger from '../logger.js';

/**
 * Upload entries and return HOW MANY Nightscout actually stored.
 *
 * Nightscout answers HTTP 200 even when it discards the payload. From
 * `cgm-remote-monitor` (v15.0.9):
 *
 *   - `lib/api/entries/index.js:296-299` replaces a SINGLE-OBJECT payload that
 *     has no `date` with `[]` — HTTP 200, nothing stored, no error.
 *   - Entries are deduplicated on `(sysTime, type)` by upsert
 *     (`lib/server/entries.js:301-316`), and `sysTime` is derived from
 *     `dateString` first. A re-POST therefore UPDATES an existing row rather
 *     than inserting, and the response contains the stored `_id`.
 *   - devicestatus dedups on `_id` only and silently drops duplicates.
 *
 * So `status === 200` is not evidence of a successful upload, and the count in
 * the response is the only honest signal. Returning it lets the caller log and
 * metric the truth instead of claiming success for a payload that vanished.
 */
export async function upload(
  entries: unknown[],
  endpoint: string,
  secret: string,
): Promise<number> {
  // Verbose-only (#90): this logs the FULL upload payload, i.e. every glucose
  // value. Deliberate debug facility, silent by default — do not move this to
  // info/warn/error or it lands in every operator's journal.
  logger.log('POST ' + endpoint + ' ' + JSON.stringify(entries));

  const hashedSecret = crypto.createHash('sha1').update(secret).digest('hex');

  const response = await axios.post(endpoint, entries, {
    headers: { 'api-secret': hashedSecret },
  });

  if (response.status !== 200) {
    throw new Error('Error uploading to Nightscout: HTTP ' + response.status);
  }

  // The response echoes the stored documents. A non-array body means an
  // unexpected shape — refuse to claim a count we cannot read.
  const stored = response.data;
  if (Array.isArray(stored)) {
    if (stored.length === 0 && entries.length > 0) {
      // This is the silent-discard case, and it must be loud: nothing was
      // written, and without this the caller would log "Upload succeeded".
      throw new Error(
        'Nightscout accepted the request but stored 0 of ' + entries.length +
          ' item(s) — the payload was silently discarded',
      );
    }
    return stored.length;
  }

  logger.log(
    'Upload response was not an array (' + typeof stored + ') — stored count unknown',
  );
  return entries.length;
}
