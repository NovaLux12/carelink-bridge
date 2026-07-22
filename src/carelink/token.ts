import fs from 'node:fs';
import axios from 'axios';
import qs from 'qs';
import type { LoginData } from '../types/carelink.js';

const SECRET_FILE_MODE = 0o600;

/**
 * Tightens an existing logindata.json to mode 0600 in-place. Safe to call on
 * a fresh 0600 file (no-op). Idempotent. Intended to be called on read so an
 * upgrade from an older bridge that wrote the file loose (umask 022 → 0644)
 * gets closed without a one-shot migration step. Refuses to follow symlinks.
 */
export function tightenLoginDataIfLoose(filePath: string): void {
  if (process.platform === 'win32') return; // Windows default ACL is user-only
  try {
    const stat = fs.lstatSync(filePath); // lstat — do not follow symlinks
    if (stat.isSymbolicLink()) {
      console.log('[Token] Refusing to tighten symlinked logindata.json');
      return;
    }
    const current = (stat.mode & 0o777);
    if (current === SECRET_FILE_MODE) return;
    fs.chmodSync(filePath, SECRET_FILE_MODE);
  } catch {
    // Missing file or race with another process — not worth failing on.
  }
}

export function loadLoginData(filePath: string): LoginData | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    // Upgrade-path tightening: a file written by an older bridge under umask
    // 022 was 0644. Close that window in-place on first read; idempotent.
    tightenLoginDataIfLoose(filePath);

    const data: LoginData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const required: (keyof LoginData)[] = ['access_token', 'refresh_token', 'client_id', 'token_url'];

    for (const field of required) {
      if (!data[field]) {
        console.log('[Token] logindata.json missing field: ' + field);
        return null;
      }
    }
    return data;
  } catch (e) {
    console.log('[Token] Failed to read logindata.json:', (e as Error).message);
    return null;
  }
}


/**
 * Atomically writes LoginData (which contains the CareLink OAuth tokens — full
 * account access per SECURITY.md) with mode 0600, surviving a crash between
 * the temp-file create and the rename. Replaces the prior `saveLoginData`
 * `fs.writeFileSync` path that left a brief world-readable window on a
 * typical umask-022 box and that clobbered the destination non-atomically.
 *
 * Threat model: any local OS user can read the file between `open` and
 * `rename`. We close that window by `openSync(O_CREAT|O_EXCL, 0o600)` so the
 * mode is set at creation (no chmod-after-create window) and by using a fresh
 * sibling path (`logindata.json.tmp`) so the destination either still holds
 * the previous tokens or holds the new ones — never partial.
 *
 * Refuses to write through a symlink so an attacker who controls the file
 * path cannot redirect the token write to a location they can read.
 */
export function writeLoginDataAtomic(filePath: string, data: LoginData): void {
  const tmpPath = filePath + '.tmp';

  // 1. Pre-clear any stale sidecar from a previous crash (between temp write
  //    and rename). Without this, O_EXCL below would error on a leftover
  //    sidecar and turn a one-off crash into a permanent save failure.
  try {
    fs.unlinkSync(tmpPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 2. Open the temp file with O_CREAT|O_EXCL|O_WRONLY so we never truncate an
  //    existing destination and the mode is set atomically at file creation.
  //    POSIX applies `mode` at open time — no chmod-after-create gap. O_EXCL
  //    also defends against a symlinked tmpPath (in the unlikely event a
  //    pre-existing logindata.json.tmp is itself a symlink, the open fails
  //    rather than silently writing through it).
  //    'w' constant in Node would truncate; we need the explicit bitmask to
  //    carry O_EXCL. Node does not expose a numeric constants export for
  //    these flags, so use the documented libc values.
  const O_CREAT = 0o100;
  const O_WRONLY = 0o1;
  const O_EXCL = 0o200;
  const fd = fs.openSync(tmpPath, O_CREAT | O_WRONLY | O_EXCL, SECRET_FILE_MODE);

  try {
    const payload = JSON.stringify(data, null, 4);
    fs.writeSync(fd, payload);
    // Force the bytes (and the mode metadata) to disk before the rename so a
    // crash before rename does not leave a partial temp file as the only
    // recoverable token state.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // 3. POSIX rename is atomic w.r.t. concurrent readers and replaces the
  //    destination in-place. If the destination was a loose file (upgrade
  //    path), tighten the new file too so subsequent loads get a clean mode.
  fs.renameSync(tmpPath, filePath);
  tightenLoginDataIfLoose(filePath);
}

/**
 * Decodes the payload (claims) of a JWT access token without verifying its
 * signature — we only read claims we already trust the server for (exp,
 * token_details). Returns null for a malformed token.
 */
export function decodeTokenPayload(accessToken: string): Record<string, unknown> | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function isTokenExpired(accessToken: string): boolean {
  const payload = decodeTokenPayload(accessToken);
  if (!payload || typeof payload.exp !== 'number') return true;

  // Expired if less than 10 minutes remaining — wide enough that a token
  // passing this check can't expire mid-fetch (matches the margin used by
  // carelink-python-client's reference implementation).
  return payload.exp * 1000 < Date.now() + 600 * 1000;
}

export async function refreshToken(loginData: LoginData): Promise<LoginData> {
  console.log('[Token] Refreshing access token...');

  const resp = await axios.post(
    loginData.token_url,
    qs.stringify({
      grant_type: 'refresh_token',
      client_id: loginData.client_id,
      refresh_token: loginData.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  loginData.access_token = resp.data.access_token;
  if (resp.data.refresh_token) {
    loginData.refresh_token = resp.data.refresh_token;
  }

  console.log('[Token] Token refreshed successfully');
  return loginData;
}
