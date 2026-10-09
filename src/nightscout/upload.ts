import crypto from 'node:crypto';
import axios from 'axios';
import * as logger from '../logger.js';

export async function upload(
  entries: unknown[],
  endpoint: string,
  secret: string,
): Promise<void> {
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
}
