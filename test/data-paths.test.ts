import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { siblingDataFile } from '../src/data-paths.js';

/**
 * Regression for the single-file bundle's token path.
 *
 * The bundle (`npm run bundle`) is one `.mjs` file with no `dist/` around it.
 * The old `path.join(__dirname, '..', 'logindata.json')` therefore resolved the
 * token one directory ABOVE the bundle — measured: a bundle at
 * `/tmp/bundletest/carelink-bridge.mjs` looked for `/tmp/logindata.json`. Under
 * a hardened systemd unit that directory is not writable, so login would fail
 * with a bare EACCES and no explanation.
 */

/** Build a file: URL the way Node would for a module at this path. */
function metaUrlFor(absolutePath: string): string {
  return new URL(`file://${absolutePath}`).href;
}

describe('siblingDataFile()', () => {
  it('steps UP out of a dist/ directory (the compiled-from-source layout)', () => {
    // <repo>/dist/login.js -> <repo>/logindata.json
    const url = metaUrlFor('/srv/carelink-bridge/dist/login.js');
    expect(siblingDataFile(url, 'logindata.json')).toBe(
      path.join('/srv/carelink-bridge', 'logindata.json'),
    );
  });

  it('stays PUT for the single-file bundle (no dist/ directory)', () => {
    // /tmp/bundletest/carelink-bridge.mjs -> /tmp/bundletest/logindata.json
    // The pre-fix behaviour was /tmp/logindata.json, one level too high.
    const url = metaUrlFor('/tmp/bundletest/carelink-bridge.mjs');
    expect(siblingDataFile(url, 'logindata.json')).toBe(
      path.join('/tmp/bundletest', 'logindata.json'),
    );
  });

  it('does not step up merely because a parent is called dist/', () => {
    // The decision must key on the file's OWN directory, not any ancestor.
    const url = metaUrlFor('/srv/dist/bundle/carelink-bridge.mjs');
    expect(siblingDataFile(url, 'logindata.json')).toBe(
      path.join('/srv/dist/bundle', 'logindata.json'),
    );
  });

  it('resolves state.json the same way, so the two never diverge', () => {
    const compiled = metaUrlFor('/srv/carelink-bridge/dist/main.js');
    const bundled = metaUrlFor('/tmp/bundletest/carelink-bridge.mjs');
    expect(siblingDataFile(compiled, 'state.json')).toBe(
      path.join('/srv/carelink-bridge', 'state.json'),
    );
    expect(siblingDataFile(bundled, 'state.json')).toBe(
      path.join('/tmp/bundletest', 'state.json'),
    );
  });

  it('keeps the token next to the state file in BOTH layouts', () => {
    // main.ts derives STATE_FILE from dirname(LOGINDATA_FILE), so this is the
    // invariant that makes that derivation correct.
    for (const url of [
      metaUrlFor('/srv/carelink-bridge/dist/main.js'),
      metaUrlFor('/tmp/bundletest/carelink-bridge.mjs'),
    ]) {
      const token = siblingDataFile(url, 'logindata.json');
      const state = siblingDataFile(url, 'state.json');
      expect(path.dirname(token)).toBe(path.dirname(state));
    }
  });
});
