# carelink-bridge — multi-stage build, small runtime image (issue #61).
#
# The runtime stage installs production dependencies only, so `tsx` is absent and
# `npm run doctor` / `npm run login` (which invoke it) DO NOT WORK IN THIS IMAGE —
# verified: `sh: 1: tsx: not found`. Use the compiled entrypoints instead:
#
#   docker build -t carelink-bridge .
#   docker run -d --name carelink-bridge --env-file .env \
#     -e CARELINK_STATE_FILE=/data/state.json -v carelink-data:/data \
#     carelink-bridge
#   docker cp logindata.json carelink-bridge:/app/logindata.json
#   docker restart carelink-bridge
#
# ⚠ Do NOT bind-mount logindata.json, with or without :ro. Token refresh writes
# a temp file and renames it over the destination, and rename onto a bind-mounted
# FILE fails with EBUSY either way — after which every fetch fails with a bare
# errno and the container never re-logins. Measured, not theorised. The `docker
# cp` above is the write path that works; `docker exec carelink-bridge npm run
# doctor:dist` is the pre-flight (the compiled form).
#
# The image enables the loopback-only observability server by default
# (CARELINK_METRICS_PORT=8081) so the HEALTHCHECK can probe /healthz.
# The server binds 127.0.0.1 — the container's own loopback — so no port
# needs publishing for the healthcheck to work.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

# OCI provenance labels. Without these a published image is anonymous: no way
# to tell which repository, commit or version built it. docker/metadata-action
# supplies the values at build time; declaring them here means the labels
# survive a plain `docker build` too, and keeps `docker inspect` useful.
LABEL org.opencontainers.image.title="carelink-bridge" \
      org.opencontainers.image.description="Bridge Medtronic CareLink pump and CGM data to Nightscout" \
      org.opencontainers.image.source="https://github.com/NovaLux12/carelink-bridge" \
      org.opencontainers.image.url="https://loopwise.uk" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Loopwise Health"

WORKDIR /app
ENV NODE_ENV=production
# Default ON so the container-level HEALTHCHECK has something to probe.
# Override with `--env CARELINK_METRICS_PORT=0` to run headless.
ENV CARELINK_METRICS_PORT=8081
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
# /app must be writable for state.json (USER node below).
RUN chown node:node /app
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const p=process.env.CARELINK_METRICS_PORT||'8081';fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
