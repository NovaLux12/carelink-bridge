#!/usr/bin/env node
/**
 * Assert that `npm run build` produced the entrypoints everything else runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tsc` exiting 0 is not the same claim as "dist/ contains the daemon". Measured
 * 2026-11-16: deleting `dist/main.js`, `dist/doctor.js` and `dist/login.js`
 * after a successful build left `npm run typecheck`, `npm test` and
 * `npm run bundle` ALL GREEN — because the tests import `src/`, and the bundle
 * is built from `src/` by esbuild, never from `dist/`. Nothing in CI read the
 * build output at all.
 *
 * That is the same class of failure as the Docker image that shipped without a
 * working `doctor`: the pipeline verified a command exited 0, not that the
 * artefact operators execute exists.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   1. The compiled entrypoints exist and are non-empty.
 *   2. Every `dist/*.js` path named by a consumer of the build — package.json
 *      scripts, the systemd unit, the Dockerfile CMD — resolves. A rename that
 *      updates one consumer and not the others therefore fails here instead of
 *      failing on a user's Pi at 3am.
 *   3. The daemon actually starts inside `dist/`: with no configuration it must
 *      exit 1 with its own "Missing CARELINK_USERNAME" message. A
 *      ERR_MODULE_NOT_FOUND (emitted .js with a .ts-only import rewrite) or a
 *      SyntaxError would also exit non-zero, so the message is the assertion,
 *      not the code.
 *
 * WHAT WOULD MAKE THIS RED
 * ------------------------
 * A tsconfig `include`/`exclude` change that drops an entrypoint, an entrypoint
 * renamed in src/ but not in package.json / the unit / the Dockerfile, a build
 * that emits an empty file, a runtime import that only resolves through tsx.
 *
 * Deliberately network-free and ~1s so it can sit in the matrix.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Entrypoints the project promises. Missing one is the whole point. */
const REQUIRED = ['dist/main.js', 'dist/doctor.js', 'dist/login.js', 'dist/index.js'];

/** Files that name a dist entrypoint, and therefore must agree with dist/. */
const CONSUMERS = [
  'package.json',
  'deploy/systemd/carelink-bridge.service',
  'Dockerfile',
];

const problems = [];

if (!fs.existsSync(DIST)) {
  console.error('verify-dist: no dist/ directory — run `npm run build` first.');
  process.exit(1);
}

for (const rel of REQUIRED) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`${rel} does not exist (build did not emit it)`);
    continue;
  }
  const size = fs.statSync(abs).size;
  if (size === 0) {
    problems.push(`${rel} exists but is empty`);
    continue;
  }
  console.log(`ok    ${rel}  (${size} bytes)`);
}

// Every `dist/<path>.js` mentioned anywhere a real deployment reads it.
const named = new Map(); // dist path -> [consumers]
for (const consumer of CONSUMERS) {
  const abs = path.join(ROOT, consumer);
  if (!fs.existsSync(abs)) {
    problems.push(`consumer ${consumer} is missing — cannot cross-check entrypoints`);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  for (const m of text.matchAll(/dist\/[A-Za-z0-9_.\/-]*\.js/g)) {
    const rel = m[0];
    if (!named.has(rel)) named.set(rel, []);
    const list = named.get(rel);
    if (!list.includes(consumer)) list.push(consumer);
  }
}
if (named.size === 0) {
  problems.push(
    'no dist/*.js paths found in package.json, the systemd unit or the Dockerfile — ' +
      'the cross-check scanned nothing, which is a scanner failure, not a pass',
  );
}
for (const [rel, consumers] of [...named].sort()) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`${rel} is named by ${consumers.join(', ')} but does not exist in dist/`);
    continue;
  }
  console.log(`ok    ${rel}  (named by ${consumers.join(', ')})`);
}

if (problems.length > 0) {
  console.error('\nverify-dist FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nThe build must emit every entrypoint the Dockerfile, the systemd unit and\n' +
      'package.json execute. `tsc` exiting 0 does not prove it did.',
  );
  process.exit(1);
}

// The daemon must load from dist/. Asserted on the message, because a broken
// module graph also exits non-zero, and "exit 1" is what we EXPECT here.
//
// Run from an empty scratch directory rather than the repo root: `main.ts`
// calls `dotenv.config()`, which reads `./.env` from the CWD. A developer with
// a real `.env` checked out would otherwise have this probe pass for the wrong
// reason (or fail because their config is complete).
const probeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-dist-'));
const probeEnv = {
  ...process.env,
  CARELINK_USERNAME: '',
  CARELINK_PASSWORD: '',
  API_SECRET: '',
  NS: '',
  MMCONNECT_SERVER: '',
  WEBSITE_HOSTNAME: '',
};
let daemonOut = '';
try {
  execFileSync(process.execPath, [path.join(DIST, 'main.js')], {
    cwd: probeCwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: probeEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  problems.push('dist/main.js exited 0 with no configuration — expected it to refuse to start');
} catch (err) {
  daemonOut = `${err.stdout ?? ''}${err.stderr ?? ''}`;
} finally {
  fs.rmSync(probeCwd, { recursive: true, force: true });
}

if (!daemonOut.includes('Missing CARELINK_USERNAME')) {
  problems.push(
    'dist/main.js did not fail with its own "Missing CARELINK_USERNAME" — the compiled ' +
      'module graph does not load:\n' +
      daemonOut.split('\n').slice(0, 15).join('\n'),
  );
} else if (problems.length === 0) {
  console.log('ok    dist/main.js loads (own config error, not a module error)');
}

if (problems.length > 0) {
  console.error('\nverify-dist FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`\nverify-dist: ${REQUIRED.length} entrypoints present and ${named.size} consumer paths resolve.`);
