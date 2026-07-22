# Roadmap

This fork has a phased plan. Each phase is opt-in — don't ship
phase N+1 until phase N is solid. PRs welcome against any
phase. Read this document if you want to know **what's coming,
why, and what it's blocked on**.

## How to read this document

Each phase below has the same shape:

1. **Goal** — what the phase is for.
2. **Status** — shipped, in progress, or blocked.
3. **What's in it** — the bullet list.
4. **Why this exists** — the rationale. This is the most
   important section: future maintainers who don't have
   today's context need to know what forces shaped the
   decision.
5. **What unblocks it** — the explicit gate. A phase marked
   "blocked" should name the specific thing that's missing.
6. **Tracking** — the GitHub issue and any workboard card.

## Phase status (2026-07-22)

| Phase | Status | Notes |
|-------|--------|-------|
| v0.1.0 | Shipped 2026-07-18 | Minimum viable fork |
| v0.1.1 | Shipped 2026-07-19 | Post-release hygiene |
| v0.1.2 | Shipped 2026-07-19 | Supply-chain reduction |
| v0.1.3 | Shipped 2026-07-19 | Deployment artifacts |
| v0.1.4 | Shipped 2026-07-19 | Auth retry reliability |
| v0.1.5 | Shipped 2026-07-19 | Username source fix |
| v0.1.6 | Shipped 2026-07-19 | `npm run doctor` |
| v0.2.0 | Shipped 2026-07-22 | Safety + reliability hardening |
| v0.3.0 | Proposed, blocked | Reliability improvements |
| v0.4.0 | Proposed, blocked | Observability |
| v0.5.0 | Partially shipped | Distribution (systemd done; docker, single-binary, HASS pending) |
| v0.6.0+ | Proposed, low priority | Advanced features |

---

## v0.1.0 — minimum viable fork

**Goal:** pick up the bridge while the upstream maintainer is
quiet and fix the one known broken case.

