import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siblingDataFile, isBundledBuild } from '../src/data-paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression for the bundle's data-file location.
 *
 * The token belongs at the package root for compiled source, and beside the
 * `.mjs` for the single-file bundle. Four call sites previously hardcoded how
 * far up the root was — `'..'` from `dist/main.js`, `dist/login.js` and
 * `dist/doctor.js`, plus `'..', '..'` from `dist/carelink/client.js`. All four
 * were correct for compiled source and all four were wrong in the bundle.
 *
 * Measured before the fix: a bundle at `/tmp/bundletest/carelink-bridge.mjs`
 * put the token at `/tmp/logindata.json` from login and `/logindata.json` from
 * the client — two components, two different files, one of them at the
 * filesystem root.
 *
 * `findRoot` is injectable so these tests exercise the RULE without depending
 * on what happens to exist on the test machine's filesystem.
 */

function metaUrlFor(absolutePath: string): string {
  return new URL(`file://${absolutePath}`).href;
}

/** Package-root finder that treats `/srv/app` as the only root. */
const fakeRoot = (root: string) => (from: string) =>
  from.startsWith(root) ? root : undefined;

describe('siblingDataFile() — compiled from source', () => {
  const root = '/srv/app';
  const opts = { bundled: false, findRoot: fakeRoot(root) };

  it('resolves every entrypoint at dist/ to the package root', () => {
    for (const file of ['main.js', 'login.js', 'doctor.js']) {
      expect(siblingDataFile(metaUrlFor(`${root}/dist/${file}`), 'logindata.json', opts))
        .toBe(path.join(root, 'logindata.json'));
    }
  });

  it('resolves a NESTED source dir to the same package root', () => {
    // dist/carelink/client.js sits one level deeper; the old code hardcoded an
    // extra '..' here, which is how it drifted from the entrypoints.
    expect(siblingDataFile(metaUrlFor(`${root}/dist/carelink/client.js`), 'logindata.json', opts))
      .toBe(path.join(root, 'logindata.json'));
  });

  it('gives all four real call sites ONE path', () => {
    const paths = [
      `${root}/dist/main.js`,
      `${root}/dist/login.js`,
      `${root}/dist/doctor.js`,
      `${root}/dist/carelink/client.js`,
    ].map(p => siblingDataFile(metaUrlFor(p), 'logindata.json', opts));
    expect(new Set(paths).size).toBe(1);
    expect(paths[0]).toBe(path.join(root, 'logindata.json'));
  });

  it('falls back to the module directory when no package root is found', () => {
    const noRoot = { bundled: false, findRoot: () => undefined };
    expect(siblingDataFile(metaUrlFor('/elsewhere/lib/thing.js'), 'state.json', noRoot))
      .toBe(path.join('/elsewhere/lib', 'state.json'));
  });
});

describe('siblingDataFile() — single-file bundle', () => {
  const opts = {
    bundled: true,
    findRoot: () => { throw new Error('must not probe the filesystem when bundled'); },
  };

  it('keeps the data file beside the .mjs, on every ancestor shape', () => {
    for (const dir of ['/tmp/bundletest', '/opt/carelink', '/home/jack']) {
      expect(siblingDataFile(metaUrlFor(`${dir}/carelink-bridge.mjs`), 'logindata.json', opts))
        .toBe(path.join(dir, 'logindata.json'));
    }
  });

  it('never walks to the filesystem root', () => {
    // The old client code did exactly this: '..', '..' from a bundle in
    // /tmp/bundletest produced '/logindata.json'.
    const resolved = siblingDataFile(
      metaUrlFor('/tmp/bundletest/carelink-bridge.mjs'), 'logindata.json', opts,
    );
    expect(resolved).not.toBe('/logindata.json');
    expect(resolved.startsWith('/tmp/bundletest/')).toBe(true);
  });

  it('keeps the token next to the state file', () => {
    const url = metaUrlFor('/tmp/bundletest/carelink-bridge.mjs');
    expect(path.dirname(siblingDataFile(url, 'logindata.json', opts)))
      .toBe(path.dirname(siblingDataFile(url, 'state.json', opts)));
  });
});

describe('the bundle flag', () => {
  it('is false in the normal build (vitest, tsc)', () => {
    // The define exists only in the esbuild bundle. If this ever returns true
    // here, the define has leaked into the compiled build and every data file
    // would silently move beside each module.
    expect(isBundledBuild()).toBe(false);
  });

  it('resolves this repo’s own source layout to the package root', () => {
    const projectRoot = path.resolve(here, '..');
    const resolved = siblingDataFile(
      metaUrlFor(`${projectRoot}/dist/carelink/client.js`),
      'logindata.json',
    );
    expect(resolved).toBe(path.join(projectRoot, 'logindata.json'));
  });
});
