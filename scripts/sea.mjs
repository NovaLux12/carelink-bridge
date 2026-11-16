#!/usr/bin/env node
/**
 * Build a true single-file executable with Node's SEA feature (issue #143).
 *
 * WHAT THIS PRODUCES
 * ------------------
 * `dist-sea/carelink-bridge` — one file, ~143 MB, containing the Node runtime
 * *and* the whole program. `ldd` shows only libc/libstdc++/libm: no `node` on
 * PATH, no `node_modules`, no `dist/`. That is the difference from
 * `npm run bundle`, which produces a 3 MB .mjs that still needs Node >= 22.12.
 *
 * THE VERSION FLOOR IS THE WHOLE STORY — READ BEFORE CHANGING THE GUARD
 * ---------------------------------------------------------------------
 * SEA on Node 22 and 24 embeds its main script as **CommonJS only**. Both
 * call `embedderRunCjs`, and `mainFormat: "module"` is accepted by
 * `--experimental-sea-config` and then silently ignored — measured on
 * v22.22.0 and v24.22.2, which both die with
 * `SyntaxError: Cannot use import statement outside a module` on line 1 of
 * this repo's ESM bundle. A CJS build is not an escape hatch either: esbuild
 * refuses `--format=cjs` because `src/main.ts` ends in top-level
 * `await ensureLogin()` (and that survives a dynamic-import wrapper, because
 * esbuild inlines the graph). So on <= 24 the static-binary path is blocked,
 * not merely awkward.
 *
 * `--build-sea` (v25.5.0+) is the flag that honours `"mainFormat": "module"`,
 * and it also removes the separate postject injection step. That is why this
 * script requires >= 25.5 and refuses to run below it rather than producing an
 * artefact that fails at line 1.
 *
 * The binary is then RUN, from a directory with no node_modules, and asserted
 * to reach the application's own logic. `--build-sea` succeeding and the app
 * working are different claims (ADR 0009's lesson).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist-bundle', 'carelink-bridge.mjs');
const OUT_DIR = path.join(ROOT, 'dist-sea');
const OUT_FILE = path.join(OUT_DIR, 'carelink-bridge');

const MIN_MAJOR = 25;
const MIN_MINOR = 5;

function fail(msg, detail) {
  console.error(`\nsea: ${msg}`);
  if (detail) console.error(detail.split('\n').slice(0, 25).join('\n'));
  process.exit(1);
}

/** Refuse below v25.5 rather than emit a binary that dies on line 1. */
function assertNodeSupportsEsmSea() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
  if (!ok) {
    fail(
      `Node ${process.version} cannot build an ESM single executable.`,
      [
        '',
        `SEA on Node <= 24 embeds its main script as CommonJS only: the runtime`,
        `calls embedderRunCjs, and "mainFormat": "module" is silently ignored.`,
        `Feeding this repo's ESM bundle in produces:`,
        '',
        `  SyntaxError: Cannot use import statement outside a module`,
        `      at embedderRunCjs (node:internal/main/embedding:...)`,
        '',
        `A CommonJS bundle is not an alternative: src/main.ts uses top-level`,
        `await, which esbuild rejects for --format=cjs. See docs/adr/0010.`,
        '',
        `Use Node >= ${MIN_MAJOR}.${MIN_MINOR} (--build-sea). Current: ${process.version}`,
      ].join('\n'),
    );
  }
}

