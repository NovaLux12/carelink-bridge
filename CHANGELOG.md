# Changelog

All notable changes to this fork are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(0.x: minor = phase, patch = fixes within a phase).

Entries before v0.1.0 describe the upstream history this fork carries.
Written retroactively on 2026-07-19; dates are taken from the git/tag/release
record, not reconstructed.

## [Unreleased]

### Changed

- The discovery app-version string (`android/3.6`) is now a documented,
  named constant in `src/login.ts`. Live probing showed Medtronic's discovery
  endpoint returns a different config per version — only 3.6/3.7 carry the
  Auth0 SSO config this flow needs, while 3.4 and 4.0 return no-Auth0 tracks —
  so a well-meaning "bump to a newer number" would silently break login. The
  no-SSO-URL error now names the version string as the likely cause.

## [0.1.5] — 2026-07-19

### Fixed

- Data POST bodies (BLE and carepartner) now use the username CareLink reports
  from `/patient/users/me` instead of `CARELINK_USERNAME` verbatim, falling
  back to the configured value. Operators who enter their email while their
  CareLink username differs no longer send the wrong identifier on every data
  request. A verbose-mode log notes when the two differ. ([#25])

### Notes

- Round 2 of the auth-flow research validated the automated-login page
  scraping against Medtronic's live Auth0 Universal Login (field names,
  hidden fields, submit action all match) and confirmed nightscout-connect
  uses the same data-endpoint family. Findings: [#12 round-2 comment].

## [0.1.4] — 2026-07-19

### Fixed

- A 401/403 from the CareLink API now forces a token refresh on the next
  retry. Previously a token invalidated mid-lifetime (most commonly by the
  CareLink phone app logging into the same account) was retried until its
  natural expiry, stalling the bridge. ([#22], closes [#21])

### Changed

- Token expiry margin widened from 60s to 600s, matching the
  carelink-python-client reference, so a token passing the check cannot
  expire mid-fetch. ([#22])
- Carepartner data-endpoint fallbacks are now derived from a known-version
  list (13, 11, 6, 5) instead of a hardcoded v5/v6 replace-chain, adding the
  v13 generation that Medtronic's app discovery config now advertises and
  degrading sanely for unknown future versions. ([#23])

### Notes

- Round 1 of the auth-flow research validated the implementation against
  Medtronic's live discovery/SSO/OpenID configs: the Auth0 migration is
  complete for US and EU, the config shapes match our types field-for-field,
  and PKCE S256 is explicitly supported. Findings: [#12 round-1 comment].

## [0.1.3] — 2026-07-19

### Added

- `deploy/` directory: hardened user-level systemd unit, idempotent
  `install.sh`, Nightscout + MongoDB + cloudflared docker-compose stack, and
  a full deployment runbook. ([#6])
- Maintainer release checklist in CONTRIBUTING.md so version metadata cannot
  drift silently again. ([#18], closes [#17])

### Fixed

- Pump timezone offset now rounds to the nearest 15 minutes instead of whole
  hours. Users in half/quarter-hour timezones (+05:30 India, +09:30 central
  Australia, +05:45 Nepal, −03:30 Newfoundland) previously had every SGV
  timestamp skewed by up to 30 minutes. Pump clocks off by more than 7.5
  minutes are no longer silently rounded away. ([#20], closes [#15])
- systemd unit grants `ReadWritePaths` at directory level; the previous
  per-file bind mounts would have blocked deletion of `logindata.json` on
  refresh-token expiry (unlink EBUSY), silently defeating the stale-token
  recovery path. The `.env` write grant (never needed) was dropped.
  ([#19], closes [#16])
- CONTRIBUTING.md no longer claims CI runs on Node 18; `package.json` version
  synced with the release tag. ([#18], closes [#17])

## [0.1.2] — 2026-07-19

### Removed

- All fork-specific proxy code (`loadProxyList`, `createProxyAgent`,
  `ProxyRotator`, the `https.txt` proxy-list file, and the `USE_PROXY` env
  var), along with the `https-proxy-agent` and `socks-proxy-agent`
  dependencies. Pure attack-surface reduction: −146/+18 lines, two fewer
  supply-chain deps. ([#4])

### Changed

- Outbound proxying is now done via the standard `HTTPS_PROXY` /
  `ALL_PROXY` env vars, which axios respects natively; documented in the
  README. ([#4])

## [0.1.1] — 2026-07-19

### Security

- `USE_PROXY` defaults to `false`. A previous version silently routed all
  CareLink traffic (OAuth tokens, CGM data) through proxies listed in an
  undocumented `https.txt` file if it existed. Undocumented `my.env` config
  lookups removed. SECURITY.md gained a durable security-decisions section
  explaining each choice and what would justify reversing it.

### Added

- Regression test for the cherry-picked BLE device detection fix, locking in
  the `deviceFamily || medicalDeviceFamily` fallback from upstream PR #2.
- Acknowledgements crediting @terminalcommand and @nraverdy.
- Dependabot security updates, issues, and branch protection on `main`
  (required CI checks, `enforce_admins`).

### Changed

- Dropped Node 18 (EOL 2025-04-30); CI matrix is now Node 20 + 22.
- vitest bumped to ^4, clearing five transitive dev-dependency CVEs.
- `package.json` version corrected from the inherited `2.0.0` to `0.1.0` to
  match the tag line.

## [0.1.0] — 2026-07-18

Minimum viable community fork of
[domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge),
picked up while upstream is quiet.

### Added

- Cherry-picked [upstream PR #2] by @terminalcommand: BLE device detection
  for patient accounts. The patient `monitor/data` endpoint reports the
  device family as `deviceFamily`, not `medicalDeviceFamily`; without the
  fallback, 780G, Guardian 4, and Simplera devices fell through to a legacy
  endpoint that returns empty data.
- CI workflow (`tsc --noEmit` + vitest).
- Community fork README notice, ROADMAP.md, CONTRIBUTING.md, SECURITY.md.

## Pre-fork upstream history

Carried in this repository's git history from
[domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge):

- **2026-06-11** — BLE device detection fix for patient accounts (the change
  later formalized as [upstream PR #2] and credited above).
- **2026-02-16** — BLE device support and country/language configuration
  (upstream #1).
- **2026-02-13** — Initial upstream implementation: CareLink mobile-app OAuth
  (three-strategy login), pump/CGM fetch, Nightscout transform and upload.

[Unreleased]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NovaLux12/carelink-bridge/releases/tag/v0.1.0
[#4]: https://github.com/NovaLux12/carelink-bridge/pull/4
[#6]: https://github.com/NovaLux12/carelink-bridge/pull/6
[#15]: https://github.com/NovaLux12/carelink-bridge/issues/15
[#16]: https://github.com/NovaLux12/carelink-bridge/issues/16
[#17]: https://github.com/NovaLux12/carelink-bridge/issues/17
[#18]: https://github.com/NovaLux12/carelink-bridge/pull/18
[#19]: https://github.com/NovaLux12/carelink-bridge/pull/19
[#20]: https://github.com/NovaLux12/carelink-bridge/pull/20
[#21]: https://github.com/NovaLux12/carelink-bridge/issues/21
[#22]: https://github.com/NovaLux12/carelink-bridge/pull/22
[#23]: https://github.com/NovaLux12/carelink-bridge/pull/23
[#25]: https://github.com/NovaLux12/carelink-bridge/pull/25
[#12 round-1 comment]: https://github.com/NovaLux12/carelink-bridge/issues/12#issuecomment-5016844704
[#12 round-2 comment]: https://github.com/NovaLux12/carelink-bridge/issues/12#issuecomment-5016878393
[upstream PR #2]: https://github.com/domien-f/carelink-bridge/pull/2
