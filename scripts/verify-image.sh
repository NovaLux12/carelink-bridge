#!/usr/bin/env bash
# Exercise the Docker image, instead of only building it.
#
# WHY THIS EXISTS
# ---------------
# `docker.yml` builds and pushes the image but never runs anything inside it,
# so the pipeline proved the image was BUILT, not that it WORKED. Measured
# 2026-11-15 against a built image: `npm run doctor` -> `sh: 1: tsx: not found`,
# exit 127, because the runtime stage runs `npm ci --omit=dev` and tsx is a
# devDependency. The image was published anyway. deploy/README.md now tells
# operators to use `doctor:dist`, and nothing checked that this works either.
#
# WHAT IS ASSERTED
# ----------------
#   1. `node dist/doctor.js` (what `doctor:dist` runs) executes and reports —
#      exit 1 with the config row, NOT 127/1 with a module-resolution error.
#   2. `npm run doctor:dist` — the command operators are told to type — does the
#      same through npm, so a scripts-map regression is caught.
#   3. `node dist/main.js` (the Dockerfile CMD) loads and refuses to start with
#      its own message rather than a module error.
#   4. `tsx` is genuinely absent from the runtime image. That is the reason the
#      `:dist` scripts exist; if someone moves tsx into `dependencies` the docs
#      and the reason for this job both become wrong, and we should know.
#   5. The image runs as non-root and keeps its HEALTHCHECK.
#
# WHAT WOULD MAKE THIS RED
# ------------------------
# Dockerfile dropping a COPY of dist/, `npm ci --omit=dev` extended to strip a
# runtime dependency, an entrypoint renamed in src/ but not in CMD or the
# scripts map, dist/ built from a tsconfig that excludes an entrypoint, a
# regression to `USER root`, or the HEALTHCHECK being deleted.
#
# Deliberately no secrets and no network assertions: doctor's CareLink and
# Nightscout rows depend on the runner's egress and are checked by presence of
# the local config row only, not by their verdict.
set -uo pipefail

IMAGE="${1:-carelink-bridge:ci}"
FAILED=0

fail() {
  echo "  FAIL: $*" >&2
  FAILED=1
}

# Run a command in the image; capture combined output and exit code.
run_in_image() {
  docker run --rm --entrypoint "$1" "$IMAGE" "${@:2}" 2>&1
}

echo "== image: $IMAGE"

# --- 1. dist/doctor.js ------------------------------------------------------
out=$(run_in_image node dist/doctor.js); code=$?
echo "--- node dist/doctor.js (exit $code)"
echo "$out" | head -12
if [ "$code" -ne 1 ]; then
  fail "node dist/doctor.js exited $code, expected 1 (1 = checks failed with no config; 127/2 means it did not run)"
fi
echo "$out" | grep -q 'carelink-bridge doctor' || fail "doctor banner missing — dist/doctor.js did not run"
echo "$out" | grep -q 'Config (.env)' || fail "doctor produced no config row — it ran but reported nothing"

# --- 2. npm run doctor:dist (the documented operator command) --------------
out=$(docker run --rm "$IMAGE" npm run doctor:dist 2>&1); code=$?
echo "--- npm run doctor:dist (exit $code)"
if [ "$code" -ne 1 ]; then
  fail "npm run doctor:dist exited $code, expected 1 (127 = script/tool resolution failure)"
fi
echo "$out" | grep -q 'Config (.env)' || fail "npm run doctor:dist produced no config row"
echo "$out" | grep -q 'tsx: not found' && fail "npm run doctor:dist fell back to tsx — the runtime image has no devDependencies"

# --- 3. the Dockerfile CMD --------------------------------------------------
out=$(run_in_image node dist/main.js); code=$?
echo "--- node dist/main.js (exit $code)"
if [ "$code" -ne 1 ]; then
  fail "node dist/main.js exited $code, expected 1"
fi
echo "$out" | grep -q 'Missing CARELINK_USERNAME' \
  || fail "CMD entrypoint did not reach its own config error — the compiled module graph does not load in the image"

# --- 4. tsx must NOT be present (the reason :dist scripts exist) ------------
# Probed as `node_modules/.bin/tsx`, which is exactly what `npm run doctor`
# resolves first — PATH does not contain node_modules/.bin outside an npm
# script, so `command -v tsx` would answer "absent" even in a broken image.
docker run --rm --entrypoint sh "$IMAGE" -c 'test -x node_modules/.bin/tsx' >/dev/null 2>&1
tsx_code=$?
if [ "$tsx_code" -eq 0 ]; then
  fail "node_modules/.bin/tsx exists in the runtime image — devDependencies leaked, and the documented reason for doctor:dist is now false"
else
  echo "--- no tsx binary in node_modules/.bin (expected: npm ci --omit=dev)"
fi

# --- 5. non-root user and HEALTHCHECK --------------------------------------
user_out=$(docker run --rm --entrypoint id "$IMAGE" -un 2>&1)
echo "--- runtime user: $user_out"
if [ "$user_out" = "root" ] || [ -z "$user_out" ]; then
  fail "image runs as root (or id failed) — expected the unprivileged 'node' user"
fi
if ! docker inspect --format '{{json .Config.Healthcheck}}' "$IMAGE" | grep -q '"Test"'; then
  fail "image has no HEALTHCHECK"
fi

if [ "$FAILED" -ne 0 ]; then
  echo -e "\nverify-image FAILED — the image was built but does not work." >&2
  exit 1
fi

echo -e "\nverify-image: doctor, doctor:dist, the CMD entrypoint, non-root and HEALTHCHECK all verified."
