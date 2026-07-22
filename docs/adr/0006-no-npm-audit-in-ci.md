# 0006 — No `npm audit` step in CI

## Status

Accepted (since v0.1.1, 2026-07-19).

## Context

The bridge handles CareLink OAuth tokens and Nightscout API secrets —
secrets with medical-data consequences (see ADR 0005). It is
therefore tempting to add an `npm audit` step to CI to catch
vulnerable dependencies before they reach `main`.

CI currently runs `tsc --noEmit` + `vitest run` on Node 20 and
Node 22. The maintainer also has Dependabot security updates
enabled (`.github/dependabot.yml`), with weekly runs plus immediate
runs on any CVE publication for any ecosystem dependency, capped
at 5 open PRs.

## Decision

CI does not run `npm audit`.

## Consequences

- **Easier:** No duplicate work. Dependabot files a PR on the same
  day a CVE is published; `npm audit` would file the same
  information again. Two sources of truth for the same signal.
- **Easier:** PRs do not fail on a CVE that's already filed as a
  Dependabot PR. A contributor does not have to check the
  Dependabot queue to know whether a failing `npm audit` is
  actionable.
- **Harder:** If Dependabot is ever disabled, throttled, or its
  configuration drifts, the bridge has no second line of defence
  in CI. The audit gap is silent.

## What reverses it

If Dependabot is ever disabled (manually or by a GitHub
configuration change) or throttled (e.g. rate-limited on a small
project that hits a quota), add `npm audit --omit=dev --audit-level=high`
to `.github/workflows/ci.yml` as a safety net. DevDependencies
are omitted because they are not shipped to operators; only the
runtime surface (axios, dotenv, qs, puppeteer-core) is in scope.

The bar for "Dependabot is no longer the source of truth" is
high — it should be a deliberate config change or a sustained
silence (multiple weeks without a Dependabot PR on a known
CVE), not a single missed update.

## Notes

- `.github/dependabot.yml` is the source of truth for the policy
  in this ADR. Major version bumps require security review
  before merge (the file's own comment makes this explicit;
  Dependabot PRs are not auto-merged).
- The `weekly` schedule plus CVE-triggered runs is the cadence
  that `npm audit --watch` would approximate; the trade-off is
  that Dependabot is one-way (it files a PR; it does not block
  a PR).
- The `open-pull-requests-limit: 5` cap means a CVE storm (a
  transitive dep with a major regression) can queue PRs. The
  CI does not need to be aware of this — Dependabot manages the
  queue; the security review happens at PR open time.
