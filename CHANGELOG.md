# Changelog

All notable changes to this fork are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(0.x: minor = phase, patch = fixes within a phase).

Entries before v0.1.0 describe the upstream history this fork carries.
Written retroactively on 2026-07-19; dates are taken from the git/tag/release
record, not reconstructed.

## [Unreleased]

### Added

- **Atomic 0600 `logindata.json` write** — `writeLoginDataAtomic` in
  `src/carelink/token.ts` opens the temp file with `O_CREAT|O_EXCL|O_WRONLY`
  and `mode(0o600)`, fsyncs, then renames atomically. Closes the
  world-readable window between temp create and chmod that umask-022
  boxes had. `tightenLoginDataIfLoose` runs on the `loadLoginData` read
  path so an older bridge with a pre-existing 0644 file is closed
  without a one-shot migration step.

- **P0.1 mmol/L safety** — `src/transform/index.ts` detects
  `bgunits`/`bgUnits` of `MMOL_L` (with casing fallbacks) and converts
  `sg` to mg/dL at the SGV assignment site via
  `Math.round(sg * 18.0182)`. Without this, a mmol/L CareLink
  account flowing into Nightscout is interpreted as mg/dL by
  downstream looping clients (Loop, xDrip, AAPS) and over-delivers
  insulin. Asserted numerically: `5.5 mmol/L → 99 mg/dL`,
  `2.0 → 36`, `22.2 → 400`.

- **P0.2 lastAlarm policy** — `src/last-alarm.ts` plus
  `NightscoutLastAlarmAnnotation` in `src/types/nightscout.ts`. CareLink
  alarms surface as `devicestatus.last_alarm` with
  code/datetime/text/severity. Priority-1 codes (paradigm
  delivery-stopped 4/5/6/16/43/61) hit `console.warn` always-on,
  irrespective of verbose mode. **No alarm relay to Nightscout
  `/api/v1/treatments.json`** — verified by an absence-grep test over
  `src/`. NGP-tier codes are intentionally empty pending a
  sanitised 780G fixture.

- **forceRefresh successive-401 regression fix** — `authenticate()`
  now returns `Promise<boolean>` (true iff `refreshToken` actually
  ran). `fetch()` only clears `forceRefresh` when authenticate did NOT
  refresh. The pre-fix code re-sent a dead token across consecutive
  401s because the flag was unconditionally reset every iteration.
  The successive-401 test pins the fix: a 401 immediately after a
  successful refresh+401 still triggers a second `refreshToken`
  call.

- **P3 trend `NONE` → `{trend: 4, direction: 'Flat'}`** — matches
  Nightscout convention and every other CGM source's flat (xDrip,
  nightscout-connect). Tested against the real `missingLastSgv`
  fixture in `test/samples.ts` (with the trailing sg=0 entry
  dropped at the test site so the production guard for "trend
  attaches only when the most recent SG is real" is honoured).

- **`NoAuth0SSOConfigurationError` named class +
  `selectAuth0ConfigUrl` helper** — the named error is
  grep-distinguishable in journald. The helper throws it on missing
  `Auth0SSOConfiguration` in the discovery entry, carrying the
  diagnostic context (region, appVersion) for operators. The
  helper's behaviour is tested directly against a synthetic
  `DiscoveryCpEntry` shaped like the v3.4 / v4.0 no-Auth0 tracks.

- **Discovery pinning** — `DISCOVERY_APP_VERSION` and
  `buildDiscoveryUrl(isUS)` extracted into `src/discovery.ts`. The
  version string and the URL template
  (`/connect/carepartner/v13/discover/...`) are testable
  constants; a future contributor who edits either cannot
  silently regress the bridge to a no-Auth0 track (3.4 / 4.0).

- **Refresh-failure classification** — `isPermanentRefreshFailure`
  predicate in `src/refresh-failure.ts` distinguishes permanent
  (HTTP 400 + `invalid_grant` / `invalid_client`) from recoverable
  (5xx, 429, transport, anything not matching the OAuth contract).
  The catch in `authenticate()` is split: one try for
  `refreshToken` (classified), one for `writeLoginDataAtomic`
  (always retain + rethrow so a local disk failure doesn't nuke
  the token). 18-test suite covers the three behaviours plus
  defensive defaults (null, undefined, plain Error, etc.).

- **Status-aware capped exponential backoff with jitter, honour
  `Retry-After`** — `decideRetry` in `src/retry-policy.ts`
  classifies each failed attempt: permanent 4xx fail fast, 429
  honours `Retry-After` (numeric or HTTP-date) up to a cap, 5xx
  and transport errors retry with full-jitter exponential backoff
  (capped). The pre-fix fixed 2s/4s/8s path is replaced. The
  401/403 path is short-circuited before `decideRetry` so the
  existing force-refresh cycle still runs. Two integration
  tests pin the wiring: 429 + `Retry-After: 25` — advance 10s,
  assert no retry (the fixed 2s/4s/8s path would have retried
  here); advance 20s more, assert the retry fired. 404 — one
  call, not three.

### Changed

- The systemd unit now uses systemd's `%h` specifier instead of a hardcoded
  home-directory path, so it is portable across machines and accounts with no
  editing — install into `~/carelink-bridge` and it resolves to the running
  user's home. (This also removes the maintainer's own paths from the shipped
  artifacts.)

