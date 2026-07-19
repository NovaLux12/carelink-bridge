# Deployment

This directory contains everything needed to run `carelink-bridge` as a long-lived service on a Linux host with systemd.

## What you need on the host

| Requirement | Why |
|---|---|
| Linux with systemd | We install a user-level systemd service |
| Node.js 20 or newer | The bridge's `engines.node` requirement |
| git | To clone the repo |
| `loginctl enable-linger $USER` | So the service survives your logout |
| Outbound HTTPS to `carelink.minimed.{eu,com}` | CareLink OAuth + data fetch |
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

The service loads `/home/jack/carelink-bridge/.env` (via `EnvironmentFile=`). The template is at `deploy/systemd/carelink-bridge.env.example`.

| Variable | Required | Notes |
|---|---|---|
| `CARELINK_USERNAME` | yes | CareLink email/username |
| `CARELINK_PASSWORD` | yes | CareLink password |
| `API_SECRET` | yes | Nightscout API secret (SHA-1 hashed by the bridge before sending) |
| `NS` | yes | Nightscout URL, including scheme. e.g. `https://nightscout.example.com` |
| `MMCONNECT_SERVER` | no | `EU` (default) or `US` |
| `MMCONNECT_COUNTRYCODE` | no | `gb` (default), `us`, `de`, etc. |
| `MMCONNECT_LANGCODE` | no | `en` (default) |
| `CARELINK_INTERVAL` | no | Fetch interval in seconds; `300` (5 min) default |
| `CARELINK_SGV_LIMIT` | no | SGV entries to upload per fetch; `24` default |
| `CARELINK_QUIET` | no | `true` (default) — set `false` for verbose logs |
| `CARELINK_PATIENT` | no | Only if your care-partner account has multiple patients |

### Login (`npm run login`)

CareLink uses OAuth2 with a browser-based flow for the initial login. The bridge tries three strategies in order:

1. **Automated** — POST credentials directly to Auth0. Works if you don't have CAPTCHA / MFA challenges.
2. **Browser window** — opens Chrome/Edge/Chromium via Puppeteer, you log in manually, the bridge intercepts the OAuth redirect. Works for CAPTCHA / MFA.
3. **Terminal paste fallback** — prints the Auth0 authorize URL, you open it in any browser, log in, copy the redirect URL with the `code=...` parameter, paste it back.

Run `npm run login` from the deploy directory. On success, `logindata.json` (gitignored) is written and the service can start. **The OAuth tokens in `logindata.json` are good for ~30 days; the bridge will refresh them automatically using the refresh token. If the refresh token also expires, you need to re-run `npm run login`.**

### Pre-flight check (`npm run doctor`)

Before `systemctl --user start`, run `npm run doctor` from the deploy directory. It confirms `.env` is complete, the login token is valid, and both CareLink and Nightscout are reachable with the right API secret — without fetching pump data. Especially worth running the first time a new pump is paired; it turns "why is no data showing up" into a specific, named failure. Exit code is non-zero if any check fails, so it can gate an automated deploy.

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

The bridge itself logs to stdout only when `CARELINK_QUIET=false`; otherwise it logs successful operations quietly and errors loudly.

### Updates

```bash
# Pull latest, rebuild, restart.
cd ~/carelink-bridge
bash deploy/install.sh            # git pull + npm ci + npm run build
systemctl --user restart carelink-bridge
```

For a major version (e.g. v0.2.0), check the release notes first — there may be `.env` additions or breaking config changes.

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

The bridge is a network client, not a server, so `RestrictAddressFamilies` is fine. If you ever add a `healthz` endpoint (v0.2.0 roadmap), it'll need to bind to a local port — you'll have to relax that.

## Security considerations

- **`logindata.json` contains OAuth tokens with full CareLink account access.** The systemd unit confines write access to the bridge directory (a per-file grant breaks token-file rotation — see issue #16). Treat it like a password.
- **`.env` contains your CareLink password AND Nightscout API secret.** Same handling.
- **The service makes outbound HTTPS to two endpoints**: CareLink (`*.minimed.{eu,com}`) and your Nightscout. There are no inbound network listeners.
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
