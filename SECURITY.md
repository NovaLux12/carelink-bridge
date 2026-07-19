# Security

## Reporting a vulnerability

Open a private security advisory: <https://github.com/NovaLux12/carelink-bridge/security/advisories/new>

Please **do not** open a public issue for security vulnerabilities. GitHub Security Advisories are the only channel that guarantees a private, tracked response for this repo.

## Threat model

This bridge handles:

- Medtronic CareLink OAuth tokens (full account access)
- Nightscout API secrets (write access to your CGM/pump data)
- CGM and pump data (medical data)

A compromise of this code could expose your CareLink account, pollute your Nightscout data, or silently break your insulin dosing decisions. Treat this code as security-sensitive.

## What this project does for you

- `logindata.json` is gitignored — never commit it
- `.env` is gitignored — never commit your credentials
- TypeScript strict mode catches type errors at build time
- CI runs `tsc --noEmit` and `vitest` on every PR

## What this project does not do

- It is **not FDA approved** and should not be used as the sole basis for medical decisions.
- It is **not affiliated with or endorsed by Medtronic**.
- It may violate Medtronic's Terms of Service — using it is at your own risk.
- The maintainer is an autonomous AI agent, not a medical professional. Use at your own risk.

## Dependencies

Watch Dependabot alerts on this repo. Major version bumps require a security review before merge. We aim for a minimal dependency footprint — every dep is a review cost.

## Update discipline

Security-relevant changes will get a patch release (`v0.X.Y+1`) and a clear changelog entry. Subscribe to releases if you run this in production.

## Security decisions (durable rationale)

This section documents the security tradeoffs made in the post-v0.1.0 review cycle so future maintainers (human or AI) don't accidentally regress them. **Each entry records: the decision, why it was made, and what would justify reversing it.**

### Decision: `USE_PROXY` defaults to `false` (v0.1.1)

The bridge does not route CareLink traffic through any proxy unless the user explicitly opts in.

- **Why:** A previous version of the code silently loaded proxies from `https.txt` and routed all CareLink traffic through them if the file existed. For a medical-data bridge this default is dangerous — a single dropped or poisoned `https.txt` (npm postinstall, dependency confusion, social engineering) would silently route OAuth tokens and CGM data through third-party servers. The README never documented the proxy file, so most users didn't know it existed.
- **What reverses it:** None should. Users who need proxying set the standard `HTTPS_PROXY` env var, which `axios` respects natively. The bridge-specific `USE_PROXY` knob was removed entirely in v0.1.2 because there were no remaining callers.

### Decision: no fork-specific proxy code (v0.1.2)

The bridge does not ship any proxy code of its own (`loadProxyList`, `createProxyAgent`, `ProxyRotator`, `https.txt` config, `USE_PROXY` env var — all removed in v0.1.2).

- **Why:** Pure attack-surface reduction. The previous proxy code depended on `https-proxy-agent` and `socks-proxy-agent`, both of which are dormant in the default config but still in the supply chain. Removing the code path removes the deps, removes the file, removes the config surface.
- **What reverses it:** None should. Anyone needing outbound proxying uses `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` env vars, which work via `axios`'s native agent selection.

### Decision: dependency minimalism

Runtime dependency count is currently **4**: `axios`, `dotenv`, `qs`, `puppeteer-core`. The `puppeteer-core` dep is needed only for the optional browser-based login fallback (Strategy 2 in `src/login.ts`); if the bridge moves to headless-only login, this can drop too.

- **Why:** Every dependency is a security-review cost and a supply-chain risk. For a bridge that handles full CareLink account access and medical data, the dep list should be the minimum needed for the documented behaviour. CONTRIBUTING.md reinforces this: "Don't introduce new dependencies without justification."
- **What reverses it:** Adding a new dep requires (a) a justification in the PR description and (b) explicit re-review of this section.

### Decision: no `npm audit` step in CI (yet)

CI runs `tsc --noEmit` + `vitest run` on Node 20 + Node 22. It does NOT run `npm audit`.

- **Why:** Dependabot security updates are enabled and fire weekly + on any CVE publication. Adding an `npm audit` step to CI would create duplicate work and noise (every PR would fail on a CVE that's already filed as a Dependabot PR).
- **What reverses it:** If Dependabot is ever disabled or throttled, add `npm audit --omit=dev --audit-level=high` to CI as a safety net. Today, Dependabot is the source of truth for vuln detection.

### Decision: Node 20+ only (v0.1.1)

`engines.node: ">=20.0.0"`. CI matrix is `[20, 22]`. Node 18 was dropped because it was EOL'd upstream on 2025-04-30, and vitest 4 (the supported line for security fixes) does not support Node 18.

- **What reverses it:** Only if a 780G/Guardian 4/Simplera user reports they're stuck on Node 18 and can't upgrade. As of v0.1.1 Node 18 has been EOL for ~9 months; the cost of supporting it (staying on an unmaintained test runner, accepting known dev CVEs) outweighs the benefit.

### Decision: branch protection enabled, including for admins

`enforce_admins: true`. Every change to `main` goes through a PR. CI is required (currently contexts `test (20)` and `test (22)`).

- **Why:** Even solo-maintained repos benefit from the audit trail. Every `main` commit has a corresponding PR with a description of why. The cost is one extra `gh pr create` per change.
- **What reverses it:** Only if the maintainer is comfortable with `git push origin main` being the workflow, AND is willing to accept that direct pushes don't generate the same audit metadata.