#!/usr/bin/env node
/**
 * Guard the version/dependency metadata pair that `npm ci` does not guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old inline guard in ci.yml compared exactly two values:
 * `require('./package.json').version` and `require('./package-lock.json').version`.
 * That is the lockfile's *top-level* `version`. npm writes the package's own
 * version in TWO places, and the second one — `packages[""].version` — is the
 * one `npm ci`, `npm ls` and npm's own resolver read.
 *
 * Measured 2026-11-16: setting `packages[""].version` to 0.4.1 while leaving
 * the top-level field at 0.4.2 left the old guard GREEN and `npm ci` exit 0 —
 * i.e. the exact drift the guard was written for (v0.1.1, v0.1.2, v0.3.0) could
 * be reintroduced through the field the guard did not read.
 *
 * Dependency RANGES are the second gap. CONTRIBUTING says a change to
 * dependencies needs `npm install --package-lock-only`. `npm ci` enforces this
 * only one way: it errors when the lock cannot satisfy package.json. Widening a
 * range (`qs: ^6.17.1` -> `qs: ^6.0.0`) is satisfied by the locked 6.17.1, so
 * `npm ci` exits 0 while package.json now advertises a floor the lockfile does
 * not track — measured 2026-11-16. Comparing the range maps directly is the
 * only check that sees it.
 *
 * WHAT WOULD MAKE THIS RED
 * ------------------------
 * Any of: package.json version != lock top-level version; package.json version
 * != lock `packages[""]` version; name mismatch; a dependency/devDependency
 * range present on one side and not the other; `--tag` given and not equal to
 * the package version (release path).
 *
 * Usage:
 *   node scripts/check-version-sync.mjs
 *   node scripts/check-version-sync.mjs --tag v0.4.2
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

const tagFlagIdx = process.argv.indexOf('--tag');
const expectedTag = tagFlagIdx !== -1 ? process.argv[tagFlagIdx + 1] : undefined;

const rootEntry = lock.packages?.[''] ?? {};
const problems = [];

console.log(`package.json        ${pkg.name}@${pkg.version}`);
console.log(`package-lock.json   version=${lock.version} packages[""].version=${rootEntry.version}`);

const expectOne = (label, actual, expected) => {
  if (actual !== expected) problems.push(`${label}: ${actual} != ${expected}`);
};

expectOne('package-lock.json version', lock.version, pkg.version);
expectOne('package-lock.json packages[""].version', rootEntry.version, pkg.version);
expectOne('package-lock.json packages[""].name', rootEntry.name, pkg.name);

/** Compare a dependency map as a set of (name, range) pairs. */
const rangeDiff = (label, fromPkg, fromLock) => {
  const left = fromPkg ?? {};
  const right = fromLock ?? {};
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[name] !== right[name]) {
      problems.push(
        `${label} "${name}": package.json says ${left[name] ?? '(absent)'} but ` +
          `package-lock.json says ${right[name] ?? '(absent)'} — run: npm install --package-lock-only`,
      );
    }
  }
};

rangeDiff('dependencies', pkg.dependencies, rootEntry.dependencies);
rangeDiff('devDependencies', pkg.devDependencies, rootEntry.devDependencies);
expectOne('engines.node', rootEntry.engines?.node, pkg.engines?.node);

if (expectedTag !== undefined) {
  const tag = expectedTag.replace(/^v/, '');
  console.log(`tag                 ${expectedTag} (=${tag})`);
  expectOne('tag vs package.json version', pkg.version, tag);
}

if (problems.length > 0) {
  console.error('\nversion-sync FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `\nversion-sync: ${pkg.name}@${pkg.version} consistent across package.json and ` +
    `package-lock.json (version, packages[""], ranges).`,
);
