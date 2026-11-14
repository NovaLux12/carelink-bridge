# 0007 — Node.js floor (Node 18 dropped; floor later raised to 22.12)

## Status

Accepted (since v0.1.1, 2026-07-19).
**Amended 2026-11-13:** the floor moved from Node 20 to Node 22.12. See
"Amendment" at the end — the original decision text is kept verbatim so the
reasoning that produced it stays readable.

## Context

Node.js 18 entered End-of-Life on 2025-04-30. After that date, the
Node release working group no longer ships security fixes for it.

The bridge's `engines.node` was `"*"` (accepting any modern Node)
in the pre-fork upstream. The v0.1.0 review cycle found two
specific costs of continuing to support Node 18:

- The bridge's test runner had to be vitest 3.x (the last line
  that supported Node 18). vitest 4 is the supported line for
  security fixes; bumping to it dropped Node 18.
- Continuing to run the test matrix on Node 18 means CI is
  exercising an EOL'd runtime. A security-relevant test failure
  on Node 18 does not get fixed upstream.

The bridge is a personal-data and medical-data app. Running the
test suite on an EOL'd runtime is a backwards-compatibility
trade-off the project should not be making.

## Decision

- `engines.node: ">=20.0.0"` in `package.json`.
- CI matrix is `[20, 22]`.
- Node 18 is not supported. A bug report that says "this only
  fails on Node 18" is closed with "upgrade to Node 20+; Node 18
  is EOL."

## Consequences

- **Easier:** CI runs against a supported runtime. A CI failure
  reflects a real bug, not an EOL-runtime quirk.
- **Easier:** vitest 4 (the supported line) is used. Transitive
  dev-dependency CVEs that were present in vitest 3 are closed
  by the bump alone. (Current state: `vitest ^5.1.0` — see the note
  in "What reverses it". The reasoning is unchanged; only the line number
  moved.)
- **Harder:** A user on Node 18 cannot install the bridge without
  upgrading their Node runtime. As of v0.1.1, Node 18 has been
  EOL for ~9 months. The "stuck on Node 18" cohort is small and
  shrinking; the cost of supporting them (staying on an
  unmaintained test runner, accepting known dev CVEs) is larger
  than the cost of the upgrade nudge.

## What reverses it

Only if a real user with a 780G / Guardian 4 / Simplera device
reports they are stuck on Node 18 and cannot upgrade their
runtime. The bar is high — "I'm using a corporate-managed laptop
that ships Node 18" is a legitimate barrier, but it is a barrier
to be resolved at the laptop level (Node 20+ is widely available
in corporate package managers and via nvm), not at the bridge
level. The bridge should not regress its test runtime to support
a constraint that is better solved elsewhere.

If the situation is reversed, the changes are:

- `engines.node: ">=18.0.0"` (or back to `"*"` if no specific
  minimum is desired).
- CI matrix includes Node 18.
- Test runner is pinned to a vitest line that supports Node 18.
  (Today that is `vitest ^5.1.0`, which requires Node 22.12+; it moved
  `5.x` after the `^4` line this ADR originally landed on. `engines.node`
  is still `>=20.0.0`, so the runtime floor and the test-runner floor
  are no longer the same number — see the note below.)

The data flow code does not depend on Node 20 features; the
constraint is purely about the test runner and dev dependencies.
The runtime code (`src/`) does not need to change.

## Notes

- ~~**The test-runner line has moved twice since this ADR was accepted.**
  `package.json` now pins `vitest ^5.1.0`, whose own `engines.node` is
  `^22.12.0 || ^24.0.0 || >=26.0.0` — i.e. the *dev* floor is now Node 22.12,
  while `engines.node` for the shipped package is still `>=20.0.0` and the CI
  matrix is still `[20, 22]`. Node 20 can install and run the bridge but
  cannot run the suite.~~
  **Corrected 2026-11-13 — that was wrong in fact and wrong about the cause.**
  The claim "cannot run the suite" was never true: CI's `ci (20)` job ran
  `Tests 594 passed (594)` on Node 20.20.2 on every push. The real blocker was
  never the test runner — it was **`puppeteer-core@25.16.0`**, a *runtime*
  dependency (`@puppeteer/browsers` agrees), which declares
  `engines.node: ">=22.12.0"`. Node 20 produced three `npm warn EBADENGINE`
  blocks and hard-fails under `--engine-strict`. So the paragraph above excused
  a matrix mismatch that did not exist, and pointed at the wrong dependency.
- Node release schedule: <https://nodejs.org/en/about/previous-releases>
- The 9-month EOL-to-removal window in this ADR is a judgment
  call, not a rule. A future maintainer who wants to lengthen or
  shorten the window can do so by editing this ADR and explaining
  the new reasoning.

## Amendment — 2026-11-13: floor raised to Node 22.12

**What changed:** `engines.node` is now `">=22.12.0"` and the CI matrix is
`[22, 24]`. Node 20 was dropped.

**Why, in order of weight:**

1. **Node 20 was EOL on 2026-04-30.** At the time of this amendment that is
   seven months of missing security fixes, on a package that handles medical
   data. The original ADR argued an EOL'd runtime is the wrong trade; that
   argument now applies to Node 20 itself.
2. **A runtime dependency refuses it.** `puppeteer-core@25.16.0` and
   `@puppeteer/browsers@3.2.6` both declare `engines.node: ">=22.12.0"`.
   `puppeteer-core` is imported eagerly by `src/login.ts`, which `src/main.ts`
   imports — so this is not an optional code path. `deploy/install.sh` gated at
   major-version 20 only and therefore green-lit an unsupported runtime.
3. **The 22.12 minor matters, not just the major.** A major-only check accepts
   22.0–22.11, which the dependency also refuses. The installer now compares
   major and minor.

**Verified, not assumed:** `npm ci` on Node 22 succeeds against the 0.3.1
lockfile; the probe `if [ "$M" -lt 22 ] || { [ "$M" -eq 22 ] && [ "$N" -lt 12 ]; }`
rejects 20.20.2 and 22.11.0 and accepts 22.12.0 and 24.22.2.

**What this does not claim:** no live CareLink account has ever been exercised
on any Node version. This amendment is about the dependency contract, nothing
more.
