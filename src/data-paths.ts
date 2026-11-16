import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a sibling data file (`logindata.json`, `state.json`) for whichever
 * layout the code is running in.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The bridge runs in two shapes and they need different arithmetic:
 *
 *   1. **Compiled from source** — `dist/main.js`, `dist/login.js`. The token
 *      belongs at `<repo>/logindata.json`, i.e. one level UP from `dist/`,
 *      because that is what every document, `deploy/install.sh` and the
 *      systemd unit expect.
 *   2. **The single-file bundle** (`npm run bundle`) — one `.mjs` with no
 *      `dist/` around it. One level up from *there* is a random parent
 *      directory. Measured before this helper existed: a bundle at
 *      `/tmp/bundletest/carelink-bridge.mjs` resolved the token to
 *      `/tmp/logindata.json`, which is both surprising and — under a hardened
 *      systemd unit — unwritable, so login would fail with a bare `EACCES`.
 *
 * The `'..'` is only correct in layout (1), and the property that makes it
 * correct is exactly the property available at runtime: the containing
 * directory is named `dist`. So test that, and otherwise stay put.
 *
 * Kept in its own module so `login.ts`, `doctor.ts` and `main.ts` cannot drift
 * apart on where the token lives — they did drift, and doctor ended up
 * reporting a token state for a different path than login wrote.
 */
export function siblingDataFile(
  metaUrl: string,
  filename: string,
  distDirectoryName = 'dist',
): string {
  const dir = path.dirname(fileURLToPath(metaUrl));
  return path.basename(dir) === distDirectoryName
    ? path.join(dir, '..', filename)
    : path.join(dir, filename);
}
