# Contributing

Thanks for considering a contribution. This fork exists
because the upstream maintainer stepped back and someone
with a 780G needed working code. We want it to stay small,
focused, and easy to review.

## Before you start

**Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) first.**
It explains the code, the data model, the test architecture,
and the cross-cutting concerns (auth, retry, token storage)
that the codebase is built around. A PR that conflicts with
the architecture is a longer review than a PR that fits it.

If your change is a **new architectural choice** (a new
failure-handling policy, a new login strategy, a new
dependency), write an ADR in `docs/adr/` first. The
[index](./docs/adr/README.md) explains the format.

## Workflow

1. Open an issue first for anything non-trivial (small typo
   fixes don't need an issue).
2. Fork the repo, create a branch.
3. Make the change.
4. Make sure `npm test` and `npx tsc --noEmit` pass.
5. Open a PR against `main`. CI runs on Node 20 and 22.
6. Wait for review. We'll try to respond within a week.

## Ground rules

These are not negotiable:

- **No scope creep in PRs.** If your change is large, split
  it. PRs over 200 lines get extra review scrutiny. A bug
  fix, a refactor, and a new feature are three PRs, not one.
- **No silent private changes.** Anything in this fork that
  diverges from upstream must be clearly explained in the
  PR description. The PR template has an explicit section
  for this.
- **Tests for behaviour changes.** Bug fix? Add a regression
  test. New feature? Add a test that exercises it. Refactor
  with no behaviour change? Don't open the PR (see
  "out of scope" below).
- **Don't introduce new dependencies without justification.**
  Each one is a security review cost. See
  [ADR 0005](./docs/adr/0005-dependency-minimalism.md) for
  the policy and the current dependency count.
- **No new architectural decisions without an ADR.** If
  you're adding a retry strategy, an auth path, a config
  knob, a failure mode — write the ADR in the same PR.
  ADRs are cheap; the absence of one is expensive for the
  next maintainer.

## Code style

- TypeScript strict mode (already enabled in `tsconfig.json`).
- ESM (`"type": "module"` in `package.json`).
- No lint config yet — keep the code readable on its own
  merits. (If a real lint config would catch the kind of
  bug we've actually shipped, propose it as an ADR; don't
  add a "while I'm here" prettier config.)
- Prefer updating existing files over creating new ones.
- Prefer boring code over clever code. This is medical data.

## Commit messages

- Imperative mood ("Fix X", not "Fixed X").
- Reference the upstream PR or issue when applicable.
- One commit per logical change. Squash before review.

## Branch protection

`main` is protected. Every change goes through a PR with
required CI checks (`test (20)`, `test (22)`). The
`enforce_admins` flag is on, so even the maintainer can't
push directly. See [ADR 0008](./docs/adr/0008-branch-protection-enforce-admins.md)
for the rationale.

## Testing with real CareLink data

You can run the unit tests (`npm test`) without a CareLink
account — they use mocked fixtures. To run the bridge
against a real account, you'll need:

- A CareLink account with a connected pump.
- A Nightscout instance.
- Then `npm run login` followed by `npm start`.

**Real-data testing is at your own risk** and may violate
Medtronic's Terms of Service. Don't commit your
`logindata.json`; don't paste your real CareLink username
or Nightscout API secret in issues or PRs.

If you find a bug that only shows up against real data, the
most useful thing you can do is:

1. Add a sanitised fixture to `test/samples.ts` (strip
   your username, account IDs, patient identifiers).
2. Write a regression test against the fixture.
3. Open the PR with the test failing, then the fix
   making it pass.

That gives the next maintainer something to test against
without needing their own real pump.

## Releasing (maintainers)

Version metadata must stay in sync — v0.1.1 through v0.1.3
shipped without bumping `package.json`, which is how
[#17](https://github.com/NovaLux12/carelink-bridge/issues/17)
happened. For every release:

1. Bump `version` in `package.json` and run
   `npm install --package-lock-only` to sync the lockfile.
2. Move the `[Unreleased]` items in CHANGELOG.md into a new
   dated version section and update the compare links at the
   bottom.
3. Merge those changes via PR like any other.
4. Tag the merge commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Cut the release: `gh release create vX.Y.Z --title vX.Y.Z --notes "..."`
   — the notes should match the CHANGELOG entry
   (security-relevant changes get a clear callout per
   [SECURITY.md](./SECURITY.md)).
6. Check ROADMAP.md — a phase marked "shipped" must have
   a matching tag and release.
7. If a new architectural decision was made in this
   release, the ADR should already exist in `docs/adr/`.
   Confirm the index table is up to date.

## What we won't accept

- Closed-loop insulin logic (out of scope; this is a data
  bridge). See [ROADMAP.md](./ROADMAP.md#out-of-scope-explicitly).
- Features that replace official CareLink safety
  notifications. The bridge surfaces CareLink's existing
  alarms; we don't add new alarm sources.
- Reformatting / refactoring with no behaviour change
  (no "while I'm here" rewrites).
- New dependencies for trivial functionality. See
  [ADR 0005](./docs/adr/0005-dependency-minimalism.md).
- New architectural choices without an ADR. See "Ground
  rules" above.

## How to ask a question

Open a [question issue](https://github.com/NovaLux12/carelink-bridge/issues/new?template=question.yml)
— don't email, don't DM. Issues are searchable and the
answer benefits the next person.
