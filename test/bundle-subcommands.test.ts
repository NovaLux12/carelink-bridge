import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'dist-bundle', 'carelink-bridge.mjs');

/**
 * The bundle's subcommands must each run the CLI exactly ONCE.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every CLI module self-executes behind an `isMainModule` guard comparing
 * `process.argv[1]` with `import.meta.url`. In a bundle those are the same file,
 * so the guard is true for every bundled module at once — and `doctor` and
 * `login` each ran twice: once via the dispatcher in `src/bundle-main.ts`, once
 * via their own guard. The dispatcher was added for exactly this reason but
 * nobody had removed the guards' effect, so the bundle silently did double work.
 *
 * The symptom was tiny and easy to dismiss (a doubled "injected env" banner),
 * but the consequences were not: `doctor` repeated every network probe, and
 * `login` — an interactive prompt — asked the user to paste the OAuth redirect
 * URL a second time. Both are fixed by making the guards bundle-aware via
 * `isBundledBuild()`.
 *
 * A unit test cannot see this: it is a property of the built artefact. So this
 * test runs the real bundle. It SKIPS when the bundle has not been built rather
 * than failing, because `npm test` alone does not require it — `npm run bundle`
 * is its own CI step and does build it, so the check runs there.
 */
describe('bundled subcommands run once', () => {
  const hasBundle = fs.existsSync(BUNDLE);

  /**
   * Is the bundle NEWER than the newest source file?
   *
   * `dist-bundle/` is gitignored, so it survives `git rebase` and branch
   * switches. A stale bundle then fails these tests with "expected 2 to be 1"
   * — a true statement about a build nobody is running, and indistinguishable
   * from the regression they exist to catch. That false failure is worse than
   * no test, so staleness skips with an instruction instead of asserting.
   */
  const isFresh = ((): boolean => {
    if (!hasBundle) return false;
    const bundleAge = fs.statSync(BUNDLE).mtimeMs;
    const newestSource = (function walk(dir: string): number {
      return fs.readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return Math.max(newest, walk(full));
        return entry.name.endsWith('.ts') ? Math.max(newest, fs.statSync(full).mtimeMs) : newest;
      }, 0);
    })(path.join(ROOT, 'src'));
    return bundleAge > newestSource;
  })();

  const skipReason = !hasBundle
    ? 'no dist-bundle/carelink-bridge.mjs — run `npm run bundle` first'
    : 'dist-bundle is older than src/ — run `npm run bundle` to refresh it';

  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      return execFileSync(process.execPath, [BUNDLE, ...args], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 90_000,
        stdio: 'pipe',
        input: '',
        env: { ...process.env, ...env },
      });
    } catch (err) {
      // A non-zero exit is fine (doctor exits 1 with no .env); we only want output.
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  };

  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it('the bundle is present and fresh (else the checks below are skipped)', () => {
    // Always-present assertion so a skip cannot be invisible: the suite still
    // reports whether this environment could run the real checks.
    expect(typeof skipReason).toBe('string');
    if (!isFresh) console.warn(`[bundle-subcommands] skipped: ${skipReason}`);
  });

  it.skipIf(!isFresh)('doctor runs its CLI once, not twice', () => {
    const out = run(['doctor']);
    expect(count(out, 'carelink-bridge doctor')).toBe(1);
    // The dotenv banner is the cheapest observable: one load, not two.
    expect(count(out, 'injected env')).toBe(1);
  });

  it.skipIf(!isFresh)('login runs its CLI once, not twice', () => {
    // `login` exits early when logindata.json exists, which keeps this fast and
    // non-interactive. The double-run showed up as two banners before that.
    const out = run(['login']);
    expect(count(out, 'injected env')).toBeLessThanOrEqual(1);
    expect(count(out, 'Region:')).toBe(1);
  });

  it.skipIf(!isFresh)('--help does not implicitly run any subcommand', () => {
    const out = run(['--help']);
    expect(out).toContain('carelink-bridge doctor');
    // Help is pure output: no dotenv load, no probe, nothing executed.
    expect(count(out, 'injected env')).toBe(0);
    // The usage line appears exactly once. (Do not match on
    // 'carelink-bridge doctor\n' — the usage column is padded with trailing
    // spaces, so that pattern never matches and the assertion silently measures
    // the wrong thing.)
    expect(count(out, 'carelink-bridge doctor ')).toBe(1);
  });
});
