# Home Assistant app image for carelink-bridge.
#
# This does NOT rebuild the bridge. It is the published release image plus a
# small entrypoint; all bridge code and dependencies come from
# `ghcr.io/novalux12/carelink-bridge:0.4.2`. The entrypoint exists for two
# reasons, both documented at length in run.sh:
#
#   1. `/data` is created by the Supervisor as root and the image runs as
#      `node`, so the bridge cannot write its state file there without a chown.
#   2. `logindata.json` is pinned to `/app/logindata.json` and `/app` is
#      destroyed on every container recreate, so the token has to be re-seeded
#      at start.
#
# Built on the device by the Supervisor (there is no `image:` key in
# config.yaml). That is deliberate: see DOCS.md, "Why the Supervisor builds it".

FROM ghcr.io/novalux12/carelink-bridge:0.4.2

# The base image ends with `USER node` (uid 1000). Root is needed only to take
# ownership of /data; run.sh drops back to `node` with setpriv before the bridge
# starts, so the bridge itself never runs as root.
USER root

COPY run.sh /usr/local/bin/run.sh
COPY bridge-with-options.mjs /usr/local/bin/bridge-with-options.mjs
RUN chmod 755 /usr/local/bin/run.sh /usr/local/bin/bridge-with-options.mjs

# The base image ships a HEALTHCHECK that probes the loopback /healthz endpoint.
# This app has no watchdog by design (see DOCS.md), and with metrics disabled the
# probe would report the container unhealthy for a reason nothing acts on. Drop
# it rather than leave a check whose failure means nothing.
HEALTHCHECK NONE

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/run.sh"]
CMD []
