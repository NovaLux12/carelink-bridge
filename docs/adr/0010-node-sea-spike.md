# 0010 — Node SEA: a real single executable, but only on Node ≥ 25.5

## Status

**Spike result, 2026-11-16.** Closes the question ADR 0009 left open
([issue #143](https://github.com/NovaLux12/carelink-bridge/issues/143),
`v0.5.0 — single static binary`). ADR 0009 proved esbuild produces a runnable
single *file*; it explicitly said that file still resolves `node:` builtins from
the host and that "genuinely static output needs a SEA … that is a separate
question and it is still open". This is that question, answered.

**Answer: yes, SEA works — and it runs the application, not just the blob.** The
blocker is not the project, it is the Node version: the ESM path only works on
**Node ≥ 25.5**, where `--build-sea` honours `"mainFormat": "module"`. On the
Node 22 and 24 this repo currently targets, SEA embeds the main script as
CommonJS only and the binary dies on line 1 of the bundle.

## Context

The roadmap item says "single static binary". ADR 0009 delivered a 3.0 MB
`.mjs` that needs Node ≥ 22.12 installed. That is a distribution improvement but
not a binary: an operator on a NAS or a bare container still has to provision a
runtime first.

Node's SEA feature claims to close exactly that gap — inject a blob into a copy
of the `node` binary and ship one file. The known risk shape is the same one
ADR 0009 already answered for bundling (puppeteer's dynamic requires and
filesystem reach), plus a new one specific to SEA: **what module format does the
embedded script run as?** A SEA has no `node_modules` directory and no
`package.json` beside it to declare `"type": "module"`, so an ESM bundle has
nothing to tell the loader it is ESM.

## What was measured

Built with the repo's own `dist-bundle/carelink-bridge.mjs` (3.0 MB, ADR 0009)
as the SEA `main`. Three Node versions were tested, each by *running* the
resulting binary from a fresh directory containing only the binary.

| Node | Command | Blob built? | Binary runs? | Actual result |
|---|---|---|---|---|
| 22.22.0 | `--experimental-sea-config` + `postject` | yes | **No** | `SyntaxError: Cannot use import statement outside a module` at `embedderRunCjs` (node:internal/main/embedding:60) |
| 24.22.2 | `--experimental-sea-config` + `postject` | yes | **No** | Same error, `embedding:63`. `"mainFormat":"module"` was accepted by the config parser and **silently ignored** |
| 26.0.0 | `--build-sea=sea-config.json` | n/a (builds binary directly) | **Yes** | `--help`, `doctor` and the daemon's login path all run standalone |

Size and startup, Node 26 build:

| Artefact | Size | Needs Node? | Startup (`--help`) |
|---|---|---|---|
| `dist-bundle/carelink-bridge.mjs` | 3.0 MB | yes, ≥ 22.12 | ~0.06 s |
| `dist-sea/carelink-bridge` | **142.9 MB** | **no** | ~0.09 s |
| host `node` binary (baseline) | 121.0 MB | — | — |

The 142.9 MB is the Node runtime (121 MB) plus the 3.0 MB blob plus alignment.
`ldd` reports only `libc`, `libstdc++`, `libm`, `libgcc_s`, `libpthread`,
`libatomic` and the dynamic loader — no `node`, no `node_modules`.

Evidence the binary runs the *application* (not just that a blob was created),
all from a directory holding nothing but the binary, invoked with
`PATH=/nonexistent`:

```
$ ./carelink-bridge --help
carelink-bridge
Usage:
  carelink-bridge                run the bridge (the daemon)
  carelink-bridge doctor         pre-flight self-check
  carelink-bridge login          interactive CareLink login
...

$ ./carelink-bridge doctor
  ✗  Config (.env)                    Missing required setting(s): CARELINK_USERNAME, ...
  ✓  CareLink reachable               Discovery endpoint reachable (EU region, pin android/3.6).
  ✓  CareLink region                  GB is served by the EU region, matching MMCONNECT_SERVER.
  ✓  CareLink cumulus track           Region EU declares https://clcloud.minimed.eu/connect/carepartner/v13
  ✗  Nightscout reachable             No NS URL configured.
```

`doctor` performing live HTTPS to the CareLink discovery endpoint from a
standalone binary is the end-to-end proof: fetch, dotenv, config, HTTP client
and subcommand dispatch all survived. The daemon path additionally reaches
`component":"login` → discovery → Auth0 SSO → `puppeteer.launch()`, i.e. the
dependency ADR 0009 was written about.

### The two findings

1. **SEA on Node ≤ 24 is CommonJS-only, and says so only at runtime.** Both
   `v22.22.0` and `v24.22.2` call `embedderRunCjs`. The config field
   `"mainFormat": "module"` is a `--build-sea` (v25.5.0) feature; the older
   `--experimental-sea-config` parser does not reject it, it ignores it. That
   silence is the trap — the blob build exits 0 and postject succeeds, so every
   step looks green until the binary is run. "The blob was created" and "the
   executable runs the app" are different claims and only the second one matters.

2. **A CommonJS bundle is not an escape hatch.** The obvious workaround —
   `--format=cjs` — is blocked by the source: `src/main.ts` ends in top-level
   `await ensureLogin()`, and esbuild rejects TLA for CJS output
   (`Top-level await is currently not supported with the "cjs" output format`).
   Wrapping it in a CJS shell that `import()`s the app does not help either,
   because esbuild inlines the dynamic import into the same graph, so the TLA
   reappears. Making the CJS route work would mean restructuring `main.ts`'s
   entry (`specifier` it as external and keep two files), which defeats the
   single-file promise.

## Consequences

- **`npm run sea` is wired and works**, guarded on Node ≥ 25.5. It rebuilds the
  ESM bundle, runs `--build-sea`, then copies the binary to an empty temp
  directory and runs `--help`, `doctor` and the daemon path with
  `PATH=/nonexistent` before declaring success. The guard is not decorative: on
  Node 24 it exits 1 with the `embedderRunCjs` explanation rather than producing
  a binary that dies at line 1.
- **The version floor moves.** A static binary therefore requires raising the
  build Node from 22 (what CI pins today) to ≥ 25.5. That is a real cost and it
  is *not* decided here — it interacts with ADR 0007's Node support policy and
  with what the Docker image and CI matrix run.
- **142.9 MB per artefact, per platform.** Five platforms is ~700 MB of release
  assets, and the runtime is duplicated in every one. Whether that is acceptable
  for a self-hosted bridge is a distribution decision, not a technical one.
- **Not fully static.** It is a *single executable*, not a statically linked
  one: glibc and libstdc++ still resolve from the host. On Alpine/musl it will
  not run at all, and Node does not CI-test SEA on Alpine. "Static binary" in
  the roadmap is satisfied in the "no Node, no node_modules" sense and not in
  the "no shared libraries" sense.
- **Chromium is still not included**, exactly as ADR 0009 found. A SEA user with
  no Chrome still falls back to Strategy 3's terminal paste. This changes
  distribution, not the browser story.
- **Startup is not better** (~0.09 s vs ~0.06 s) and there is no snapshot or
  code cache in the build; the binary is bigger and marginally slower than
  `node bundle.mjs`. The win is purely "does not need Node installed".

## Reproducing

Requires Node ≥ 25.5 for the working path (this repo's `engines` still says
`>=22.12.0`; that mismatch is the open decision):

```bash
npm run sea                    # on Node >= 25.5: builds and smoke-tests dist-sea/
./dist-sea/carelink-bridge doctor
```

To see the negative result, take the same 3.0 MB bundle and build on Node 24:

```bash
cat > sea-config.json <<'JSON'
{"main":"dist-bundle/carelink-bridge.mjs","output":"sea-prep.blob",
 "mainFormat":"module","disableExperimentalSEAWarning":true}
JSON
node --experimental-sea-config sea-config.json     # exits 0, writes the blob
cp "$(command -v node)" ./carelink-bridge
npx postject carelink-bridge NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2   # succeeds
./carelink-bridge            # SyntaxError: Cannot use import statement outside a module
```

No new runtime or dev dependency is needed for the working path: `--build-sea`
replaces the separate `postject` injection step, which is a further reason not
to build the Node-24 route.

## Amendment (2026-11-16) — the double-run bug this spike exposed

Building the binary surfaced a defect that is **not** in the SEA path but was
visible through it: `doctor` printed its `injected env` banner twice. Both
`doctor.ts` and `login.ts` self-execute behind an `isMainModule` guard comparing
`process.argv[1]` with `import.meta.url` — and in ANY single-file build (bundle
or SEA) those are the same file, so the guard is true for every embedded CLI
module at once. The dispatcher in `src/bundle-main.ts` did not suppress them, so
each CLI ran twice: `doctor` performed two live discovery probes per invocation,
and `login` would have prompted twice.

Fixed on `main` in
[#174](https://github.com/NovaLux12/carelink-bridge/pull/174) by making both
guards bundle-aware via the same compile-time define this spike's build already
sets. **A binary built before that commit carries the bug** — the evidence
quoted above was captured from a pre-fix build, so a rebuild after rebasing
yields a single banner where the quoted text shows two. The `npm run sea` smoke
test does not assert on banner count; `test/bundle-subcommands.test.ts` does,
and it covers the bundle that the binary embeds.

## Not decided here

Whether to raise the build Node to ≥ 25.5 and ship a binary, which platforms to
build for and whether ~700 MB of release assets is acceptable, whether the
binary replaces or sits beside the 3.0 MB bundle and the Docker image, and how
CI produces it. ADR 0007's Node support floor is the constraint this collides
with; changing it needs its own ADR.