### Removed

- **`CARELINK_MAX_RETRY_DURATION` env, the `Config.maxRetryDuration`
  field, the `CareLinkClientOptions.maxRetryDuration` field, and
  the `DEFAULT_MAX_RETRY_DURATION` constant** — the option had no
  defined unit, the fetch loop never honoured it, and the fix-path
  is the status-aware policy in `src/retry-policy.ts`.

### Notes

- This is expected to be the last contribution in the current
  maintenance window. The 780G-payload-fixture items
  (`markers[]` for treatments, `therapyAlgorithmState` for auto-mode,
  `limits[]` schedule, multi-patient fan-out,
  `reservoirLevelPercent` snap-points, NGP-tier alarm codes) are
  deferred until a real pump arrives (currently expected November
  2026) or another operator contributes sanitised fixtures. Project
  maintenance continues passively — issue reports and security
  advisories are still monitored. The token-permission and
  atomic-write fixes shipped here provide the security baseline
  the deferred items will inherit; the discovery-pinning and
  named-error work provides the operational baseline.
- The PR references for the new items are intentionally left as
  plain bullets rather than `([#N])` because the GitHub PR/issue
  numbers are not yet assigned. When the PR is opened, replace
  the inline rationale with the assigned number to match the
  existing convention.

## [0.1.6] — 2026-07-19

### Added

- `npm run doctor` — a pre-flight self-check that validates `.env`
  completeness, decodes and reports the login token's validity/expiry,
  and confirms CareLink and Nightscout are reachable with an accepted
  `API_SECRET`, without fetching pump data. One request each to two hosts,
  safe to run repeatedly. Exit code is non-zero on failure so it can gate a
  deploy. First item of the v0.2.0 operability set ([#8]). ([#28])

### Changed

- The discovery app-version string (`android/3.6`) is now a documented,
  named constant in `src/login.ts`. Live probing showed Medtronic's discovery
  endpoint returns a different config per version — only 3.6/3.7 carry the
  Auth0 SSO config this flow needs, while 3.4 and 4.0 return no-Auth0 tracks —
  so a well-meaning "bump to a newer number" would silently break login. The
  no-SSO-URL error now names the version string as the likely cause. ([#27])

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

[Unreleased]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NovaLux12/carelink-bridge/releases/tag/v0.1.0
[#4]: https://github.com/NovaLux12/carelink-bridge/pull/4
[#6]: https://github.com/NovaLux12/carelink-bridge/pull/6
[#8]: https://github.com/NovaLux12/carelink-bridge/issues/8
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
[#27]: https://github.com/NovaLux12/carelink-bridge/pull/27
[#28]: https://github.com/NovaLux12/carelink-bridge/pull/28
[#12 round-1 comment]: https://github.com/NovaLux12/carelink-bridge/issues/12#issuecomment-5016844704
[#12 round-2 comment]: https://github.com/NovaLux12/carelink-bridge/issues/12#issuecomment-5016878393
[upstream PR #2]: https://github.com/domien-f/carelink-bridge/pull/2
