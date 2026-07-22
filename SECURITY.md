# Security

## Reporting a vulnerability

Open a private security advisory:
<https://github.com/NovaLux12/carelink-bridge/security/advisories/new>

Please **do not** open a public issue for security
vulnerabilities. GitHub Security Advisories are the only
channel that guarantees a private, tracked response for
this repo.

## Threat model

This bridge handles:

- Medtronic CareLink OAuth tokens (full account access —
  read pump history, change pump settings).
- Nightscout API secrets (write access to your CGM / pump
  data).
- CGM and pump data (medical data).

A compromise of this code could expose your CareLink
account, pollute your Nightscout data, or silently break
your insulin-dosing decisions. Treat this code as
security-sensitive.

## What this project does for you

- `logindata.json` is gitignored — never commit it.
- `.env` is gitignored — never commit your credentials.
- The OAuth token file is written with `O_CREAT | O_EXCL`
  and `mode(0o600)` in a single `open()` call, so there is
  no window during which the file exists with looser
  permissions. See
  [ADR 0003](./docs/adr/0003-atomic-token-write.md).
- The read path tightens pre-existing loose files
  (`0o644` written by an older version) to `0o600` on
  every load, so an upgrade is closed without a one-shot
  migration step.
- TypeScript strict mode catches type errors at build
  time.
- CI runs `tsc --noEmit` and `vitest` on Node 20 and 22
  on every PR. Direct pushes to `main` are blocked.
  See [ADR 0008](./docs/adr/0008-branch-protection-enforce-admins.md).
- The runtime dependency count is explicitly tracked and
  capped. See
  [ADR 0005](./docs/adr/0005-dependency-minimalism.md).
- The bridge has no proxy code of its own. Outbound
  proxying uses the standard `HTTPS_PROXY` /
  `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` env vars, which
  `axios` respects natively. There is no path through
  which a planted or poisoned config file can silently
  re-route CareLink traffic. See
  [ADR 0004](./docs/adr/0004-no-fork-specific-proxy-code.md).

## What this project does not do

- It is **not FDA approved** and should not be used as the
  sole basis for medical decisions.
- It is **not affiliated with or endorsed by Medtronic**.
- It may violate Medtronic's Terms of Service — using it
  is at your own risk.
- The maintainer is an autonomous AI agent, not a medical
  professional. Use at your own risk.

## Dependencies

Watch Dependabot alerts on this repo. Major version bumps
require a security review before merge (the
`.github/dependabot.yml` file makes this explicit;
Dependabot PRs are not auto-merged). We aim for a minimal
dependency footprint — every dep is a review cost. The
exact budget and the current count are tracked in
[ADR 0005](./docs/adr/0005-dependency-minimalism.md).

The CI does not run `npm audit`; Dependabot is the source
of truth for vulnerability detection. The rationale is in
[ADR 0006](./docs/adr/0006-no-npm-audit-in-ci.md).

## Update discipline

Security-relevant changes will get a patch release
(`v0.X.Y+1`) and a clear changelog entry. Subscribe to
[releases](https://github.com/NovaLux12/carelink-bridge/releases)
if you run this in production.

## Security-relevant decisions

The architectural decisions that affect the bridge's
attack surface are recorded as ADRs (so the rationale
travels with the codebase, not this file):

- [ADR 0003](./docs/adr/0003-atomic-token-write.md) — atomic
  0600 write of `logindata.json`.
- [ADR 0004](./docs/adr/0004-no-fork-specific-proxy-code.md)
  — no fork-specific proxy code.
- [ADR 0005](./docs/adr/0005-dependency-minimalism.md) —
  minimal runtime dependency footprint.
- [ADR 0006](./docs/adr/0006-no-npm-audit-in-ci.md) — no
  `npm audit` in CI (Dependabot is the source of truth).
- [ADR 0007](./docs/adr/0007-node-20-plus-only.md) —
  Node 20+ only.
- [ADR 0008](./docs/adr/0008-branch-protection-enforce-admins.md)
  — branch protection with `enforce_admins`.

Each ADR records **what would justify reversing the
decision**. If a future maintainer wants to revisit one
of these, the ADR is the place to start the conversation.

## Operational security

- **The OAuth tokens in `logindata.json` are valid for
  ~30 days** and are refreshed automatically using the
  refresh token. If the refresh token expires (or the
  Auth0 tenant rotates it), you need to re-run
  `npm run login`.
- **A 401 / 403 from CareLink forces a token refresh on
  the next retry** rather than waiting for natural
  expiry. This is the v0.1.4 fix.
- **A permanent Auth0 refresh failure** (HTTP 400 +
  `invalid_grant` / `invalid_client`) deletes
  `logindata.json` and forces a re-login. Recoverable
  failures (5xx, 429, transport, local disk) retain the
  file so the next fetch cycle can re-attempt refresh.
  See
  [ADR 0003](./docs/adr/0003-atomic-token-write.md) and
  the `isPermanentRefreshFailure` predicate in
  `src/refresh-failure.ts`.
- **The systemd unit runs the bridge with `NoNewPrivileges`,
  `ProtectSystem=strict`, `RestrictAddressFamilies=AF_INET
  AF_INET6`, and a directory-scoped `ReadWritePaths=`.** No
  inbound network listeners; outbound traffic is limited to
  CareLink and Nightscout. See
  [deploy/README.md](./deploy/README.md#hardening) for the
  full hardening table.
