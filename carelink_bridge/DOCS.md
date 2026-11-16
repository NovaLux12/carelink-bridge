# CareLink Bridge — Home Assistant app

Bridges Medtronic CareLink pump and CGM data to Nightscout.

---

## Read this first: who this app is for

**This app requires Home Assistant OS or a Home Assistant Supervised install.**

The app store, `repository.yaml`, `config.yaml` and everything that installs
this app are features of the **Supervisor**. A plain Home Assistant *Container*
install (`docker run homeassistant/home-assistant` — no `hassio_supervisor`
container, no `/mnt/data/supervisor`) has no Supervisor and therefore **cannot
run Home Assistant apps at all**. Adding this repository to such an install is
not possible; there is nothing to add it to.

| Your install | Can you use this? | What to do instead |
|---|---|---|
| Home Assistant OS | Yes, in principle | Add this repository (below) |
| Home Assistant Supervised | Yes, in principle | Add this repository (below) |
| Home Assistant **Container** | **No — impossible** | Use the published Docker image: [`deploy/README.md`](https://github.com/NovaLux12/carelink-bridge/blob/main/deploy/README.md#docker-alternative-to-systemd) and [`deploy/nightscout-docker-compose.yml`](https://github.com/NovaLux12/carelink-bridge/blob/main/deploy/nightscout-docker-compose.yml) |
| Home Assistant Core (venv) | **No** | systemd unit: [`deploy/systemd/`](https://github.com/NovaLux12/carelink-bridge/tree/main/deploy/systemd) |

### This app has never been installed on a real Supervisor

It is labelled `stage: experimental` for that reason. What **has** been
verified is listed at the bottom of this page. What has **not** been verified is
that the Supervisor accepts this repository, installs the app, and starts it —
nobody has run that. Treat the first install as a test, not as a deployment.

---

## It is a dashboard layer, not a control plane

**Home Assistant does not own safety or availability for this bridge, and this
app is built so it cannot drift into doing so.**

Concretely, this app deliberately does **not** contain:

- a watchdog URL, so Home Assistant never restarts the bridge on your behalf;
- an `ingress` panel, so there is no HA-side UI whose absence would look like
  the bridge being down;
- any automation, blueprint, or service-call hook;
- any alerting. The bridge's own stale-data warning and optional
  `stale_webhook_url` are the alerting path, and they are the bridge's, not
  Home Assistant's.

The container's inherited `HEALTHCHECK` is explicitly **removed** in the
Dockerfile, because a health status that nothing acts on is a lie in the UI.

If the bridge stops, the app shows as stopped and that is the whole of the
signal. **Nightscout going stale is the real symptom** — watch that, not this
page. The reasoning is in
[ADR 0010](https://github.com/NovaLux12/carelink-bridge/blob/main/docs/adr/0010-home-assistant-add-on-is-packaging-only.md).

---

## Install

1. **Settings → Apps → Install app** (older versions: **Supervisor →
   Add-on Store**).
2. Top-right menu → **Repositories**.
3. Add: `https://github.com/NovaLux12/carelink-bridge`
4. **CareLink Bridge** appears in the store. Install it.
5. Fill in the configuration tab. At minimum: `carelink_username`,
   `carelink_password`, `api_secret`, `ns`. These have no defaults, so the app
   will not start until they are set.
6. **Do not start it yet** — it needs `logindata.json` first. See the next
   section. Starting without it just fails; it will not damage anything.

---

### Why there is no `image:` key

The app builds a thin Dockerfile instead of pointing at the published image,
because `image:` and the entrypoint this app needs are mutually exclusive.

With `image:` set, the Supervisor pulls that repository and **skips the
Dockerfile entirely** — `need_build` is `image not in config` in the Supervisor
source, and the tag it pulls is always `version`. The published bridge image has
no entrypoint, runs as `USER node`, pins its token to `/app/logindata.json`, and
cannot write a root-owned `/data` (measured: `EACCES`). So pointing `image:` at
it would produce an app that starts and then fails on both counts.

The Dockerfile here is `FROM ghcr.io/novalux12/carelink-bridge:0.4.2` plus an
entrypoint script. No bridge code is rebuilt; the version pin is the `FROM` line.
The follow-up that removes this wrinkle is a separately-published app image at
its own path, tagged with the same semver — see
[ADR 0010](https://github.com/NovaLux12/carelink-bridge/blob/main/docs/adr/0010-home-assistant-add-on-is-packaging-only.md).

---

## Getting `logindata.json` in

This is the part that does not fit neatly into an app, and it is worth
understanding why rather than following steps blindly.

### Why it is awkward

The bridge authenticates to CareLink with OAuth. The first login is interactive
— it needs a browser, or at minimum a terminal to paste a redirect URL into. It
writes the result to `logindata.json`, and from then on refreshes it silently
with the refresh token. **The container cannot do that first login**: the image
has no browser at all, and the paste fallback blocks on a TTY that an app
container does not have. Started without a token, the bridge enters the login
flow, waits forever, and exits 13.

Two further constraints, both measured rather than assumed:

- **The path is not configurable.** `LOGINDATA_FILE` is pinned to
  `/app/logindata.json` (verified inside the published image). There is no
  `CARELINK_LOGINDATA_FILE` to point elsewhere.
- **It cannot be bind-mounted.** Refresh rewrites the file atomically: it
  writes `logindata.json.tmp` and `rename`s it over the destination. A rename
  onto a bind-mounted *file* returns **`EBUSY`**, on `:ro` and `:rw` alike
  (measured 2026-11-14, recorded in `deploy/README.md`). A bind-mounted file
  would work until the first token refresh and then fail every fetch forever.

So the token has to sit on a real directory and be *copied* into `/app` at
container start. That is what this app's entrypoint does.

### The arrangement

The token is kept in two places and re-seeded at every start:

| Path | On the host | Why |
|---|---|---|
| `/config/logindata.json` | `/addon_configs/<repo-id>_carelink_bridge/logindata.json` | The copy you can reach and replace |
| `/data/logindata.json` | Supervisor-managed app data | Survives a reinstall of the app |
| `/app/logindata.json` | container filesystem | Where the bridge actually reads and refreshes it |

On start, the entrypoint picks the **newest** of the three by modification
time and copies it to all of them. Newest-wins matters: while the container is
running the bridge refreshes the token in `/app`, so on a restart `/app` holds a
*fresher* token than either persistent copy. Copying `/data` over it
unconditionally would throw away a valid refresh and eventually force a
re-login. Newest-wins keeps whichever is genuinely current.

`/app` is lost on every container recreate — which in Home Assistant means every
app update. `/data` and `/config` are not.

### How to actually get a token there

The token must be created somewhere that can run the interactive login. **The
app container is not that place.**

**Option A — from the published Docker image on any other machine (recommended).**

The token goes to a path inside the container, so run it with a TTY and no
volume mount, then copy the file out. **Do not mount a host directory over
`/app`** — that shadows `dist/` and the image cannot start
(measured: `Error: Cannot find module '/app/dist/login.js'`).

```bash
# On a laptop or any Docker host, once:
docker run -it --name carelink-login \
  ghcr.io/novalux12/carelink-bridge:0.4.2 \
  node dist/login.js

# It prints a URL. Open it in a browser, log in, copy the redirect URL with the
# `code=` parameter, and paste it back at the prompt. Then, in another terminal:
docker cp carelink-login:/app/logindata.json ./logindata.json
docker rm carelink-login
```

That prints a URL. Open it in a browser, log in, copy the redirect URL with the
`code=` parameter, paste it back. `logindata.json` appears in the container at
`/app/logindata.json`, which is what the `docker cp` above retrieves.

If you cloned this repository and have Node ≥ 22.12, `cd carelink-bridge && npm
ci && npm run login` on the host does the same thing and writes
`logindata.json` into the repo root — one less container to clean up. That path
also has a browser strategy the container lacks.

Then copy it onto the Home Assistant host:

```bash
# Home Assistant OS: use the Samba or SSH app, or the File editor.
scp logindata.json root@homeassistant.local:/addon_configs/<repo-id>_carelink_bridge/logindata.json
```

Find `<repo-id>` on the host: `ls /addon_configs/` — it is the folder ending
in `_carelink_bridge`. (The id is the first 8 hex characters of the SHA-1 of
the repository URL, so it is stable for this repository but not guessable.)

**Option B — re-login never happens in the app.** If the refresh token dies
(revoked, or you logged into the CareLink phone app, which invalidates it), you
repeat Option A and replace `/config/logindata.json`, then restart the app.
**There is no in-app re-login.** Plan for this: it is the normal recovery path,
not an emergency.

**Option C — run the bridge outside Home Assistant entirely** and use Home
Assistant only to display Nightscout. If the login step sounds like too much
friction, this is the honest recommendation: the Docker and systemd paths in
`deploy/` are better supported than this app, and this app cannot do the login
for you either way.

---

## Configuration

Every option maps to the environment variable of the same meaning documented in
`.env.example`. Defaults shown are the app's defaults.

### Required

| Option | Env var | Notes |
|---|---|---|
| `carelink_username` | `CARELINK_USERNAME` | CareLink email/username. No default. |
| `carelink_password` | `CARELINK_PASSWORD` | CareLink password. No default. Shown hidden. |
| `api_secret` | `API_SECRET` | Nightscout API secret (the bridge SHA-1s it itself). No default. Hidden. |
| `ns` | `NS` | Nightscout URL **including scheme**, e.g. `https://nightscout.example.com`. No default. |

### CareLink region

| Option | Env var | Default |
|---|---|---|
| `mmconnect_server` | `MMCONNECT_SERVER` | `EU` (`EU` or `US`) |
| `mmconnect_countrycode` | `MMCONNECT_COUNTRYCODE` | `gb` |
| `mmconnect_langcode` | `MMCONNECT_LANGCODE` | `en` |
| `mmconnect_servername` | `MMCONNECT_SERVERNAME` | unset — pins the hostname explicitly, overriding EU/US. Leave unset unless you have a reason. |

Getting the region wrong does not error: the endpoint answers `200` and the
account fails in a way that looks like a bad password. `npm run doctor` reports
`CareLink region` as a cross-check — worth running once outside the app.

### Timing and logging

| Option | Env var | Default | Notes |
|---|---|---|---|
| `carelink_interval` | `CARELINK_INTERVAL` | `300` | Fetch interval in **seconds**. |
| `carelink_sgv_limit` | `CARELINK_SGV_LIMIT` | `24` | SGV entries uploaded per fetch. |
| `carelink_quiet` | `CARELINK_QUIET` | `true` | `false` enables `info`-level logs. **Warnings and errors are logged either way** — this only controls chatter. |
| `log_format` | `LOG_FORMAT` | `pretty` | `pretty` or `json`. `pretty` reads better in the app log; `json` if you forward logs. |
| `carelink_assume_timezone` | `CARELINK_ASSUME_TIMEZONE` | unset (UTC) | IANA zone, e.g. `Europe/London`. **Set this if you are not on UTC.** Without it, a reading CareLink sends with no timezone is interpreted as UTC and every value is offset — and the warning that says so is invisible at the default quiet setting. |

### Data source and resilience

| Option | Env var | Default | Notes |
|---|---|---|---|
| `carelink_data_path` | `CARELINK_DATA_PATH` | `auto` | `auto`, `cumulus`, `legacy`. `auto` tries the current endpoint then falls back. |
| `carelink_app_version` | `CARELINK_APP_VERSION` | `3.8.0` | `appVersion` sent with the request. Must be ≥ `3.7` or the server answers `206 Upgrade application` and sends no data. |
| `carelink_patient` | `CARELINK_PATIENT` | unset | Only for a care-partner account with multiple patients. |
| `carelink_circuit_threshold` | `CARELINK_CIRCUIT_THRESHOLD` | `5` | Consecutive failed fetches before the circuit opens. |
| `carelink_circuit_cooldown_s` | `CARELINK_CIRCUIT_COOLDOWN_S` | `60` | Seconds the circuit stays open. |
| `carelink_stale_threshold_minutes` | `CARELINK_STALE_THRESHOLD_MINUTES` | `15` | Minutes without a successful fetch before a `STALE` warning. |
| `stale_webhook_url` | `STALE_WEBHOOK_URL` | unset | POSTs `{bridge, since, threshold_ms}` when the bridge goes stale. This is the alerting path — see "dashboard, not control plane" above. |
| `carelink_metrics_port` | `CARELINK_METRICS_PORT` | `0` | `0` = disabled, no listener. A non-zero port starts a **loopback-only** `/healthz` + `/metrics` server. Off by default because nothing in this app consumes it. |

State (`last success`, circuit state, refresh schedule) is written to
`/data/state.json`. It survives restarts and app updates. Its loss is harmless —
it costs one re-derived fetch and no data.

---

## Logs

**Settings → Apps → CareLink Bridge → Log**. With `carelink_quiet: true` you
will see only warnings and errors, which is the useful default. Set it to
`false` temporarily when diagnosing.

Useful lines to look for:

- `Restored last success: …` — state survived a restart, working as intended.
- `STALE` — no successful fetch past the threshold. This is the one to alert on.
- `Circuit open` — repeated failures, backing off deliberately.
- `Refresh token request failed` with `permanent` — the token is dead, go to
  Option B above.

---

## What was verified, and what was not

Being precise about this matters more than the feature list.

### Verified on 2026-11-16, against the published image

- Both YAML files parse. `config.yaml` defaults satisfy their own schema, and
  the only keys without defaults are the four required credentials.
- `ghcr.io/novalux12/carelink-bridge:0.4.2` exists as a **multi-arch** manifest
  with exactly two platforms: `linux/amd64`, `linux/arm64`. There is **no
  armv7**, which is why `arch` here lists only `aarch64` and `amd64`.
- The published image runs as `USER node` (uid 1000), `WORKDIR /app`,
  `CMD ["node","dist/main.js"]`, and exposes `LOGINDATA_FILE=/app/logindata.json`
  (read from inside the image).
- Against a **root-owned `0755` `/data`** — the layout the Supervisor creates —
  `savePersistentState('/data/state.json')` fails with **`EACCES`**. That is why
  the entrypoint chowns `/data` before dropping privileges. With the entrypoint,
  the same write succeeds as uid 1000, mode `0600`.
- The image builds (`docker build`), starts, and the entrypoint:
  - seeds `/app/logindata.json` from the newest of `/app`, `/data`, `/config`;
  - syncs all three copies and enforces mode `0600`;
  - writes `state.json` to `/data`;
  - runs the bridge as uid 1000, not root;
  - warns clearly and continues (rather than pretending) when no token exists.
- Options → environment mapping is exercised end-to-end: `log_format: json`
  produces JSON log lines, `carelink_interval: 120` produces
  `interval set to 120s`, `carelink_quiet: false` enables info lines.
- `carelink_quiet` is passed as the literal `true`/`false`, because the bridge
  only recognises those two literals — any other string is truthy via
  `Boolean(val)`, which would invert the setting. Confirmed in the image.

### Not verified — no Supervisor available

- That the Supervisor **accepts this repository** and lists the app.
- That it **builds the Dockerfile** on-device and starts the container with the
  expected `/data` and `/config` mounts.
- That the app-level options form renders correctly, and that `password` fields
  are handled as expected.
- Anything about `aarch64` at runtime. The manifest has an `arm64` build and the
  Dockerfile only adds a shell script, but no ARM host was used.
- A real CareLink login, a real Nightscout upload, or real pump data. No account
  was used at any point in building this app.

**What would falsify the untested claims:** installing the app on a Home
Assistant OS box and watching it build, start, and log a successful fetch with
a real token. Until that happens this is `experimental`, and the label says so.
