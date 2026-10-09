# Architecture Decision Records

This directory contains the **architectural decision records** (ADRs) for
`carelink-bridge`. Each ADR records one significant design choice: the
context that forced the choice, the decision itself, and the consequences
(including what would justify reversing it).

## Format

We use Michael Nygard's format:

1. **Title** — short noun phrase.
2. **Status** — `Accepted` (current policy), `Superseded by ADR-XXXX`
   (replaced by a later decision), or `Deprecated` (no longer applies).
3. **Context** — the forces at play. The "why we had to decide something"
   section. This is where the problem and the constraints live.
4. **Decision** — the choice that was made, in one or two sentences.
5. **Consequences** — what becomes easier, what becomes harder, what
   tradeoffs are now baked in. **What would justify reversing the
   decision** is called out explicitly at the end of this section so a
   future maintainer (human or AI) doesn't accidentally regress a
   load-bearing choice.
6. **Notes** (optional) — verification dates, source code paths, anything
   the future maintainer would otherwise have to rediscover.

## Immutability

ADRs are **immutable once merged**. If a decision is reversed or changed,
write a new ADR that explicitly **supersedes** the old one. Do not edit
the old ADR in place — the historical record matters as much as the
current state.

One clarification, because it comes up in practice and guessing it is how
a merged ADR ends up rewritten: the rule above is about **decisions**.
Changing a decision still requires a new superseding ADR. An **evidence
correction** — a re-probed matrix, a corrected status code, a symbol
renamed — may be applied to a merged ADR in place, but only by appending
an explicit `## Amendment (YYYY-MM-DD)` section that quotes the
superseded text verbatim and labels it superseded with the date. The
superseded text stays in the file; the corrected text lives in the body
and in the Amendment's explanation of what changed. That keeps the
history recoverable without reading the git log, which is what the rule
is protecting, without forcing a new ADR number for a typo.
[ADR 0002](./0002-discovery-app-version-pin.md) carries the worked
example.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](./0001-status-aware-retry-policy.md) | Status-aware retry policy with jitter | Accepted |
| [0002](./0002-discovery-app-version-pin.md) | Discovery app-version pinned to `android/3.6` | Accepted |
| [0003](./0003-atomic-token-write.md) | Atomic 0600 write of `logindata.json` | Accepted |
| [0004](./0004-no-fork-specific-proxy-code.md) | No fork-specific proxy code | Accepted |
| [0005](./0005-dependency-minimalism.md) | Minimal runtime dependency footprint | Accepted |
| [0006](./0006-no-npm-audit-in-ci.md) | No `npm audit` step in CI | Accepted |
| [0007](./0007-node-20-plus-only.md) | Node.js 20+ only (Node 18 dropped) | Accepted |
| [0008](./0008-branch-protection-enforce-admins.md) | Branch protection with `enforce_admins` | Accepted |

## How to add a new ADR

1. Copy the latest ADR's filename pattern (`NNNN-short-kebab-title.md`).
2. Use the next available number. Grep `docs/adr/` to find what's taken.
3. Fill in the six sections. **Context** is the most important — the
   future maintainer who doesn't have your context is the reader.
4. Cross-link to any ADR this one supersedes or depends on.
5. Add a row to the table above.
6. Open a PR. The ADR is reviewable like any other change.
