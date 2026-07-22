# carelink-bridge

[![CI](https://github.com/NovaLux12/carelink-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/carelink-bridge/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/NovaLux12/carelink-bridge)](https://github.com/NovaLux12/carelink-bridge/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Sends your Medtronic pump and CGM data to [Nightscout](http://www.nightscout.info/)
automatically, by logging into Medtronic's CareLink servers the same
way the official CareLink app does and uploading what it gets.

> **Community fork.** This is a community-maintained fork of
> [domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge).
> Original code by [@domien-f](https://github.com/domien-f).
> Maintained by [NovaLux12](https://github.com/NovaLux12) while
> upstream is quiet. PRs and issues welcome here.
>
> This fork includes the BLE device detection fix from
> [upstream PR #2](https://github.com/domien-f/carelink-bridge/pull/2)
> by [@terminalcommand](https://github.com/terminalcommand), which
> fixes empty-data issues on 780G, Guardian 4, and Simplera CGM
> devices.

## What do you want to do?

**I want to install and run the bridge** —
[USER-GUIDE.md](./USER-GUIDE.md). Step-by-step from zero (no
terminal experience required). Covers install, login, start,
troubleshooting, and keeping it running as a service.

**I want to deploy it on a server** —
[deploy/README.md](./deploy/README.md). systemd unit, install
script, Nightscout + cloudflared docker-compose stack.

**I want to read or modify the code** —
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Module map,
data flow diagrams, OAuth deep-dive, error / retry semantics,
test architecture, "where do I start" guide for new
contributors.

**I want to contribute a change** —
[CONTRIBUTING.md](./CONTRIBUTING.md). Workflow, ground rules,
release process.

**I want to understand the project's status and direction** —
[ROADMAP.md](./ROADMAP.md). What's shipped, what's gated on
what, what's out of scope.

**I want to report a security issue** —
[SECURITY.md](./SECURITY.md). Threat model, how to file a
private advisory.

**I want to see what changed recently** —
[CHANGELOG.md](./CHANGELOG.md). Version history.

## Quick start (one-liner)

If you already have Node 20+ and a CareLink account, this is
the whole thing:

```bash
git clone https://github.com/NovaLux12/carelink-bridge.git
cd carelink-bridge
npm install && npm run build
cp .env.example .env       # then fill in CARELINK_USERNAME, CARELINK_PASSWORD, API_SECRET, NS
npm run doctor             # pre-flight check
npm run login              # one-time OAuth login
npm start                  # fetch loop
```

For the full walkthrough, including Node install, .env
editing, the three login strategies, and troubleshooting,
see [USER-GUIDE.md](./USER-GUIDE.md).

## Disclaimer

This project is for educational and informational purposes
only. It is **not FDA approved** and should not be used to
make medical decisions. It is **not affiliated with or
endorsed by Medtronic**, and may violate their Terms of
Service. Using it is at your own risk.

## License

[MIT](LICENSE)
