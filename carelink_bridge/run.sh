#!/bin/sh
# Entrypoint for the carelink-bridge Home Assistant app.
#
# Two jobs, both forced by how the bridge resolves its data files. Neither is a
# supervision mechanism: if the bridge exits, this script exits with its code and
# the container stops. Home Assistant is a dashboard for this data, never the
# availability mechanism (see DOCS.md).
#
# JOB 1 — make /data writable.
#   The Supervisor creates /data as root, mode 0755. The published image runs as
#   `node` (uid 1000), so it cannot write there. Measured, not assumed:
#     docker run -v <root-owned dir>:/data ... savePersistentState('/data/state.json')
#     -> EACCES
#   So take ownership, then hand the process back to `node`.
#
# JOB 2 — reconcile logindata.json.
#   `LOGINDATA_FILE` is pinned to /app/logindata.json and is NOT configurable
#   (verified in the published image: `import('/app/dist/login.js')` reports
#   LOGINDATA_FILE=/app/logindata.json). /app is the container's own filesystem,
#   so anything written there is destroyed on every container recreate — which in
#   Home Assistant means every app update and every restore.
#
#   The token cannot be bind-mounted either: refresh rewrites it via
#   `writeLoginDataAtomic`, which writes a sibling `.tmp` and renames over the
#   destination, and a rename onto a bind-mounted *file* returns EBUSY on `:ro`
#   and `:rw` alike (measured 2026-11-14, deploy/README.md).
#
#   So the token is kept in two places, each persistent for a different reason:
#     /config/logindata.json  the user-reachable copy (app_config map; on the
#                             host under /addon_configs/<slug>_carelink_bridge/)
#     /data/logindata.json    the app's private copy, refreshed from /app as the
#                             bridge rotates tokens, so a reinstall does not
#                             lose a token that was still valid.
#   /app/logindata.json is re-seeded from whichever is newer at every start.

set -eu

APP_UID=1000
APP_GID=1000

# --- 1. Make the persistent volumes writable by the bridge ------------------
mkdir -p /data
chown -R "$APP_UID:$APP_GID" /data 2>/dev/null || true
if [ -d /config ]; then
  chown "$APP_UID:$APP_GID" /config 2>/dev/null || true
  [ -f /config/logindata.json ] && chown "$APP_UID:$APP_GID" /config/logindata.json 2>/dev/null || true
fi

# --- 2. Pick the freshest token and place it where the bridge expects it ----
LIVE=/app/logindata.json
PRIVATE=/data/logindata.json
PUBLIC=/config/logindata.json

# newest of the candidates, by mtime; empty if none exist
newest() {
  found=""
  for f in "$@"; do
    [ -f "$f" ] || continue
    if [ -z "$found" ] || [ "$f" -nt "$found" ]; then found="$f"; fi
  done
  printf '%s' "$found"
}

# /app is included in the comparison, not overwritten by it. While the container
# is alive the bridge refreshes the token in /app; on a restart (same container)
# /app therefore holds a *newer* token than either persistent copy, and seeding
# from /data would discard a refresh. Newest wins, then every copy is updated.
SRC=$(newest "$LIVE" "$PRIVATE" "$PUBLIC")

if [ -n "$SRC" ]; then
  for dest in "$LIVE" "$PRIVATE" "$PUBLIC"; do
    # /config only exists when the app_config map is present.
    case "$dest" in
      /config/*) [ -d /config ] || continue ;;
    esac
    cp -p "$SRC" "$dest" 2>/dev/null || true
    chown "$APP_UID:$APP_GID" "$dest" 2>/dev/null || true
    chmod 600 "$dest" 2>/dev/null || true
  done
  echo "[ha-app] logindata.json: newest copy is $SRC (synced to /app, /data, /config)"
else
  echo "[ha-app] WARNING: no logindata.json found in /config or /data." >&2
  echo "[ha-app] The bridge cannot log in here: the image has no browser, and the" >&2
  echo "[ha-app] paste fallback needs a TTY, so it will exit 13 instead." >&2
  echo "[ha-app] Put a logindata.json in the app's config folder and restart." >&2
  echo "[ha-app] See DOCS.md, 'Getting logindata.json in'." >&2
fi

# --- 3. Hand over to the bridge, as the unprivileged user ------------------
# setpriv is util-linux, present in node:22-bookworm-slim (verified in the image).
exec setpriv \
  --reuid="$APP_UID" \
  --regid="$APP_GID" \
  --init-groups \
  node /usr/local/bin/bridge-with-options.mjs
