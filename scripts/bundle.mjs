#!/usr/bin/env node
/**
 * Build a single-file bundle of the bridge (issue #143, ADR 0009).
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * This produces ONE JavaScript file containing the whole program, puppeteer
 * included. It is a *bundle*, not a static binary: `node:` builtins are still
 * resolved from the host, so the artefact needs Node >= 22.12 to run. A truly
 * self-contained executable would need a Node SEA or a tool that embeds the
 * runtime, which is a separate decision and is NOT made here.
 *
 * Chromium is not included and cannot be. `puppeteer-core` never downloads a
 * browser — that is precisely what distinguishes it from `puppeteer` — so a
 * host with no Chrome still uses Strategy 3's terminal-paste login. Bundling
 * changes how the program is shipped, not whether a browser exists.
 *
 * WHY THE BANNER IS NOT OPTIONAL
 * ------------------------------
 * Two separate traps, both measured (ADR 0009):
 *
 *   1. ESM output dies with `Dynamic require of "fs" is not supported` unless a
 *      `createRequire` shim is injected. Any CommonJS-syntax dependency in the
 *      graph hits this, so it is an ESM bundling fact rather than a puppeteer
 *      one.
 *   2. The shim's identifier MUST be namespaced. `puppeteer-core` inlines its
 *      own `createRequire`, and a plain `import { createRequire }` banner
 *      collides with it: `Identifier 'createRequire' has already been
 *      declared`. That failure only appears in the fully-inlined build, so a
 *      spike that stops at `--external:puppeteer-core` reaches the opposite
 *      conclusion.
 *
 * The build then RUNS the artefact's `--version`-ish path to prove it starts,
 * because "it bundled" and "it works" are different claims and this repo has
 * already shipped a green thing that did nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-bundle');
const OUT_FILE = path.join(OUT_DIR, 'carelink-bridge.mjs');

const CREATE_REQUIRE_BANNER =
  "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [path.join(ROOT, 'src', 'main.ts')],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Inlined deliberately: the whole point of #143 was establishing that
    // puppeteer survives this. Marking it external would make the artefact need
    // node_modules and would answer the wrong question.
    banner: { js: CREATE_REQUIRE_BANNER },
    // ESM output with a bundled CJS dependency cannot use `import.meta.url`
    // replacements that esbuild would otherwise leave to the runtime; the
    // banner handles it. Keep the source map so a stack trace in a user's issue
    // still points at src/.
    sourcemap: 'linked',
    logLevel: 'warning',
  });

  const st = fs.statSync(OUT_FILE);
  const sizeMb = (st.size / 1_048_576).toFixed(1);
  console.log(`bundled  ${path.relative(ROOT, OUT_FILE)}  (${sizeMb} MB)`);

  // A bundle that cannot start is not a bundle. Run it with no configuration:
  // the expected outcome is the bridge's own "Missing CARELINK_USERNAME" error,
  // which proves the module graph loaded. Any SyntaxError / ERR_MODULE_NOT_FOUND
  // / "Dynamic require" would mean the build is broken, so assert on those.
  const probe = spawnSync(process.execPath, [OUT_FILE], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CARELINK_USERNAME: '', CARELINK_PASSWORD: '', API_SECRET: '', NS: '' },
  });
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;

  const fatal = [
    ['Dynamic require of', 'the createRequire banner is missing or the wrong shape'],
    ["Identifier 'createRequire' has already been declared", 'the banner identifier collided with a bundled dependency'],
    ['ERR_MODULE_NOT_FOUND', 'a dependency was left external and cannot resolve'],
    ['SyntaxError', 'the bundle did not parse'],
  ].filter(([needle]) => output.includes(needle));

  if (fatal.length > 0) {
    console.error('\nthe bundle built but does not load:');
    for (const [needle, why] of fatal) console.error(`  ${needle} -> ${why}`);
    console.error('\n--- output ---\n' + output.split('\n').slice(0, 25).join('\n'));
    process.exit(1);
  }

  console.log('smoke    the bundle loads (module graph resolved)');
  console.log(`\nrun it:  node ${path.relative(ROOT, OUT_FILE)}`);
  console.log('note:    needs Node >= 22.12; Chromium is NOT included (see docs/adr/0009).');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
