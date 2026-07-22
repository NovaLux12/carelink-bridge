# 0008 — Branch protection with `enforce_admins`

## Status

Accepted (since v0.1.1, 2026-07-19).

## Context

`main` is the canonical source of truth for the bridge's behaviour.
Every operator who installs from `main` (or from a tag pointing
at a `main` commit) trusts the code to handle their CareLink
tokens and Nightscout secrets correctly.

A direct push to `main` — `git push origin main` — produces a
commit that:

- Bypasses the PR review process. No description, no diff link,
  no conversation record of why the change was made.
- Bypasses CI. The required checks (`test (20)`, `test (22)`) do
  not run on direct pushes.
- Has a different audit trail than a merged PR. GitHub's UI
  surfaces "X pushed to main" instead of "X merged PR #N."

The bridge is solo-maintained. The temptation to push directly is
real: a small typo fix, an emergency revert, a fast path when
"it's obviously correct." Solo-maintained projects often disable
branch protection for this reason.

## Decision

Branch protection on `main` is enabled with `enforce_admins: true`.
Every change to `main` goes through a PR. CI is required (currently
contexts `test (20)` and `test (22)`).

The `enforce_admins` flag is the load-bearing part. GitHub allows
admins to bypass protection by default; `enforce_admins: true`
removes that bypass. The maintainer (who is also the only admin)
is subject to the same rule as any external contributor.

## Consequences

- **Easier:** Every `main` commit has a corresponding PR with a
  description of *why* the change was made. The git history is
  auditable; the rationale is one click away.
- **Easier:** CI runs on every change. A typo fix that breaks a
  test is caught before merge, not after an operator's install
  fails.
- **Easier:** The PR template (`.github/PULL_REQUEST_TEMPLATE.md`)
  forces the contributor (even the solo maintainer) to fill in
  "what does this PR do" and "how was it tested." This is the
  project's primary retrospective context.
- **Harder:** Every change requires a `gh pr create` (or web UI
  click). For a one-line typo fix this is overhead. The cost is
  one extra step per change, paid in exchange for the audit
  trail.
- **Harder:** An emergency revert that has to bypass review
  (e.g. a CVE dropped on a holiday) cannot be fast-pushed. The
  emergency path is "open a PR with `main` as the base, mark
  it as urgent, run CI on it" — the protection is the same.

## What reverses it

Only if the maintainer is comfortable with `git push origin main`
as the workflow, AND is willing to accept that direct pushes
don't generate the same audit metadata. This is a personal-style
decision, not a project-quality decision; the maintainer of a
solo project is allowed to make it. The reverse path is:

- Disable `enforce_admins` (or disable protection entirely).
- Accept that future `git log main` will contain commits without
  PR records.

A multi-admin project (more than one person with write access)
should not reverse this — branch protection is the only thing
that prevents one admin from pushing to `main` and making
another admin's local clone diverge.

## Notes

- The PR template at `.github/PULL_REQUEST_TEMPLATE.md` is the
  enforcement mechanism for the "describe your change" rule.
- The required CI contexts are listed in
  `.github/workflows/ci.yml`. Adding a new required context
  (e.g. a future lint step) is a repo-settings change, not a
  code change; the maintainer should announce the change in
  the next release.