async function main() {
  assertNodeSupportsEsmSea();

  // The ESM bundle is the input. Rebuild it so a stale dist-bundle/ cannot be
  // silently sealed into the binary — `npm run sea` must be self-contained.
  const bundleBuild = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300_000,
  });
  if (bundleBuild.status !== 0) fail('the underlying bundle build failed');
  if (!fs.existsSync(BUNDLE)) fail(`expected the bundle at ${path.relative(ROOT, BUNDLE)}`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // `--build-sea` resolves relative paths against cwd, but keeping both inputs
  // absolute means the config is valid wherever this is invoked from.
  const configPath = path.join(OUT_DIR, 'sea-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: BUNDLE,
        // The one field that makes this work at all: without it Node treats the
        // .mjs as CJS. Only honoured by --build-sea.
        mainFormat: 'module',
        executable: process.execPath,
        output: OUT_FILE,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ) + '\n',
  );

  const build = spawnSync(process.execPath, [`--build-sea=${configPath}`], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 600_000,
  });
  const buildOut = `${build.stdout ?? ''}${build.stderr ?? ''}`;
  if (build.status !== 0 || !fs.existsSync(OUT_FILE)) {
    fail('--build-sea did not produce a binary', buildOut);
  }
  fs.chmodSync(OUT_FILE, 0o755);

  const sizeMb = (fs.statSync(OUT_FILE).size / 1_048_576).toFixed(1);
  console.log(`sea      dist-sea/carelink-bridge  (${sizeMb} MB)`);

  // Run it where nothing can leak in: a temp dir with no package.json and no
  // node_modules. A binary that only works from the repo root has not been
  // proven single-file, and the bundle's own smoke test would not catch it.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carelink-sea-'));
  const sandboxBin = path.join(sandbox, 'carelink-bridge');
  fs.copyFileSync(OUT_FILE, sandboxBin);
  fs.chmodSync(sandboxBin, 0o755);

  // `env -i`-equivalent: strip PATH down to nothing meaningful so a stray host
  // `node` cannot be picked up. If the runtime were still external this fails.
  const bareEnv = { HOME: process.env.HOME ?? '/tmp', PATH: '/nonexistent' };

  const run = (args, extraEnv = {}) =>
    spawnSync(sandboxBin, args, {
      cwd: sandbox,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...bareEnv, ...extraEnv },
      input: '',
    });

  const help = run(['--help']);
  const helpOut = `${help.stdout ?? ''}${help.stderr ?? ''}`;
  if (help.error || !helpOut.includes('carelink-bridge doctor')) {
    fail('the binary did not run with no node_modules present', helpOut);
  }
  console.log('smoke    binary runs standalone (no node on PATH, no node_modules)');

  // doctor is the honest end-to-end probe: it loads config, calls the CareLink
  // discovery endpoint and reports its own rows. Reaching its output means the
  // module graph, dotenv, fetch and the subcommand dispatch all survived.
  const doctor = run(['doctor']);
  const doctorOut = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`;
  const missing = [
    ['carelink-bridge doctor', 'the doctor subcommand did not run'],
    ['Config (.env)', 'doctor ran but produced no config row'],
  ].filter(([needle]) => !doctorOut.includes(needle));
  if (missing.length > 0) {
    fail('the binary has no working `doctor` subcommand', doctorOut);
  }
  console.log('smoke    `doctor` subcommand present and reporting');

  // puppeteer is the dependency ADR 0009 was about. The daemon with no config
  // reaches login, which fetches discovery + Auth0 and calls puppeteer.launch().
  // Asserting on `component":"login` proves the browser path was entered rather
  // than the process dying earlier.
  const daemon = spawnSync(sandboxBin, [], {
    cwd: sandbox,
    encoding: 'utf-8',
    timeout: 90_000,
    env: { ...bareEnv, CARELINK_USERNAME: '', CARELINK_PASSWORD: '', API_SECRET: '', NS: '' },
    input: '',
  });
  const daemonOut = `${daemon.stdout ?? ''}${daemon.stderr ?? ''}`;
  const fatal = [
    ['ERR_MODULE_NOT_FOUND', 'a dependency was not inlined'],
    ['Dynamic require of', 'a CommonJS dependency was not carried'],
    ['Cannot use import statement outside a module', 'the SEA main was run as CJS'],
    ['Cannot find module', 'a dependency was not inlined'],
  ].filter(([needle]) => daemonOut.includes(needle));
  if (fatal.length > 0) {
    console.error('\nthe binary built but does not run:');
    for (const [needle, why] of fatal) console.error(`  ${needle} -> ${why}`);
    console.error('\n--- output ---\n' + daemonOut.split('\n').slice(0, 25).join('\n'));
    process.exit(1);
  }
  if (!daemonOut.includes('component":"login')) {
    fail('the daemon never reached the login/puppeteer path', daemonOut);
  }
  console.log('smoke    daemon reaches the login path (puppeteer survived)');

  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\nrun it:  ./${path.relative(ROOT, OUT_FILE)} [doctor|login]`);
  console.log('note:    ~143 MB because the Node runtime is inside it. Chromium is');
  console.log('         still NOT included (ADR 0009) — close enough to a static');
  console.log('         binary to ship, still needs a browser for Strategy 2.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
