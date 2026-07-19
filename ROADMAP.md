# Roadmap

This fork has a phased plan. Each phase is opt-in — don't ship phase N+1 until phase N is solid. PRs welcome against any phase.

**Phase status (2026-07-19):** v0.1.0 through v0.1.2 shipped. v0.1.3 (deployment artifacts) shipped as PR ahead of pump arrival. v0.2.0+ blocked on real-data validation against the operator's actual 780G.

## v0.1.0 — minimum viable fork
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

## v0.1.2 — supply-chain reduction (shipped 2026-07-19)
- [x] Removed proxy code path (now dead after v0.1.1 `USE_PROXY=false` default). -146/+18 lines, 2 fewer direct deps.
- [x] Documented `HTTPS_PROXY` env var as the standard proxy mechanism (axios respects it natively).

## v0.1.3 — deployment artifacts (shipped 2026-07-19, ahead of v0.2.0)
- [x] `deploy/systemd/carelink-bridge.service` — user-level systemd unit with hardening (`NoNewPrivileges`, `ProtectSystem=strict`, etc.)
- [x] `deploy/systemd/carelink-bridge.env.example` — env file template
- [x] `deploy/install.sh` — idempotent first-time install + updates
- [x] `deploy/README.md` — full deployment runbook
- [x] `deploy/nightscout-docker-compose.yml` — Nightscout + mongo + cloudflared stack (deployment requires Cloudflare tunnel credentials from operator)

**Why v0.1.3 jumped the queue:** the operator's 780G pump arrives within ~2 weeks. Deployment prep needs to happen before pump arrival so the bridge can be live within an hour of first data. Real-data validation against the live CareLink account is still pending; nothing in v0.1.3 changes runtime behaviour.

## v0.2.0 — operability (proposed, blocked on real-data validation)
- [ ] `carelink-bridge doctor` — config + connectivity check (env vars, CareLink reachable, Nightscout reachable, `logindata.json` valid)
- [ ] Healthcheck endpoints (`/healthz`, `/readyz`) — will need to relax `RestrictAddressFamilies` on the systemd unit to allow binding to a local port
- [ ] Stale-data alert (>15 min no successful fetch → log + optional webhook)
- [ ] Better error messages on auth failures (especially expired refresh tokens)
- [ ] Graceful shutdown — finish in-flight upload on SIGTERM

## v0.3.0 — reliability (proposed)
- [ ] Exponential backoff with jitter on CareLink API errors (basic exp backoff already exists in `fetch()`, but no jitter yet)
- [ ] Token refresh before expiry (not just on failure) — currently only refreshes on demand
- [ ] Circuit breaker for CareLink (don't hammer if they're down)
- [ ] Persistent state file for last successful fetch time

## v0.4.0 — observability (proposed)
- [ ] Structured JSON logs (`--pretty` for human, JSON default)
- [ ] Prometheus metrics endpoint (`/metrics`)
- [ ] Request counter, error counter, `last_success_timestamp` gauge

## v0.5.0 — distribution (proposed, partially shipped in v0.1.3)
- [x] systemd unit example — shipped in v0.1.3
- [ ] Single static binary (using `pkg` or `bun build`)
- [ ] Docker image of the bridge itself (Nightscout docker-compose shipped in v0.1.3)
- [ ] Home Assistant add-on (low priority)

## v0.6.0+ — advanced features (proposed, low priority)
- [ ] Multi-account / caregiver mode
- [ ] Alarms relay (low BG → Nightscout event)
- [ ] Mock CareLink server for testing
- [ ] Library split (`carelink-client` + `nightscout-uploader` + daemon)

## Out of scope (explicitly)
- Closed-loop insulin dosing — this is a data bridge only
- Features that replace official CareLink safety notifications
- Reformatting/refactoring with no behaviour change

## Upstream relationship

This fork only carries fixes that landed in or were submitted upstream. No silent private changes. If upstream becomes active, this fork folds back. We're not trying to replace it — we're trying to keep it alive.

Deployment artifacts (v0.1.3) are a deliberate divergence from upstream — the upstream repo doesn't ship a deploy guide. If upstream becomes active and wants them, they're easy to extract into a separate repo or PR.