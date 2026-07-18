# Roadmap

This fork has a phased plan. Each phase is opt-in — don't ship phase N+1 until phase N is solid. PRs welcome against any phase.

## v0.1.0 — minimum viable fork
- [x] Fork from [domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge)
- [x] Cherry-pick [PR #2](https://github.com/domien-f/carelink-bridge/pull/2) (BLE device detection fix by @terminalcommand)
- [x] Add CI (vitest + tsc on Node 18/20/22)
- [x] Community fork README + ROADMAP + CONTRIBUTING + SECURITY

## v0.2.0 — operability (proposed)
- [ ] `carelink-bridge doctor` — config + connectivity check (env vars, CareLink reachable, Nightscout reachable, `logindata.json` valid)
- [ ] Healthcheck endpoints (`/healthz`, `/readyz`)
- [ ] Stale-data alert (>15 min no successful fetch → log + optional webhook)
- [ ] Better error messages on auth failures (especially expired refresh tokens)
- [ ] Graceful shutdown — finish in-flight upload on SIGTERM

## v0.3.0 — reliability (proposed)
- [ ] Exponential backoff with jitter on CareLink API errors
- [ ] Token refresh before expiry (not just on failure)
- [ ] Circuit breaker for CareLink (don't hammer if they're down)
- [ ] Persistent state file for last successful fetch time

## v0.4.0 — observability (proposed)
- [ ] Structured JSON logs (`--pretty` for human, JSON default)
- [ ] Prometheus metrics endpoint (`/metrics`)
- [ ] Request counter, error counter, `last_success_timestamp` gauge

## v0.5.0 — distribution (proposed)
- [ ] Single static binary (using `pkg` or `bun build`)
- [ ] Docker image with healthcheck
- [ ] systemd unit example
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