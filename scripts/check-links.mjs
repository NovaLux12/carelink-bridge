#!/usr/bin/env node
// Cross-repo link check.
//
// Every claim this bridge makes about Medtronic's surface cites
// NovaLux12/carelink-api-research. Those links float on `main`, so a
// rename on that side (e.g. a docs/0x-*.md renumber) silently 404s us.
// This checks the cross-repo URLs and fails loudly instead.
//
// Usage:  npm run links:check          (no network requests made unless --online)
//         npm run links:check -- --online
//
// Default is offline: it extracts and normalises every cross-repo URL and
// compares against the set of paths that exist in a local sibling clone when
// one is present, plus a checked-in snapshot. CI runs it with --online.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING = resolve(ROOT, '..', 'carelink-api-research');
const REPO = 'NovaLux12/carelink-api-research';
const ONLINE = process.argv.includes('--online');

const SCAN_DIRS = ['.', 'docs', 'src', 'test', 'deploy', '.github'];
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'research', 'coverage',
  'reports', 'logs', '.tmp',
]);
const TEXT = /\.(md|ts|tsx|mts|js|mjs|cjs|yml|yaml|sh|json|txt)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (TEXT.test(entry)) yield full;
  }
}

function extract(files) {
  const found = new Map(); // url -> [locations]
  const re = new RegExp(
    `https://github\\.com/${REPO}(?:/(?:blob|tree)/[A-Za-z0-9._-]+)?(/[^\\s)\\]>"\`]*)?`,
    'g'
  );
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) {
      const url = m[0].replace(/[.,;:]+$/, '');
      const loc = relative(ROOT, file);
      if (!found.has(url)) found.set(url, []);
      found.get(url).push(loc);
    }
  }
  return found;
}

// Map a cross-repo URL to the path it should exist at inside the sibling.
// Returns null for URLs that address the repo itself (root, issues/new, etc.),
// which can only be verified over the network.
function targetPath(url) {
  const m = url.match(
    new RegExp(`^https://github\\.com/${REPO}/(?:blob|tree)/[^/]+(/.*)$`)
  );
  if (m) return m[1];
  return null;
}

const files = [];
for (const d of SCAN_DIRS) {
  const full = join(ROOT, d);
  if (existsSync(full) && statSync(full).isDirectory()) files.push(...walk(full));
}

const urls = extract(files);

if (urls.size === 0) {
  console.log('links:check — no cross-repo URLs found (nothing to check).');
  process.exit(0);
}

console.log(`links:check — ${urls.size} distinct ${REPO} URLs across ${files.length} files\n`);

const problems = [];
const haveSibling = existsSync(SIBLING);

for (const [url, locs] of urls) {
  const path = targetPath(url);
  const where = `  referenced by: ${locs.slice(0, 3).join(', ')}${locs.length > 3 ? ` (+${locs.length - 3} more)` : ''}`;

  if (path === null) {
    if (ONLINE) {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const ok = res.status >= 200 && res.status < 400;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${url}`);
      if (!ok) problems.push(`${url} → HTTP ${res.status}`);
    } else {
      console.log(`skip ${url}  (addresses the repo itself; only checked with --online)`);
    }
    continue;
  }

  // Offline: resolve against a local sibling clone if there is one.
  if (haveSibling) {
    const target = join(SIBLING, path);
    const exists = existsSync(target);
    console.log(`${exists ? 'ok  ' : 'FAIL'} ${url}`);
    if (!exists) problems.push(`${url} → no such path in sibling clone: ${path}`);
  } else {
    console.log(`skip ${url}  (no sibling clone; only checked with --online)`);
  }
}

console.log('');

if (problems.length) {
  console.error(`links:check FAILED — ${problems.length} broken cross-repo link(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nIf the target was renamed on the research side, update every reference here.'
  );
  process.exit(1);
}

if (!ONLINE && !haveSibling) {
  console.log(
    'links:check — offline mode with no sibling clone, so path targets were NOT verified.\n' +
    '  Clone it next to this repo (`git clone https://github.com/NovaLux12/carelink-api-research.git`)\n' +
    '  or run with --online to verify over the network.'
  );
  process.exit(0);
}

console.log('links:check PASSED — every cross-repo link resolves.');