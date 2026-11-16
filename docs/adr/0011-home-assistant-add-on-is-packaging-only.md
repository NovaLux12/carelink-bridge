# 0011 — The Home Assistant app is packaging only, and untested

## Status

Accepted, 2026-11-16.

## Context

[Issue #144](https://github.com/NovaLux12/carelink-bridge/issues/144) asks for a
Home Assistant app (formerly "add-on") so the bridge installs from the HA UI
instead of a `git clone` and an `.env` edit. It was blocked on v0.5.0's published
image, which now exists.

Three constraints shaped the result, and each of them removes an option that
looks obvious from outside:

1. **Home Assistant apps require the Supervisor.** They only exist on Home
   Assistant OS or a Supervised install. A plain *Container* install
   (`docker run homeassistant/home-assistant`) has no Supervisor and cannot run
   them at all. This is the maintainer's own setup, so the app's audience is
   other users, and there is no environment here on which to test it.

2. **`logindata.json` cannot be bind-mounted.** Token refresh rewrites it with
   `writeLoginDataAtomic`: write a sibling `.tmp`, then `rename` over the
   destination. A rename onto a bind-mounted *file* returns `EBUSY` on `:ro` and
   `:rw` alike (measured 2026-11-14, `deploy/README.md`). The path is also not
   configurable — `LOGINDATA_FILE` is pinned to `/app/logindata.json` — and
   `/app` is destroyed on every container recreate, which in Home Assistant
   means every app update.

3. **The published image cannot write its own state under the Supervisor.**
   `/data` is created as `root:root` mode `0755`; the image sets `USER node`
   (uid 1000). Measured against `ghcr.io/novalux12/carelink-bridge:0.4.2`:
   `savePersistentState('/data/state.json')` → `EACCES`.

The obvious answer to (3) is `image:` in `config.yaml`, so the Supervisor pulls
the release rather than rebuilding. **That is not available here.** With
`image:`, the Supervisor pulls that image and the tag is always `version` — it
never builds the `Dockerfile` in the app folder. The published bridge image has
no entrypoint, so it would hit (2) and (3) exactly as measured.

## Decision

**The app is a thin build layer over the published release image, not a new
image, and it is labelled `stage: experimental`.**

- `config.yaml` carries **no `image:` key**, so the Supervisor builds
  `carelink_bridge/Dockerfile` on the device. That file is `FROM
  ghcr.io/novalux12/carelink-bridge:0.4.2` plus an entrypoint. All bridge code
  and dependencies still come from the published release; the version pin is the
  `FROM` line.
- The entrypoint does exactly two things: `chown` `/data` so uid 1000 can write
  it, and reconcile `logindata.json` between `/app`, `/data` and `/config`
  newest-wins before dropping privileges with `setpriv`. It does not supervise,
  restart, or health-check anything.
- The inherited `HEALTHCHECK` is removed, and there is no `watchdog:` or
  `ingress:` key, because Home Assistant must not appear to own availability.
- `carelink_quiet` is passed as the literal `true`/`false`, because
  `readEnvBool` only recognises those literals and `Boolean("False")` is `true`.

## Consequences

**Easier:** one-click install for HA OS / Supervised users. `logindata.json`
survives app updates. State survives. The bridge is unchanged — no new env var,
no new code path in `src/`.

**Harder:** the app must be rebuilt on-device, which needs Supervisor build
tooling and network access to GHCR. The Supervisor's `version` no longer implies
"this exact image"; it implies "this folder, whose image happens to match". If
the `FROM` tag and `version` drift, nothing fails loudly — a release-check gap
worth closing.

**Untested, and named as such.** No Supervisor exists on any machine available
while building this. Verified is limited to: the YAML parses and its defaults
satisfy its own schema; the manifest exists with `amd64`+`arm64` only (no
armv7, hence no `armv7` in `arch`); the image builds; the entrypoint seeds and
syncs the token, writes `state.json` to a root-owned `/data` as uid 1000 at mode
0600, and maps options to environment variables end-to-end. Not verified: that
the Supervisor accepts the repository, builds it, or starts it; that the options
form renders; anything on ARM hardware; any real CareLink or Nightscout call.
`DOCS.md` states this split in full, and `stage: experimental` is the label.

**What would justify reversing this:** publishing an app-specific image with
the entrypoint baked in, at its own repository path (e.g.
`ghcr.io/novalux12/carelink-bridge-ha`), tagged with the same semver as the
bridge. Then `config.yaml` can carry `image:` — the tag the Supervisor insists
on (`version`) would be the one that build produces — and the `Dockerfile` can
be dropped. That is the right follow-up and it is deliberately not done here: it
means changing the release pipeline, which is a separate change with its own
review. Baking the entrypoint into the *main* image is not an option, because it
would change the plain-Docker deployment path that the maintainer actually uses.

Second thing that would force a rethink: if the Supervisor turns out to `chown`
`/data` itself, the entrypoint's first job is unnecessary and should be removed
rather than kept "just in case".

## Notes

- Measurement commands and their results are in `carelink_bridge/DOCS.md`,
  "What was verified, and what was not".
- The `EBUSY` constraint is inherited, not new — `deploy/README.md` § Docker
  documents it for the plain-container path, which is the correct path for the
  maintainer's own install.
- `deploy/README.md` gains a pointer to this app, so the two paths do not
  diverge silently.
