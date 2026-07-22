# 0005 — Minimal runtime dependency footprint

## Status

Accepted (since v0.1.1, 2026-07-19; reaffirmed and dep count
explicitly tracked since v0.2.0).

## Context

`carelink-bridge` handles two secrets:

- **CareLink OAuth tokens** (full account access — read pump
  history, change pump settings).
- **Nightscout API secret** (write access to the operator's CGM
  and pump data; the data is the input to insulin-dosing decisions
  in downstream tools like Loop, xDrip, AAPS).

A compromise of either secret has direct medical-data consequences.
The bridge's supply chain is therefore a security boundary, not a
convenience.

Every runtime dependency is a security review cost: every transitive
dependency is a potential CVE vector. A dependency that is dormant
in the default configuration (not exercised by the bridge's code
path, but present in the lockfile) is still in the supply chain —
Dependabot reports on it, and a CVE in it is a CVE in us.

## Decision

The runtime dependency count is **explicitly tracked** in this ADR.
A new dependency requires:

1. A justification in the PR description (what capability does it
   buy us, and is there a smaller alternative?).
2. A bump of the count in this ADR.
3. Re-review of this ADR — the count is the contract.

The current runtime dependency set is:

| Package          | Why                                                                 |
|------------------|---------------------------------------------------------------------|
| `axios`          | HTTP client; used by every fetch and upload.                        |
| `dotenv`         | Load `.env` files.                                                  |
| `qs`             | URL-encoded body serialisation for OAuth POSTs (`application/x-www-form-urlencoded`). |
| `puppeteer-core` | Optional browser-based login fallback (Strategy 2 in `src/login.ts`). If the bridge moves to headless-only login, this can drop. |

`devDependencies` (vitest, tsx, typescript, @types/*) are not
counted against this budget — they are not shipped to operators
who install from the built `dist/`, and CI is the only consumer.
CVE exposure on devDeps is the maintainer's problem, not the
operator's.

## Consequences

- **Easier:** Every PR that touches `package.json` is reviewed
  through a security lens. The "just add a library" reflex is
  blunted by the requirement to justify and to update the count.
- **Easier:** The bridge is small. `npm ci` is fast. The lockfile
  is short enough to read in a single screen. Auditing a CVE
  announcement is "are we affected?" → "scan the lockfile" — not
  "recurse the dep graph."
- **Harder:** Features that would be one-line with a new
  dependency become more code without one. For example, the
  recency filter in `src/filter.ts` is implemented inline rather
  than using a date library; the SGV count limit is applied at
  transform time rather than via a `p-limit`-style library.
- **Harder:** A library that fixes a bug in its space cannot be
  adopted without porting the fix. For example, if `qs` had a
  CVE, the bridge's option is to bump `qs` (probably) or replace
  the one call site that uses it (also possible — `qs` is used
  once in the OAuth POST).
- **Harder:** A new contributor may not know which `package.json`
  additions are routine (e.g. `@types/foo` is a devDep, doesn't
  count) and which require the ADR update.

## What reverses it

- A capability that **cannot** be implemented without a new
  dependency (e.g. the bridge will not re-implement an OAuth
  client from scratch; `axios` is the right tool) is the only
  legitimate reason to add one. The "implement vs. depend" line
  is judgment, not policy.
- A vulnerability in an existing dep that requires a major
  version bump (which is a breaking change in the dep's API) is
  a legitimate reason to add a new dep that replaces the old
  one. The "replace, don't add" pattern still applies — the
  count should go up by one and the old dep should be removed
  in the same commit.
- A clear user-facing benefit (e.g. a real need for structured
  logging) is a legitimate reason to revisit, but the bar is
  high: it has to be worth the security review cost.

## Notes

- The dependency list above is the count as of v0.2.0. When this
  number changes, update both this ADR and the CHANGELOG entry
  for the version that introduced the change.
- The CI workflow is intentionally minimal (`tsc --noEmit` +
  `vitest run`); no `npm audit` step. See ADR 0006 for why.
- Dependabot is enabled and fires weekly plus on any CVE
  publication. Major version bumps require a security review
  before merge (the comment in `.github/dependabot.yml` makes
  this explicit; Dependabot PRs are not auto-merged).
