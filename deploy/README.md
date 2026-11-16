# Deployment

This directory contains everything needed to run `carelink-bridge` as a long-lived service on a Linux host with systemd.

## What you need on the host

| Requirement | Why |
|---|---|
| Linux with systemd | We install a user-level systemd service |
| Node.js **22.12** or newer, at **`/usr/bin/node`** | `package.json` declares `engines.node: ">=22.12.0"` (puppeteer-core@25 is a runtime dependency). The shipped unit hardcodes `ExecStart=/usr/bin/node`, so an nvm install at `~/.nvm/…` fails with `status=203/EXEC` — see [Login](#login-npm-run-login) |
| git | To clone the repo |
| `loginctl enable-linger $USER` | So the service survives your logout |
| Outbound HTTPS to `carelink.minimed.{eu,com}` | CareLink OAuth, discovery and the `/patient/*` metadata endpoints |
| Outbound HTTPS to `clcloud.minimed.{eu,com}` | The data path — `baseUrlCumulus` from the discovery document resolves here, and the legacy `patient/connect/data` endpoints are served by this host too (v11/v12/v13 all live here) |
| Outbound HTTPS to your Nightscout endpoint | Where the data lands |

User-level systemd service (not system-wide) because:
- The bridge handles medical data; running as your user keeps the security model consistent with the rest of your home-lab services.
- No `sudo` needed for `systemctl --user` operations.
- Each user on the box has independent services, which is the right isolation for a personal fork.

## Quick start

```bash
# 1. Clone + install + build + enable (does NOT start the service).
bash deploy/install.sh

# 2. Configure secrets.
cp ~/carelink-bridge/deploy/systemd/carelink-bridge.env.example ~/carelink-bridge/.env
nano ~/carelink-bridge/.env  # fill in CARELINK_USERNAME, CARELINK_PASSWORD, API_SECRET, NS
chmod 600 ~/carelink-bridge/.env

# 3. One-time OAuth login (interactive — opens a browser, you log in,
#    CareLink tokens land in logindata.json, browser closes itself).
cd ~/carelink-bridge && npm run login

# 4. Start the service.
systemctl --user start carelink-bridge
systemctl --user status carelink-bridge

# 5. Tail the logs.
journalctl --user -u carelink-bridge -f
```

## Step-by-step

### Install (`deploy/install.sh`)

The install script:
1. Enables `linger` for `$USER` (so the service keeps running after you log out).
2. Clones the repo into `~/carelink-bridge/` (or `git pull`s if it exists).
3. Runs `npm ci` + `npm run build`.
4. Symlinks the systemd unit into `~/.config/systemd/user/`.
5. `daemon-reload` + `enable` (NOT `start` — needs credentials first).

Re-running the script after a code update is safe: it does `git pull --ff-only`, rebuilds, and reloads the unit. To pick up the new build, do `systemctl --user restart carelink-bridge` after.

### Configuration (`.env`)

The service loads `~/carelink-bridge/.env` (via `EnvironmentFile=`; the unit uses systemd's `%h` specifier so it resolves to the home of whichever user runs it). The template is at `deploy/systemd/carelink-bridge.env.example`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CARELINK_USERNAME` | yes | — | CareLink email/username |
| `CARELINK_PASSWORD` | yes | — | CareLink password |
| `API_SECRET` | yes | — | Nightscout API secret (SHA-1 hashed by the bridge before sending) |
| `NS` | yes | — | Nightscout URL, including scheme. e.g. `https://nightscout.example.com` |
| `MMCONNECT_SERVER` | no | `EU` | `EU` or `US` — selects `carelink.minimed.eu` / `.com` for the metadata host |
| `MMCONNECT_SERVERNAME` | no | blank | Pins the CareLink hostname explicitly instead of the EU/US default (trimmed and lowercased). Leave blank unless you need it — e.g. a reverse proxy |
| `MMCONNECT_COUNTRYCODE` | no | `gb` | `gb`, `us`, `de`, etc. |
| `MMCONNECT_LANGCODE` | no | `en` | |
| `CARELINK_INTERVAL` | no | `300` | Fetch interval in **seconds** (5 min) |
| `CARELINK_SGV_LIMIT` | no | `24` | SGV entries to upload per fetch |
| `CARELINK_QUIET` | no | `true` | `false` turns on `info`-level logs. **Warnings and errors are logged either way** — see [Logs](#logs) |
| `LOG_FORMAT` | no | `pretty` | `pretty` or `json` (one JSON object per line, for Loki / `journalctl -o json`). Anything other than `json` falls back to `pretty` |
| `CARELINK_PATIENT` | no | blank | Only if your care-partner account has multiple patients |
| `CARELINK_STALE_THRESHOLD_MINUTES` | no | `15` | Minutes without a successful fetch before a `STALE` warning is logged (one-shot per stale period) |
| `STALE_WEBHOOK_URL` | no | blank | If set, POSTs JSON `{bridge, since, threshold_ms}` when the bridge goes stale |
| `CARELINK_STATE_FILE` | no | `<dir of logindata.json>/state.json` | Persistent state (last success, consecutive failures, circuit state), written mode `0600`; survives restarts |
| `CARELINK_CIRCUIT_THRESHOLD` | no | `5` | Consecutive failed fetches before the circuit breaker opens |
| `CARELINK_CIRCUIT_COOLDOWN_S` | no | `60` | Seconds the circuit stays open |
| `CARELINK_METRICS_PORT` | no | `0` | `0` = disabled (no listener). A non-zero port starts the **loopback-only** `/healthz` + `/metrics` server on `127.0.0.1` |
| `CARELINK_DATA_PATH` | no | `auto` | Which data route to use: `auto` (display/message, then the legacy chain), `cumulus` (display/message only), `legacy` (never call display/message — pre-v0.3 behaviour) |
| `CARELINK_APP_VERSION` | no | `3.8.0` | `appVersion` sent in the display/message request body. Must be ≥ `3.7`; older values get `206 Upgrade application` and no data. Overridable because it is a server-side gate that can move |
| `CARELINK_ASSUME_TIMEZONE` | no | blank (falls back to UTC) | IANA zone (e.g. `Europe/London`) used when CareLink sends a timestamp with no `clientTimeZoneName`. Without it such readings are read as UTC and every value is offset |

Values verified against `src/config.ts`, `src/carelink/client.ts`,
`src/carelink/cumulus.ts`, `src/transform/index.ts` and
`deploy/systemd/carelink-bridge.env.example`. `CARELINK_PATIENT` and the
tuning knobs are read with a case-insensitive lookup, so lower-case
spellings work too — the documented style is upper case.

**That "verified against `carelink-bridge.env.example`" claim was false when it
was written** (corrected 2026-11-14). The template was missing
`CARELINK_DATA_PATH`, `CARELINK_APP_VERSION`, `CARELINK_ASSUME_TIMEZONE`,
`CARELINK_STALE_THRESHOLD_MINUTES` and `STALE_WEBHOOK_URL`; it has them now, and
`.env.example` gained the same entries so the two templates no longer disagree.
The one that mattered is `CARELINK_ASSUME_TIMEZONE`: without it an unzoned
reading is interpreted as UTC, so a UK user in BST has every value shifted an
hour — and the warning that says so goes through `logger.log()`, which is
invisible at the default `CARELINK_QUIET=true`. There is no signal.

`WEBSITE_HOSTNAME` is also read, as a fallback Nightscout host when `NS`
is unset; that is an Azure App Service convention, not something to set
on a systemd host.

### Login (`npm run login`)

CareLink uses OAuth2 with a browser-based flow for the initial login. The bridge tries three strategies in order:

1. **Automated** — POST credentials directly to Auth0. Works if you don't have CAPTCHA / MFA challenges.
2. **Browser window** — opens Chrome/Edge/Chromium via Puppeteer, you log in manually, the bridge intercepts the OAuth redirect. Works for CAPTCHA / MFA.
3. **Terminal paste fallback** — prints the Auth0 authorize URL, you open it in any browser, log in, copy the redirect URL with the `code=...` parameter, paste it back.

Run `npm run login` from `~/carelink-bridge` — **not** from `deploy/`. There is
no `package.json` in `deploy/`, so the command does not exist there. (This page
said "from the deploy directory" until 2026-11-14; `install.sh` and the
Dockerfile both run it from the repo root, which is where the script lives.)

```bash
cd ~/carelink-bridge && npm run login
```

On success, `logindata.json` (gitignored) is written and the service can start. **The bridge refreshes the OAuth tokens automatically using the refresh token; you only need to re-run `npm run login` if the refresh token itself dies (revoked, or a permanent 4xx).** Token lifetime is whatever the JWT `exp` claim says, not a fixed number — and whether a refresh token survives ~30 days of continuous uptime is untested (it is an open question in `docs/validation-day-instinct.md`), so do not plan around a 30-day figure.

**You must log in before you start the service.** With no `logindata.json`,
`dist/main.js` does not exit with a message — it enters the login flow, and
strategy 3 blocks on a `readline` prompt. Under systemd stdin is not a TTY, so
that promise never settles: node prints `Detected unsettled top-level await` and
**exits 13**, and the unit retries it `StartLimitBurst=5` times before giving
up. The journal then says nothing about the missing login, only the crash and
`start request repeated too quickly`. If you hit that, the fix is
`cd ~/carelink-bridge && npm run login`, then `systemctl --user start`.

### Pre-flight check (`npm run doctor`)

Before `systemctl --user start`, run `npm run doctor` from `~/carelink-bridge`
(again, no `package.json` in `deploy/`). It confirms `.env` is complete, reports
the login token's state, and checks that both CareLink and Nightscout are
reachable with the right API secret — without fetching pump data. Especially
worth running the first time a new pump is paired; it turns "why is no data
showing up" into a specific, named failure.

**It is not a deploy gate, and it does not prove the bridge can fetch.** Three
limits that matter when you read a green result:

- **Exit code.** Non-zero only for `✗` rows. A missing `logindata.json` is a `!`
  warning and exits **0** — so the check most likely to be wrong before a first
  start does not fail the command. Do not wire it into a gate that assumes a
  zero exit means "logged in".
- **No login attempt.** It reads and decodes the stored token; it never posts
  credentials, so an MFA/CAPTCHA wall is invisible to it.
- **No data call.** It probes the discovery document only. It cannot
  distinguish `204`, `206 Upgrade application`, or a legacy backend answering
  `200` with stale records, and it does not touch the cumulus data track that
  the fetch actually uses.

One behaviour worth knowing, because it looks like a failure and is not:
`/api/v1/status.json` is **not public** on a default Nightscout. With
`AUTH_DEFAULT_ROLES=denied` (the standard setting) an unauthenticated request
gets `401`, so doctor sends the `api-secret` header on the reachability probe
too. A `✓ Nightscout reachable` line reading `answered HTTP 401 — reachable,
but it rejected the API secret` means the host is up and doing the right thing;
the row beneath it is the one that decides whether the secret is right.
(Before 2026-11-15 doctor probed status.json unauthenticated, called that
healthy server `✗ unreachable`, and returned before ever checking the secret.)

It also reports which discovery pin it probed: the URL is built from
`DISCOVERY_APP_VERSION` via `buildDiscoveryUrl()`, the same call login uses, so
moving the pin moves both. (Before 2026-11-15 it hardcoded `android/3.6`, so a
moved pin changed what login probed and not what doctor probed — issue #145.)

### Start the service

```bash
systemctl --user start carelink-bridge
systemctl --user status carelink-bridge
```

### Logs

```bash
# Live tail.
journalctl --user -u carelink-bridge -f

# Last hour.
journalctl --user -u carelink-bridge --since "1 hour ago"

# All-time, no follow.
journalctl --user -u carelink-bridge --no-pager
```

The bridge logs `warn` and `error` lines **always** — `CARELINK_QUIET`
does not silence them, which is deliberate: the safety-relevant events
(stale data, circuit breaker opening, auth failures) have to reach
journald on a default install. `CARELINK_QUIET=false` (i.e.
`verbose: true`) additionally enables `info`-level lines about
successful operations. `LOG_FORMAT=json` switches both to one JSON
object per line.

### Updates

```bash
# Pull latest, rebuild, restart.
cd ~/carelink-bridge
bash deploy/install.sh            # git pull + npm ci + npm run build
systemctl --user restart carelink-bridge
```

For a major version (e.g. v0.2.0), check the release notes first — there may be `.env` additions or breaking config changes.

### Docker (alternative to systemd)

The repo root ships a multi-stage `Dockerfile` (`node:22-bookworm-slim`,
small runtime image, runs as `USER node`). The bridge is also wired in as
a sibling service in `deploy/nightscout-docker-compose.yml`.

**Inside the image, use the `:dist` scripts.** The runtime stage runs
`npm ci --omit=dev`, and `npm run doctor` / `npm run login` are `tsx …` with
`tsx` a devDependency — so inside the container they fail with
`sh: 1: tsx: not found` (verified against a built image, and against the
published GHCR image, 2026-11-15). `dist/` is compiled in the build stage, so
the compiled entrypoints are present; use these instead:

```bash
docker exec carelink-bridge npm run doctor:dist
docker exec carelink-bridge npm run login:dist
```

`doctor:dist` is the same pre-flight with the same exit codes, and needs no
`tsx`. `login:dist` runs the same three login strategies, but the image has no
browser (and `puppeteer-core` does not download one), so Strategy 2 is
unavailable there and it falls back to the terminal paste flow — which needs an
interactive TTY and is therefore awkward through `docker exec`. **For a first
login, run it on the host** and `docker cp` the resulting `logindata.json` in;
use `login:dist` only for the re-login case where you are already attached to
the container with a TTY.

**Do not bind-mount `logindata.json` at all — not `:ro`, not `:rw`.** Token
refresh rewrites the file atomically: `writeLoginDataAtomic` writes
`logindata.json.tmp` and `rename`s it over the destination. A `rename` onto a
bind-mounted *file* fails with **`EBUSY`** either way, and the bridge
deliberately rethrows that errno rather than deleting the file — so once the
access token expires, every fetch fails with a bare `EBUSY` and the container
never re-logins. Both this page and `deploy/nightscout-docker-compose.yml`
mounted it `:ro`; both are now fixed — the compose file leaves the token out
of the image entirely and the `docker cp` step below is the write path.
Verified against a built image (2026-11-14): `writeLoginDataAtomic('/app/logindata.json')`
→ `EBUSY` on both a `:ro` and an `:rw` file mount; `unlinkSync` on the `:ro`
mount → `EBUSY` too, so even the delete-then-re-login path fails.

The token path is fixed at `/app/logindata.json` (it is not configurable), so
the arrangement that works is to put the file in the container's own writable
filesystem and re-place it after each host-side login:

```bash
# 1. Log in ON THE HOST — the image cannot do this well (no browser, and the
#    paste fallback needs a TTY). Use the compiled entrypoint if you cloned the
#    repo and built it: `npm run login` (tsx) works from source, `npm run
#    login:dist` (node) works from a build.
cd ~/carelink-bridge
npm run doctor          # host only
npm run login           # host only; writes ~/carelink-bridge/logindata.json

# 2a. Standalone container. Persist state in a volume (see below).
#     Either pull the published image (multi-arch: amd64 + arm64, so this works
#     on a Raspberry Pi). Pin a version rather than `latest` if the deployment
#     matters to you: `latest` follows the newest tag, but a manual workflow
#     dispatch also overwrites it with an unversioned build of `main`.…
docker pull ghcr.io/novalux12/carelink-bridge:0.4.2
docker run -d --name carelink-bridge --env-file .env \
  -e CARELINK_STATE_FILE=/data/state.json -v carelink-data:/data \
  ghcr.io/novalux12/carelink-bridge:0.4.2
#     …or build it locally if you want to run a commit that has no release.
# docker build -t carelink-bridge .
# docker run -d --name carelink-bridge --env-file .env \
#   -e CARELINK_STATE_FILE=/data/state.json -v carelink-data:/data \
#   carelink-bridge
docker cp logindata.json carelink-bridge:/app/logindata.json
docker restart carelink-bridge

# 2b. Or as part of the Nightscout stack (same steps after `up`).
cd deploy && docker compose up -d --build carelink-bridge
```

**`CARELINK_STATE_FILE` must point into a mounted directory**, not at a mounted
file, for the same atomic-write reason — `/data/state.json` under the
`carelink-data` volume is a real directory, so the `rename` succeeds. Without
it, `state.json` lands in `/app` and is lost when the container is recreated.

**Re-login procedure**, which is the normal recovery path for a Docker
deployment (the refresh token can be revoked at any time, e.g. by logging into
the CareLink phone app):

```bash
cd ~/carelink-bridge
npm run login                                  # host; refuses if logindata.json already exists
docker cp logindata.json carelink-bridge:/app/logindata.json
docker restart carelink-bridge
```

`npm run login` exits early with `logindata.json already exists` if the file is
still there — delete the host copy first if you are deliberately re-logging in.
The `docker cp` above is the write path that is verified working: a `docker cp`
into the running container followed by a refresh writes fine, because `/app` is
a normal writable directory in the image (it is `chown`ed to `node`).


Health: the image sets `CARELINK_METRICS_PORT=8081` by default so the
container-level `HEALTHCHECK` can probe the loopback-only `/healthz`
(bound to the container's own `127.0.0.1` — no port publishing needed).
`docker ps` shows `unhealthy` when the bridge process dies. Override with
`--env CARELINK_METRICS_PORT=0` to run headless (healthcheck will report
unhealthy — it has nothing to probe).

### Single-file bundle (`npm run bundle`)

If you would rather copy one file than clone a repo, build the bundle:

```bash
npm ci
npm run bundle            # writes dist-bundle/carelink-bridge.mjs (~3 MB)
```

The output contains the whole program, puppeteer included, and carries the same
three commands as the source build:

```bash
node dist-bundle/carelink-bridge.mjs            # run the bridge
node dist-bundle/carelink-bridge.mjs doctor     # pre-flight self-check
node dist-bundle/carelink-bridge.mjs login      # interactive CareLink login
```

`--help` lists them.

**It is a bundle, not a static binary.** `node:` builtins still come from the
host, so **Node ≥ 22.12 is still required** — nothing is embedded (see
[ADR 0009](../docs/adr/0009-bundling-spike-results.md)). Two further limits:

- **Chromium is not included**, and cannot be: `puppeteer-core` never downloads
  a browser. On a host with no Chrome/Edge/Chromium, `login` falls back to the
  terminal-paste strategy, which is what it would do from source too.
- **`logindata.json` and `state.json` live next to the bundle** — the same
  directory the `.mjs` is in. Keep the bundle somewhere writable.

The build executes its own output before reporting success, including a
`doctor` run, so a bundle that is missing a subcommand fails the build rather
than the first attempt to diagnose something.

## Hardening

The systemd unit ships with defence-in-depth settings:

| Setting | Effect |
|---|---|
| `NoNewPrivileges=true` | The service can't escalate privileges |
| `PrivateTmp=true` | `/tmp` is private to the service |
| `ProtectSystem=strict` | The filesystem is read-only except where explicitly allowed |
| `ProtectHome=read-only` | `~` is read-only; the only writable path is the bridge directory itself (needed so token refresh can rewrite — and expiry can delete — `logindata.json`) |
| `RestrictAddressFamilies=AF_INET AF_INET6` | Only IPv4 + IPv6 sockets — no Unix domain sockets |
| `SystemCallArchitectures=native` | No `x86_64` emulation if you're on a non-x86 host |

The bridge is a network client, not a server, so `RestrictAddressFamilies` is fine. The opt-in observability server (`CARELINK_METRICS_PORT`, loopback-only `/healthz` + `/metrics`) binds a local port, which `AF_INET`/`AF_INET6` already permit — no unit change needed.

## Security considerations

- **`logindata.json` contains OAuth tokens with full CareLink account access.** The systemd unit confines write access to the bridge directory (a per-file grant breaks token-file rotation — see issue #16). Treat it like a password.
- **`.env` contains your CareLink password AND Nightscout API secret.** Same handling.
- **The service makes outbound HTTPS to two host families**: CareLink
  (`carelink.minimed.{eu,com}` — OAuth, discovery, `/patient/*` metadata)
  and the data plane (`clcloud.minimed.{eu,com}` — the `baseUrlCumulus`
  target for `display/message`, plus the legacy `connect/data` endpoints),
  and to your Nightscout. There is no inbound listener unless you opt in:
  `CARELINK_METRICS_PORT=0` (the default) opens no port at all, and a
  non-zero value binds the observability server to loopback only.
- **The bridge is not FDA-approved** and may violate Medtronic's Terms of Service. Using it is at your own risk. See `SECURITY.md` for the full threat model.

## Disabling / removing

```bash
# Stop and disable (won't auto-start on next login).
systemctl --user stop carelink-bridge
systemctl --user disable carelink-bridge

# Remove the unit symlink.
rm ~/.config/systemd/user/carelink-bridge.service
systemctl --user daemon-reload

# Optionally remove the deployment directory.
rm -rf ~/carelink-bridge
```
