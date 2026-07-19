# Contributing

Thanks for considering a contribution. This fork exists because the upstream maintainer stepped back and someone with a 780G needed working code. We want it to stay small, focused, and easy to review.

## Workflow
1. Open an issue first for anything non-trivial (small typo fixes don't need an issue).
2. Fork the repo, create a branch.
3. Make the change.
4. Make sure `npm test` and `npx tsc --noEmit` pass.
5. Open a PR against `main`. CI runs on Node 20 and 22.
6. Wait for review. We'll try to respond within a week.

## Ground rules
- **No scope creep in PRs.** If your change is large, split it. PRs over 200 lines get extra review scrutiny.
- **No silent private changes.** Anything in this fork that diverges from upstream must be clearly explained in the PR description.
- **Tests for behaviour changes.** Bug fix? Add a regression test. New feature? Add a test that exercises it.
- **Don't introduce new dependencies without justification.** Each one is a security review cost.

## Code style
- TypeScript strict mode (already enabled in `tsconfig.json`)
- ESM (`"type": "module"`)
- No lint config yet — keep the code readable on its own merits

## Commit messages
- Imperative mood ("Fix X", not "Fixed X")
- Reference the upstream PR or issue when applicable

## Releasing (maintainers)

Version metadata must stay in sync — v0.1.1 through v0.1.3 shipped without bumping `package.json`, which is how [#17](https://github.com/NovaLux12/carelink-bridge/issues/17) happened. For every release:

1. Bump `version` in `package.json` and run `npm install --package-lock-only` to sync the lockfile.
2. Merge that change via PR like any other.
3. Tag the merge commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Cut the release: `gh release create vX.Y.Z --title vX.Y.Z --notes "..."` with a changelog entry (security-relevant changes get a clear callout per SECURITY.md).
5. Check ROADMAP.md — a phase marked "shipped" must have a matching tag and release.

## What we won't accept
- Closed-loop insulin logic (out of scope; this is a data bridge)
- Features that replace official CareLink safety notifications
- Reformatting/refactoring with no behaviour change (no "while I'm here" rewrites)
- New dependencies for trivial functionality

## Testing with real CareLink data

You can run the unit tests (`npm test`) without a CareLink account — they use mocked fixtures. To run the bridge against a real account, you'll need:
- A CareLink account with a connected pump
- A Nightscout instance
- Then `npm run login` followed by `npm start`

Real-data testing is at your own risk and may violate Medtronic's Terms of Service.