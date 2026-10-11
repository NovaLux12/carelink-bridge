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
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING = resolve(ROOT, '..', 'carelink-api-research');
const REPO = 'NovaLux12/carelink-api-research';
const ONLINE = process.argv.includes('--online');

// Walk the whole tree once. Naming subdirectories here alongside '.' would scan
// most of the repo twice and inflate the file count we report.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'coverage',
  'reports', 'logs', '.tmp',
  // A gitignored local mirror of the research repo, not canonical and not on
  // GitHub — 1176 files of it. Its README says not to cite it.
  'research',
]);
const TEXT = /\.(md|ts|tsx|mts|js|mjs|cjs|yml|yaml|sh|json|txt|service)$/;
// Extensionless files that are tracked and worth scanning — `.gitignore` in
// particular carries a live cross-repo URL in a comment.
const BARE_FILES = new Set([
  '.gitignore', '.dockerignore', 'Dockerfile', 'LICENSE',
  'CODEOWNERS', '.env.example',
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (TEXT.test(entry) || BARE_FILES.has(entry)) yield full;
  }
}

function extract(files) {
  const found = new Map(); // url -> [locations]
  const re = new RegExp(
    // (?![\w.-]) stops the match running past the repo name, so a link to
    // `carelink-api-research-archive` is not silently truncated to `…research`
    // (which resolves, hiding a 404).
    `https://github\\.com/${REPO}(?![\\w.-])(?:/(?:blob|tree)/[A-Za-z0-9._-]+)?(/[^\\s)\\]>"\`]*)?`,
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
// Strips any #fragment or ?query first — those are not part of the path, and
// leaving them in makes `docs/x.md#section` fail a check that is really about
// a rename. Returns null for URLs that address the repo or its issue tracker
// rather than a file, which cannot be path-checked offline.
function targetPath(url) {
  const bare = url.split('#')[0].split('?')[0];
  const m = bare.match(
    new RegExp(`^https://github\\.com/${REPO}(?![\\w.-])/(?:blob|tree)/[^/]+(/.*)$`)
  );
  if (m) return m[1];
  return null;
}

const files = [...walk(ROOT)];

const urls = extract(files);

if (urls.size === 0) {
  console.log('links:check — no cross-repo URLs found (nothing to check).');
  process.exit(0);
}

console.log(`links:check — ${urls.size} distinct ${REPO} URLs across ${files.length} files\n`);

const problems = [];
const unverified = [];
let networkErrors = 0;
const haveSibling = existsSync(SIBLING);

// A `?template=` URL points at GitHub's issue-form router, which returns 200
// whether or not the named template exists (it falls back to a blank form or a
// login redirect). Folding those into a normal HTTP check would report every
// contributor-funnel link as good regardless of whether the template is real.
// Instead, extract the template name and require it to exist on the sibling, so
// a renamed/deleted issue form is actually caught offline.
function templateTarget(url) {
  const m = url.match(new RegExp(`^https://github\\.com/${REPO}/issues/new\\?template=([^&]+)`));
  return m ? `.github/ISSUE_TEMPLATE/${m[1]}` : null;
}

for (const [url, locs] of urls) {
  const path = targetPath(url);
  const where = `  referenced by: ${locs.slice(0, 3).join(', ')}${locs.length > 3 ? ` (+${locs.length - 3} more)` : ''}`;

  // --- Online mode: verify EVERY url over the network, path or not. This is
  // the CI configuration, and it must not silently skip blob/tree links just
  // because there is no sibling clone on the runner.
  if (ONLINE) {
    const tmpl = templateTarget(url);
    let status = 0;
    let detail = '';
    try {
      // Bound every request. A hung connection would otherwise occupy the CI
      // job for GitHub's default 6-hour limit, and a DNS blip is
      // indistinguishable from a broken link unless we separate the two.
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
    } catch (e) {
      detail = ` (network error, not a verdict on the link: ${e.message})`;
      networkErrors++;
    }
    // A 200 here does not prove the template exists — GitHub answers 200 for a
    // bogus `?template=` too — so say so rather than letting it read as verified.
    if (tmpl && status >= 200 && status < 400) {
      unverified.push(url);
      console.log(`SKIP ${url}  (HTTP ${status} does not prove the issue template exists — pass offline to check it)`);
      continue;
    }
    const ok = status >= 200 && status < 400;
    console.log(`${ok ? 'ok  ' : status === 0 ? 'NET ' : 'FAIL'} ${url}`);
    if (!ok) problems.push(`${url} → HTTP ${status}${detail}${where}`);
    continue;
  }

  // --- Offline mode: resolve against a sibling clone, and additionally
  // require the target to be git-TRACKED. A file that exists in a working tree
  // but is untracked or gitignored 404s on GitHub — that is precisely the
  // breakage this gate exists to catch.
  if (!haveSibling) {
    unverified.push(url);
    console.log(`SKIP ${url}  (no sibling clone; pass --online to verify over the network)`);
    continue;
  }
  // An `?template=` URL does have a file to check offline — the issue form
  // itself. GitHub's HTTP status can't prove it exists, but the sibling clone can.
  const tmpl = templateTarget(url);
  if (tmpl) {
    const tplAbs = join(SIBLING, tmpl);
    const tplTracked = spawnSync(
      'git',
      ['-C', SIBLING, 'ls-files', '--error-unmatch', tmpl],
      { encoding: 'utf8' }
    );
    if (!existsSync(tplAbs)) {
      console.log(`FAIL ${url}`);
      problems.push(`${url} → issue template not found in sibling clone: ${tmpl}`);
      continue;
    }
    if (tplTracked.status !== 0) {
      console.log(`FAIL ${url}`);
      problems.push(`${url} → ${tmpl} exists locally but is not git-tracked`);
      continue;
    }
    console.log(`ok   ${url}  (template checked: ${tmpl})`);
    continue;
  }

  // A repo-root URL has no file path to stat offline. Check the clone is
  // actually the repo we think it is, rather than passing it silently.
  if (path === null) {
    const remote = spawnSync('git', ['-C', SIBLING, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    });
    const rightRepo = remote.status === 0 && remote.stdout.trim().includes(REPO);
    console.log(`${rightRepo ? 'ok  ' : 'FAIL'} ${url}  (repo root, checked via origin remote)`);
    if (!rightRepo) problems.push(`${url} → sibling clone's origin is not ${REPO} (${remote.stdout.trim() || 'unknown'})`);
    continue;
  }
  const target = join(SIBLING, path);
  if (!existsSync(target)) {
    console.log(`FAIL ${url}`);
    problems.push(`${url} → no such path in sibling clone: ${path}`);
    continue;
  }
  const tracked = spawnSync(
    'git',
    ['-C', SIBLING, 'ls-files', '--error-unmatch', path.replace(/^\//, '')],
    { encoding: 'utf8' }
  );
  if (tracked.status !== 0) {
    console.log(`FAIL ${url}`);
    problems.push(`${url} → ${path} exists locally but is not git-tracked (would 404 on GitHub)`);
    continue;
  }
  console.log(`ok   ${url}`);
}

console.log('');

if (problems.length) {
  console.error(`links:check FAILED — ${problems.length} broken cross-repo link(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  if (networkErrors) {
    console.error(
      `\nNote: ${networkErrors} of these are network errors, not 404s. A transient DNS/TLS\n` +
      'failure looks identical to a broken link — re-run before acting on them.'
    );
  }
  console.error(
    '\nIf the target was renamed on the research side, update every reference here.'
  );
  process.exit(1);
}

if (unverified.length) {
  console.log(
    `links:check PASSED — but ${unverified.length} link(s) were NOT verified (no sibling clone).\n` +
    '  Those links are unproven, not good. Run with --online to verify them over the network.'
  );
  process.exit(0);
}

console.log('links:check PASSED — every cross-repo link verified.');