- [x] Fork from [domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge)
- [x] Cherry-pick [PR #2](https://github.com/domien-f/carelink-bridge/pull/2) (BLE device detection fix by @terminalcommand)
- [x] Add CI (vitest + tsc on Node 20/22)
- [x] Community fork README + ROADMAP + CONTRIBUTING + SECURITY

## v0.1.1 — post-release hygiene (shipped 2026-07-19)

- [x] Default `USE_PROXY` to `false`; remove undocumented `my.env` lookups; clarify `SECURITY.md` contact
- [x] `package.json` version 2.0.0 → 0.1.0 (match tag); README Acknowledgements credit terminalcommand + nraverdy
- [x] Regression test for cherry-picked BLE device detection fix
- [x] Drop Node 18 (EOL April 2025); bump vitest to ^4 (kills 5 transitive dev CVEs)
- [x] Issues enabled; Dependabot security updates enabled; branch protection on `main`

**Why this exists:** a fork can only carry its own weight if
its own house is in order. Five things were broken or fragile
in the inherited state; this phase fixed them all together
because the test of "is this fork actually safe to use" is
the conjunction of those things, not any one of them.

## v0.1.2 — supply-chain reduction (shipped 2026-07-19)

- [x] Removed proxy code path (now dead after v0.1.1 `USE_PROXY=false` default). -146/+18 lines, 2 fewer direct deps.
- [x] Documented `HTTPS_PROXY` env var as the standard proxy mechanism (axios respects it natively).

See [ADR 0004](./docs/adr/0004-no-fork-specific-proxy-code.md)
for the full rationale.

## v0.1.3 — deployment artifacts (shipped 2026-07-19)

- [x] `deploy/systemd/carelink-bridge.service` — user-level systemd unit with hardening
- [x] `deploy/systemd/carelink-bridge.env.example` — env file template
- [x] `deploy/install.sh` — idempotent first-time install + updates
- [x] `deploy/README.md` — full deployment runbook
- [x] `deploy/nightscout-docker-compose.yml` — Nightscout + mongo + cloudflared stack

**Why this phase jumped the queue:** the maintainer's 780G
pump is expected in November 2026. Deployment prep was
shipped early so the bridge can be live within an hour of
first data once the pump arrives. Real-data validation
against the live CareLink account is still pending; nothing
in v0.1.3 changes runtime behaviour.

## v0.1.4 — auth retry reliability (shipped 2026-07-19)

- [x] 401/403 from CareLink now forces a token refresh on the next retry.
- [x] Token expiry margin widened from 60s to 600s, matching the `carelink-python-client` reference.
- [x] Carepartner data-endpoint fallbacks are now a known-version list (13, 11, 6, 5) instead of a hardcoded v5/v6 chain.

**Why this exists:** a token invalidated mid-lifetime (most
commonly by the CareLink phone app logging into the same
account) was previously retried until natural expiry. Widening
the expiry margin closes the "token passes the check, expires
mid-fetch" window. The known-version list degrades sanely
when Medtronic ships a new cumulus version.

## v0.1.5 — username source fix (shipped 2026-07-19)

- [x] Data POST bodies now use the username CareLink reports from `/patient/users/me` instead of `CARELINK_USERNAME` verbatim.

**Why this exists:** operators who enter their email while
their CareLink username differs were sending the wrong
identifier on every data request. The bridge now prefers
the server-reported username, falling back to the configured
value, the same source `nightscout-connect` and
`carelink-python-client` use.

## v0.1.6 — `npm run doctor` (shipped 2026-07-19)

- [x] `npm run doctor` — pre-flight self-check (env vars, CareLink reachable, Nightscout reachable, login token valid)
- [x] Discovery app-version string is now a documented constant in `src/discovery.ts`

**Why this exists:** "why is no data showing up" used to
require reading logs and guessing. `npm run doctor` turns
that into a specific, named failure in one command. Exit
code is non-zero on failure so it can gate a deploy.

## v0.2.0 — safety + reliability hardening (shipped 2026-07-22)

- [x] Atomic 0600 `logindata.json` write — closes the world-readable window the previous `writeFileSync` + `chmod` path left open. See [ADR 0003](./docs/adr/0003-atomic-token-write.md).
- [x] mmol/L safety — a mmol/L CareLink account is now converted to mg/dL at the SGV assignment site. Without this, downstream looping clients (Loop, xDrip, AAPS) over-deliver insulin.
- [x] Last-alarm policy — `src/last-alarm.ts` surfaces CareLink alarms as `devicestatus.last_alarm`; priority-1 codes hit `console.warn` always-on. **No alarm relay to Nightscout `/api/v1/treatments.json`.**
- [x] `forceRefresh` successive-401 regression fix — `authenticate()` returns `Promise<boolean>`; the flag stays set across consecutive 401s.
- [x] `NoAuth0SSOConfigurationError` named class + `selectAuth0ConfigUrl` helper.
- [x] Discovery pinning — `DISCOVERY_APP_VERSION` and `buildDiscoveryUrl` extracted into `src/discovery.ts`. See [ADR 0002](./docs/adr/0002-discovery-app-version-pin.md).
- [x] Refresh-failure classification — `isPermanentRefreshFailure` predicate; the token file is only deleted on a permanent Auth0 failure, not on transport / 5xx / 429 / local-disk errors.
- [x] Status-aware capped exponential backoff with jitter, honour `Retry-After` — see [ADR 0001](./docs/adr/0001-status-aware-retry-policy.md).
- [x] Removed `CARELINK_MAX_RETRY_DURATION` env and the related Config / options field / default — the option had no defined unit, the fetch loop never honoured it, and the new retry policy supersedes it.

**Why this exists:** v0.1.x was "make it work." v0.2.0 is
"make it not silently hurt someone." The mmol/L conversion
is the load-bearing safety item — a non-US CareLink account
flowing into Nightscout as if it were mg/dL causes
over-bolus. Everything else in the phase is correctness,
observability, and attack-surface reduction.

**Maintenance note:** this is the last contribution in the
current maintenance window. The 780G-payload-fixture items
(`markers[]` for treatments, `therapyAlgorithmState` for
auto-mode, `limits[]` schedule, multi-patient fan-out,
`reservoirLevelPercent` snap-points, NGP-tier alarm codes)
are deferred until a real pump arrives (currently expected
November 2026) or another operator contributes sanitised
fixtures. The token-permission and atomic-write fixes
shipped here provide the security baseline the deferred
items will inherit; the discovery-pinning and named-error
work provides the operational baseline.

## v0.3.0 — reliability (proposed)

**Goal:** make the bridge more resilient to CareLink's
uptime and rate-limiting without operator intervention.

- [ ] Circuit breaker for CareLink (don't hammer if they're down)
- [ ] Persistent state file for last successful fetch time
- [ ] Token refresh before expiry (not just on failure)

**What unblocks it:** v0.2.0 has shipped, and the
`decideRetry` policy from v0.2.0 gives us the building
block for a circuit breaker. Real-data validation against
a 780G would also let us verify the persistent state file
isn't clobbered by token refresh races.

**Tracking:** [GitHub issue #9](https://github.com/NovaLux12/carelink-bridge/issues/9)

## v0.4.0 — observability (proposed)

**Goal:** make the bridge debuggable from logs and metrics,
not just from `console.log` scraping.

- [ ] Structured JSON logs (`--pretty` for human, JSON default)
- [ ] Prometheus metrics endpoint (`/metrics`)
- [ ] Request counter, error counter, `last_success_timestamp` gauge

**What unblocks it:** v0.2.0's `decideRetry` returns
structured reasons (`'permanent-status'`, `'rate-limited'`,
`'server-5xx'`, `'transport'`) that map cleanly to a
`reason` label on a metrics counter. The `/metrics` endpoint
needs to relax the systemd unit's `RestrictAddressFamilies`
(only IPv4 / IPv6) — that's a one-line change once the
endpoint exists.

**Tracking:** [GitHub issue #10](https://github.com/NovaLux12/carelink-bridge/issues/10)

## v0.5.0 — distribution (partially shipped)

**Goal:** make the bridge easy to install on a wider variety
of hosts, beyond the current `git clone` + systemd path.

- [x] systemd unit example — shipped in v0.1.3
- [ ] Single static binary (using `pkg` or `bun build`)
- [ ] Docker image of the bridge itself (Nightscout docker-compose shipped in v0.1.3)
- [ ] Home Assistant add-on (low priority)

**What unblocks the single-binary work:** confirming
`puppeteer-core` (login Strategy 2) works under the chosen
bundler. If the bundler can't include a chromium download
mechanism, Strategy 2 may need to be split into a separate
package, or the bridge moves to headless-only login (in
which case `puppeteer-core` drops from the dependency list —
see [ADR 0005](./docs/adr/0005-dependency-minimalism.md)).

**Tracking:** [GitHub issue #11](https://github.com/NovaLux12/carelink-bridge/issues/11)

## v0.6.0+ — advanced features (proposed, low priority)

- [ ] Multi-account / caregiver mode
- [ ] Alarms relay (low BG → Nightscout event)
- [ ] Mock CareLink server for testing
- [ ] Library split (`carelink-client` + `nightscout-uploader` + daemon)

**Why this is gated:** the library split depends on the
API surface settling (v0.2.0's retry / refresh changes are
the last big rework). The mock CareLink server depends on
either real-data fixtures (deferred to pump arrival) or
hand-rolled fixtures (significant work). Multi-account is
a feature request from one user; not blocking, not
prioritised.

## Out of scope (explicitly)

- **Closed-loop insulin dosing** — this is a data bridge
  only. The maintainer is an autonomous AI agent, not a
  medical professional. Looping logic has its own dedicated
  projects (Loop, AAPS, OpenAPS) with their own regulatory
  and review posture.
- **Features that replace official CareLink safety
  notifications.** The bridge's last-alarm policy surfaces
  CareLink's existing alarms into Nightscout. Adding new
  alarm sources or override semantics would cross the line
  into a notification system, which is a different scope.
- **Reformatting / refactoring with no behaviour change.**
  These PRs are not accepted — they make `git blame` and
  bisect harder for no functional benefit. If a refactor is
  needed for an upcoming change, it ships in the same PR as
  the change.

## Tracking

Active open work, cross-referenced from issues:

| Item | Issue | Status |
|------|-------|--------|
| Pre-pump operator checklist | [#7](https://github.com/NovaLux12/carelink-bridge/issues/7) | open |
| v0.3.0 reliability | [#9](https://github.com/NovaLux12/carelink-bridge/issues/9) | proposed |
| v0.4.0 observability | [#10](https://github.com/NovaLux12/carelink-bridge/issues/10) | proposed |
| v0.5.0 distribution (remaining) | [#11](https://github.com/NovaLux12/carelink-bridge/issues/11) | proposed |
| Real-data discoveries tracker | [#12](https://github.com/NovaLux12/carelink-bridge/issues/12) | monitoring after pump arrival |
| Low-priority repo hygiene | [#13](https://github.com/NovaLux12/carelink-bridge/issues/13) | backlog |

## Upstream relationship

This fork only carries fixes that landed in or were
submitted upstream. No silent private changes. If upstream
becomes active, this fork folds back. We're not trying to
replace it — we're trying to keep it alive.

Deployment artifacts (v0.1.3) are a deliberate divergence
from upstream — the upstream repo doesn't ship a deploy
guide. If upstream becomes active and wants them, they're
easy to extract into a separate repo or PR.
