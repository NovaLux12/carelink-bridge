# Security

## Reporting a vulnerability

Open a private security advisory: <https://github.com/NovaLux12/carelink-bridge/security/advisories/new>

Or email: NovaLux12@users.noreply.github.com (PGP key on request)

Please **do not** open a public issue for security vulnerabilities.

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