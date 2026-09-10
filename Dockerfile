# carelink-bridge — multi-stage build, small runtime image (issue #61).
#
# Runtime needs only env vars + a mounted logindata.json (created externally
# via `npm run login`); state.json is written next to it at runtime.
#
#   docker build -t carelink-bridge .
#   docker run -d --name carelink-bridge --env-file .env \
#     -v "$PWD/logindata.json:/app/logindata.json:ro" carelink-bridge
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
