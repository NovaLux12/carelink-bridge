# 0004 — No fork-specific proxy code

## Status

Accepted (since v0.1.2, 2026-07-19).

## Context

A pre-fork version of `carelink-bridge` shipped with custom proxy
support: a `loadProxyList` function, a `createProxyAgent` helper, a
`ProxyRotator`, and a config file called `https.txt` that listed
proxies. If the file existed, the bridge silently loaded it and
routed all CareLink traffic through the listed proxies. If it didn't
exist, the bridge made direct connections. The README did not
document the file.

This is dangerous for a bridge that handles full CareLink account
access and CGM data:

- A single dropped or poisoned `https.txt` (npm postinstall script,
  dependency confusion attack, social-engineering issue) would
  silently route OAuth tokens and CGM data through a third-party
  server. The operator would not know.
- The default `USE_PROXY=true` meant most operators were running
  with this exposure without knowing it.
- The proxy support depended on `https-proxy-agent` and
  `socks-proxy-agent`, both of which were dormant in the default
  config but were still in the supply chain. They are a
  review cost and a CVE surface area.

The custom proxy code was a fork-specific divergence from the
upstream `domien-f/carelink-bridge` (which never had it) and was
attributed to no one in the original commit history — the project
adopted it without a documented rationale.

## Decision

The bridge does not ship any proxy code of its own. Specifically:

- `loadProxyList`, `createProxyAgent`, `ProxyRotator` — all removed.
- The `https.txt` config file — no longer read.
- The `USE_PROXY` environment variable — no longer recognised.
- The `https-proxy-agent` and `socks-proxy-agent` dependencies —
  removed from `package.json`.

Anyone needing outbound proxying sets the standard `HTTPS_PROXY` /
`HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables.
`axios` (the HTTP client the bridge uses) supports these natively
via its agent selection — no bridge-specific code is required.

The v0.1.1 cycle also changed the pre-existing `USE_PROXY` default
from `true` to `false`, ensuring the v0.1.2 removal did not break
anyone who had `USE_PROXY` set in their `.env` (because the
previous default had been `true`, removing the knob outright
without first changing the default could have stranded a config
file that set it explicitly).

## Consequences

- **Easier:** A poisoned `https.txt` cannot be planted; the file is
  not read. A supply-chain attack on `https-proxy-agent` /
  `socks-proxy-agent` cannot land because neither is a dependency.
- **Easier:** -146 / +18 lines, two fewer direct dependencies. The
  bridge is smaller, faster to install, and faster to review.
- **Easier:** Operators who actually need proxying can use the
  standard env vars, which work the same way for every Node
  application and every HTTP library. No special config to learn.
- **Harder:** Operators who relied on the rotation feature of
  `ProxyRotator` (load-balancing across multiple proxies) have
  lost that capability. This is by design — the rotation was
  undocumented and the threat model it created was unacceptable.
  The standard `HTTPS_PROXY` env var points at one proxy; if
  rotation is needed, the operator uses an external tool (a sidecar
  proxy, an iptables rule, a corporate VPN) rather than a bridge-
  specific feature.
- **Harder:** A reader of the git history can see ~150 lines of
  proxy code being removed. If the rationale for the removal is
  not documented (it is — this ADR plus the v0.1.2 CHANGELOG
  entry), a future maintainer might re-add it "for the users who
  were relying on it." There are no such users; the feature was
  undocumented and the threat model it created was not worth any
  user benefit.

## What reverses it

None should. The only thing that could "reverse" this is
re-introducing a custom proxy code path, which would re-introduce
the attack surface and the supply-chain dependencies. Anyone who
needs proxying uses `HTTPS_PROXY`. The standard env var is the
right answer for a project that values small dependency footprint
and minimal config surface.

## Notes

- Source: the v0.1.1 and v0.1.2 CHANGELOG entries.
- The standard `HTTPS_PROXY` env var is documented in the user
  guide's troubleshooting section.
- The systemd unit's outbound network calls reach
  `*.minimed.{eu,com}` and the operator's Nightscout endpoint. No
  inbound network listeners; no other outbound traffic.
