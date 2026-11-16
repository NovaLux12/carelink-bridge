import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Set to `true` by the bundler (`npm run bundle` passes
 * `--define:__CARELINK_BUNDLED__=true`). Undeclared at runtime otherwise, which
 * is why every reference is guarded with `typeof`.
 */
declare const __CARELINK_BUNDLED__: boolean | undefined;

/** True when this code is inside the single-file bundle rather than `dist/`. */
export function isBundledBuild(): boolean {
  return typeof __CARELINK_BUNDLED__ !== 'undefined' && __CARELINK_BUNDLED__ === true;
}

/**
 * Walk up from `from` and return the first directory holding a `package.json`.
 * Bounded so a pathological path cannot scan the filesystem.
 */
function findPackageRoot(from: string, maxLevels = 6): string | undefined {
  let dir = from;
  for (let i = 0; i < maxLevels; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface DataPathOptions {
  /** Override the bundle detection (tests). */
  bundled?: boolean;
  /** Override root discovery (tests). Return `undefined` to simulate none. */
  findRoot?: (from: string) => string | undefined;
}

/**
 * Resolve a neighbouring data file (`logindata.json`, `state.json`) for
 * whichever layout the code is running in.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The token belongs at the package root, because that is what the docs,
 * `deploy/install.sh` and the systemd unit all expect. Four separate places
 * hardcoded how far up that was:
 *
 *   `dist/main.js`             -> `'..'`           correct
 *   `dist/login.js`            -> `'..'`           correct
 *   `dist/doctor.js`           -> `'..'`           correct
 *   `dist/carelink/client.js`  -> `'..', '..'`     correct
 *
 * and all four became wrong in the single-file bundle, which has no `dist/`
 * at all. Measured before this helper:
 *
 *   bundle at `/tmp/bundletest/carelink-bridge.mjs` + `'..'`     -> `/tmp/logindata.json`
 *   and the client's `'..', '..'`                                -> `/logindata.json`  (filesystem root)
 *
 * Two components of one program therefore read two different token files —
 * and under the hardened systemd unit the wrong one is not writable either, so
 * the symptom is a bare `EACCES` after the browser login has already
 * succeeded, with nothing naming the path.
 *
 * THE RULE
 * --------
 * - **Bundled:** the data file lives beside the `.mjs`. A bundle is meant to be
 *   dropped into a directory and run; nothing above it is meaningful.
 * - **Not bundled:** find the package root by walking up to the nearest
 *   `package.json`. That is correct for every source depth at once instead of
 *   encoding one depth per call site.
 *
 * Detection is a compile-time constant rather than a filesystem guess: a path
 * test like `basename === 'dist'` cannot see a nested source dir, and probing
 * for `package.json` at runtime gives the wrong answer for a bundle dropped
 * inside an unrelated project.
 */
export function siblingDataFile(
  metaUrl: string,
  filename: string,
  options: DataPathOptions = {},
): string {
  const from = path.dirname(fileURLToPath(metaUrl));

  const bundled = options.bundled ?? isBundledBuild();
  if (bundled) return path.join(from, filename);

  const findRoot = options.findRoot ?? ((d: string) => findPackageRoot(d));
  const root = findRoot(from);
  return path.join(root ?? from, filename);
}
