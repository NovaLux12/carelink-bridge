import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultState,
  loadPersistentState,
  savePersistentState,
  STATE_VERSION,
} from '../src/persistent-state.js';

/**
 * Persistent state file contract (issue #9 item 4).
 *
 * state.json (gitignored, mode 600) survives restarts. Same crash-safe
 * posture as logindata.json: atomic sibling+rename, 0600 at creation,
 * symlink refusal, fresh-default on missing/corrupt.
 */
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carelink-state-'));
  file = path.join(dir, 'state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistent-state', () => {
  it('returns a fresh default when the file is missing', () => {
    expect(loadPersistentState(file)).toEqual({
      version: STATE_VERSION,
      lastSuccessTimestamp: null,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      lastRefreshTokenUse: null,
      nextScheduledRefresh: null,
    });
    expect(defaultState().version).toBe(1);
  });

  it('round-trips all four tracked fields', () => {
    savePersistentState(file, {
      version: 1,
      lastSuccessTimestamp: 1_700_000_000_000,
      consecutiveFailures: 3,
      circuitOpenUntil: 1_700_000_060_000,
      lastRefreshTokenUse: 1_699_999_999_000,
      nextScheduledRefresh: 1_700_000_300_000,
    });
    expect(loadPersistentState(file)).toEqual({
      version: 1,
      lastSuccessTimestamp: 1_700_000_000_000,
      consecutiveFailures: 3,
      circuitOpenUntil: 1_700_000_060_000,
      lastRefreshTokenUse: 1_699_999_999_000,
      nextScheduledRefresh: 1_700_000_300_000,
    });
  });

  it('writes mode 0600 and tightens a loose file on read', () => {
    if (process.platform === 'win32') return;
    savePersistentState(file, defaultState());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    loadPersistentState(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('returns default on corrupt JSON and on wrong version/shape', () => {
    fs.writeFileSync(file, '{not json');
    expect(loadPersistentState(file)).toEqual(defaultState());
    fs.writeFileSync(file, JSON.stringify({ version: 999 }));
    expect(loadPersistentState(file)).toEqual(defaultState());
    fs.writeFileSync(file, JSON.stringify({ version: 1, consecutiveFailures: 'three' }));
    expect(loadPersistentState(file)).toEqual(defaultState());
  });

  it('leaves no .tmp sidecar after save', () => {
    savePersistentState(file, defaultState());
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('refuses to write through a symlinked destination', () => {
    const target = path.join(dir, 'real.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, file);
    expect(() => savePersistentState(file, defaultState())).toThrow(/symlink/i);
  });
});
