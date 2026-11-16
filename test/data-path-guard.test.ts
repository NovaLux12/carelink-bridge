import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', 'src');

/**
 * A structural guard, not a behaviour test.
 *
 * `logindata.json` / `state.json` must be resolved through `siblingDataFile()`
 * and nowhere else. Four separate places once hardcoded how many directories up
 * the package root was, and three of those numbers were wrong for the
 * single-file bundle — the client's `'..', '..'` put the token at
 * `/logindata.json` (the filesystem root) while login looked beside the bundle,
 * so a bundled deployment could authenticate and then never read its own token.
 *
 * A unit test on `siblingDataFile` cannot catch that recurrence pattern: the
 * bug appears as a NEW call site that does not use the helper at all. So scan
 * the source instead. This is the cheapest possible way to keep the rule true.
 */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Strip comments before scanning.
 *
 * Every offending call site that was fixed now carries a comment quoting the
 * OLD expression to explain why the helper exists, so a naive text scan finds
 * the explanation and calls it a regression. Removing comments first is what
 * makes this guard test CODE rather than documentation.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('data-file path resolution is centralised', () => {
  const files = walk(SRC);

  it('found source files to scan (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no module computes a logindata.json path by hand', () => {
    const offenders = files
      .filter(f => path.basename(f) !== 'data-paths.ts')
      .filter(f => {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        // A join/assign that mentions logindata.json with a '..' segment is the
        // shape that was wrong. Importing the constant is fine and is what every
        // module does instead.
        return /path\.(join|resolve)\([^)]*logindata\.json/.test(src);
      })
      .map(f => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it('no module hardcodes the token path with parent segments', () => {
    const offenders = files
      .filter(f => path.basename(f) !== 'data-paths.ts')
      .filter(f => {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        return /'\.\.'\s*,\s*'\.\.'[^)]*logindata\.json/.test(src)
          || /'\.\.'\s*,\s*'logindata\.json'/.test(src);
      })
      .map(f => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it('every consumer imports the shared helper', () => {
    // Not "must contain the string" — must actually import it, so a stale copy
    // of the logic cannot sit alongside an unused import.
    const consumers = ['login.ts', 'doctor.ts', 'carelink/client.ts'];
    for (const rel of consumers) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect(src, `${rel} must import siblingDataFile`).toMatch(
        /import\s*\{[^}]*siblingDataFile[^}]*\}\s*from\s*'\.\.?\/(\.\.\/)?data-paths\.js'/,
      );
    }
  });
});
