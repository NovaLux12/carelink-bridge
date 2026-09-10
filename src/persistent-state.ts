/**
 * Persistent bridge state (v0.3.0 reliability, issue #9 item 4).
 *
 * In-memory state is lost on every restart. This file tracks across restarts:
 *   - lastSuccessTimestamp (for the stale-data alert from v0.2.0)
 *   - consecutiveFailures + circuitOpenUntil (for the circuit breaker)
 *   - lastRefreshTokenUse (when the OAuth refresh token was last used)
 *   - nextScheduledRefresh (proactive refresh target, exp minus margin)
 *
 * Security: same posture as logindata.json — atomic write via O_CREAT|O_EXCL
 * sibling + rename, mode 0600 at creation, refuse symlinks. The state holds
 * timestamps and counters (no tokens), but it lives next to the token file
 * and inherits the same handling so a future field can't leak by accident.
 */

import fs from 'node:fs';
import * as logger from './logger.js';

const SECRET_FILE_MODE = 0o600;
export const STATE_VERSION = 1;

export interface PersistentState {
  version: number;
  lastSuccessTimestamp: number | null;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastRefreshTokenUse: number | null;
  nextScheduledRefresh: number | null;
}

export function defaultState(): PersistentState {
  return {
    version: STATE_VERSION,
    lastSuccessTimestamp: null,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
    lastRefreshTokenUse: null,
    nextScheduledRefresh: null,
  };
}

function tightenSecretFileIfLoose(filePath: string): void {
  if (process.platform === 'win32') return;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return;
    if ((stat.mode & 0o777) === SECRET_FILE_MODE) return;
    fs.chmodSync(filePath, SECRET_FILE_MODE);
  } catch {
    // Missing file or race — not worth failing on.
  }
}

function isValidState(data: unknown): data is PersistentState {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d['version'] !== STATE_VERSION) return false;
  if (d['lastSuccessTimestamp'] !== null && typeof d['lastSuccessTimestamp'] !== 'number') return false;
  if (typeof d['consecutiveFailures'] !== 'number') return false;
  if (typeof d['circuitOpenUntil'] !== 'number') return false;
  if (d['lastRefreshTokenUse'] !== null && typeof d['lastRefreshTokenUse'] !== 'number') return false;
  if (d['nextScheduledRefresh'] !== null && typeof d['nextScheduledRefresh'] !== 'number') return false;
  return true;
}

export function loadPersistentState(filePath: string): PersistentState {
  try {
    if (!fs.existsSync(filePath)) return defaultState();
    tightenSecretFileIfLoose(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    const data: unknown = JSON.parse(raw);
    if (!isValidState(data)) {
      logger.warn('state.json invalid (version/shape) — starting fresh', { component: 'state', path: filePath });
      return defaultState();
    }
    return data;
  } catch (e) {
    logger.error('Failed to read state.json', { component: 'state', error: (e as Error).message, path: filePath });
    return defaultState();
  }
}

/**
 * Atomic 0600 write (same crash-safe pattern as writeLoginDataAtomic in
 * token.ts). Refuses to write through a symlinked destination.
 */
export function savePersistentState(filePath: string, state: PersistentState): void {
  const tmpPath = filePath + '.tmp';

  try {
    fs.unlinkSync(tmpPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // Refuse symlinked destination so a redirected path can't capture state.
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error('Refusing to write through symlinked state.json');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const O_CREAT = 0o100;
  const O_WRONLY = 0o1;
  const O_EXCL = 0o200;
  const fd = fs.openSync(tmpPath, O_CREAT | O_WRONLY | O_EXCL, SECRET_FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, filePath);
  tightenSecretFileIfLoose(filePath);
}
