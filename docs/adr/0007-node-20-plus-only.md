# 0007 — Node.js 20+ only (Node 18 dropped)

## Status

Accepted (since v0.1.1, 2026-07-19).

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
  by the bump alone.
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

The data flow code does not depend on Node 20 features; the
constraint is purely about the test runner and dev dependencies.
The runtime code (`src/`) does not need to change.

## Notes

- Node release schedule: <https://nodejs.org/en/about/previous-releases>
- The 9-month EOL-to-removal window in this ADR is a judgment
  call, not a rule. A future maintainer who wants to lengthen or
  shorten the window can do so by editing this ADR and explaining
  the new reasoning.
