import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoginData } from '../src/types/carelink.js';
import {
  writeLoginDataAtomic,
  tightenLoginDataIfLoose,
  loadLoginData,
} from '../src/carelink/token.js';

// tightenLoginDataIfLoose early-returns on win32 (default ACL is user-only
// there) and mode 0o600 has no portable meaning. Gate the POSIX-specific
// assertions so the suite stays green on every platform while still proving
// the world-readable-window fix on Linux where it matters.
const isPosix = process.platform !== 'win32';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carelink-atomic-'));
}

function loginDataFixture(overrides?: Partial<LoginData>): LoginData {
  return {
    access_token: 'header.payload.sig',
    refresh_token: 'refresh-token-value',
    client_id: 'client-abc',
    token_url: 'https://example.com/oauth/token',
    scope: 'openid profile',
    audience: 'carepartner.patient.us',
    ...overrides,
  };
}

describe('writeLoginDataAtomic', () => {
  let dir: string;
  let filePath: string;
  let tmpPath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = path.join(dir, 'logindata.json');
    tmpPath = filePath + '.tmp';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(isPosix)('writes the destination file with valid JSON and 0o600 mode', () => {
    const data = loginDataFixture({ access_token: 'a.b.c' });
    writeLoginDataAtomic(filePath, data);

    // tmp consumed by rename
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);

    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.access_token).toBe('a.b.c');
    expect(written.refresh_token).toBe('refresh-token-value');
  });

  it.runIf(isPosix)('creates the temp file with mode 0o600 BEFORE the rename', () => {
    // The point of using O_CREAT|O_EXCL with mode 0o600 (rather than
    // writeFileSync + chmod) is that the world-readable window between create
    // and chmod is closed. Intercept the rename to capture the temp file's
    // mode in-flight, before rename consumes it.
    let capturedMode: number | null = null;
    const originalRename = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = (
      src: fs.PathLike,
      _dst: fs.PathLike,
    ) => {
      const stat = fs.statSync(src);
      capturedMode = stat.mode & 0o777;
      originalRename(src, filePath);
    };

    try {
      writeLoginDataAtomic(filePath, loginDataFixture());
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRename;
    }

    expect(capturedMode).not.toBeNull();
    expect(capturedMode).toBe(0o600);

    // POSIX rename preserves the source inode's mode — the destination is
    // also 0o600.
    const destMode = fs.statSync(filePath).mode & 0o777;
    expect(destMode).toBe(0o600);
  });

  it.runIf(isPosix)('recovers when a stale .tmp sidecar is left from a previous crash', () => {
    // Simulate a previous crash that left a sidecar on disk.
    fs.writeFileSync(tmpPath, 'garbage-from-a-crash');

    // A second call must not error with EEXIST and must overwrite the sidecar.
    writeLoginDataAtomic(filePath, loginDataFixture({ access_token: 'fresh.1.2' }));

    expect(fs.existsSync(tmpPath)).toBe(false);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written.access_token).toBe('fresh.1.2');
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('does not follow a symlink — refuses to tighten', () => {
    // Refuses to chmod a symlink target (lstat sees the symlink itself, not
    // the destination); on Windows, tightenLoginDataIfLoose is a no-op so this
    // test passes trivially — safe to leave running on every platform.
    const target = path.join(dir, 'logindata.json');
    fs.writeFileSync(target, 'placeholder');
    const symlink = path.join(dir, 'logindata-symlink.json');
    try {
      fs.symlinkSync(target, symlink);
    } catch {
      // Some CI environments disallow symlinks; skip silently.
      return;
    }

    tightenLoginDataIfLoose(symlink);

    // The target's mode must NOT have been changed via the symlink path —
    // lstat on the symlink itself tells us nothing about the target.
    const targetStat = fs.statSync(target);
    expect(targetStat.mode & 0o777).not.toBe(0o600);
  });

  it.runIf(isPosix)('loadLoginData tightens a pre-existing loose file as part of the read path', () => {
    // Upgrade-path scenario: pre-existing logindata.json was written by an
    // older version of the bridge under a 022 umask → 0644. Reading it must
    // tighten it in-place.
    fs.writeFileSync(filePath, JSON.stringify(loginDataFixture(), null, 4), { mode: 0o644 });

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);

    const loaded = loadLoginData(filePath);

    expect(loaded).not.toBeNull();
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('loadLoginData leaves a missing file alone (tighten-on-read is a no-op there)', () => {
    expect(fs.existsSync(filePath)).toBe(false);
    const loaded = loadLoginData(filePath);
    expect(loaded).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
