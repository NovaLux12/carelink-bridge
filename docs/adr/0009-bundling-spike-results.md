# 0009 — Distribution bundling: esbuild can produce a runnable single file

## Status

**Spike result, 2026-11-15.** Answers the blocking question in
[issue #143](https://github.com/NovaLux12/carelink-bridge/issues/143)
(`v0.5.0 — single static binary`). Not yet adopted: this ADR records what was
measured, and the decision it enables, so the next person does not have to
re-derive it. Reserve an ADR number for the adoption itself.

## Context

Issue #143 blocked on one question:

> Does `puppeteer-core` (login Strategy 2) survive the bundler? If it cannot
> carry a chromium download mechanism, Strategy 2 splits into a separate
> package or the bridge goes headless-only — in which case `puppeteer-core`
> drops from the dependency list entirely.

The fear was reasonable: `puppeteer-core` reaches into the filesystem, does
dynamic `require`s, and depends on how the caller supplies an executable path.
Bundlers historically choke on exactly that shape.

**The premise was never tested.** It was carried as a blocker since the roadmap
was written.

## What was measured

`esbuild` 0.x (already in `node_modules` as a vitest dependency — no new
dependency was added to run this), `--platform=node --target=node22 --format=esm`,
against `src/main.ts`.

| Variant | Size | Runs? |
|---|---|---|
| `--external:puppeteer-core` | 740 KB | **No** — `Error: Dynamic require of "fs" is not supported` |
| `--external:puppeteer-core` + `createRequire` banner | 740 KB | **Yes** — reaches the OAuth flow and Strategy 2's browser launch |
| Nothing external, no banner | 2.9 MB | **No** — `Identifier 'createRequire' has already been declared` |
| Nothing external + **namespaced** `createRequire` banner | 2.9 MB | **Yes** — reaches the OAuth flow and Strategy 2's browser launch |

The last row is the one that matters: **`puppeteer-core` bundles and runs
inline.** A single file containing the entire program — puppeteer included —
starts, fetches the discovery document, fetches the Auth0 config, and calls
`puppeteer.launch()`. It got as far as a browser launch failure caused by a
stale puppeteer profile directory on this machine, not by bundling.

### The two real findings

1. **ESM output needs a `createRequire` shim, always.** Any CommonJS-syntax
   dependency in the graph (Node builtins via dynamic import, and puppeteer's
   own internals) emits `Dynamic require of "x" is not supported` in ESM output.
   This is not a puppeteer problem; it is an ESM bundling fact. The banner
   fixes it:

   ```
   --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"
   ```

2. **The banner identifier must be namespaced.** A plain `createRequire` import
   collides with the one `puppeteer-core` inlines itself, and the output dies
   with `Identifier 'createRequire' has already been declared`. `as __cr` (or
   any unused name) resolves it. This failure only appears in the *inlined*
   build, so a spike that stopped at `--external` would have missed it and
   concluded the opposite.

## Consequences

- **`puppeteer-core` is not a bundling blocker.** The premise of #143's
  blocking question is false. The single-binary path does not require splitting
  Strategy 2 into a separate package, and it does not force headless-only
  login.
- **The dependency stays.** ADR 0005's minimalism argument is unaffected: the
  question was never whether puppeteer belongs in the dependency list, only
  whether it survives bundling. It does.
- **esbuild produces a bundle, not a static binary.** These runs still resolve
  `node:` builtins from the host Node, so the artefact is a *single-file
  bundle* requiring Node ≥ 22.12, not a self-contained executable. Genuinely
  static output needs a SEA (`node --experimental-sea-config`) or a tool that
  embeds Node; that is a separate question and it is still open.
- **Chromium is still not included**, and cannot be: `puppeteer-core` never
  downloads a browser (that is the difference from `puppeteer`). A user with no
  Chrome installed still falls back to Strategy 3's terminal paste. Bundling
  changes the distribution story, not the browser-availability story — the
  Docker image already behaves this way.

## Reproducing

```bash
npx esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm \
  --outfile=/tmp/main.mjs \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"
node /tmp/main.mjs      # reaches the login flow
```

Run it from the repo root so `node_modules` resolves; moving the bundle to a
directory without `node_modules` is fine for the inlined variant and fails for
the `--external` one.

## Not decided here

Whether to ship the bundle, how to build it in CI, whether to move to a SEA for
a true static binary, and whether `latest`-style distribution changes. Those
are the adoption decisions #143 still owns.
