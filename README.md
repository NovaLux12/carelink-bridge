# carelink-bridge

[![CI](https://github.com/NovaLux12/carelink-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/carelink-bridge/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/NovaLux12/carelink-bridge)](https://github.com/NovaLux12/carelink-bridge/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Community fork.** This is a community-maintained fork of [domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge). Original code by [@domien-f](https://github.com/domien-f). Maintained by [NovaLux12](https://github.com/NovaLux12) while upstream is quiet. PRs and issues welcome here.
>
> This fork includes the BLE device detection fix from [upstream PR #2](https://github.com/domien-f/carelink-bridge/pull/2) by [@terminalcommand](https://github.com/terminalcommand), which fixes empty-data issues on 780G, Guardian 4, and Simplera CGM devices.
>
> See [ROADMAP.md](./ROADMAP.md) for what comes next.

Sends your Medtronic pump and CGM data to [Nightscout](http://www.nightscout.info/) automatically.

It connects to Medtronic's CareLink servers the same way the official CareLink app does, grabs your latest pump and sensor data, and uploads it to your Nightscout site on a regular interval.

## What you need

- [Node.js](https://nodejs.org) version 20 or newer (download and install it if you don't have it)
- A [CareLink](https://carelink.minimed.com/) account with a connected pump (MiniMed 7xxG, MiniMed Connect, or Guardian Connect)
- A working [Nightscout](http://www.nightscout.info/) site

## Getting started

### 1. Download and install

Download or clone this repository, then open a terminal in the project folder and run:

```
npm install
npm run build
```

### 2. Configure

Make a copy of the file `.env.example` and name it `.env`. Open it in any text editor and fill in your details:

```env
CARELINK_USERNAME=your-carelink-username
CARELINK_PASSWORD=your-carelink-password
API_SECRET=your-nightscout-api-secret
NS=https://your-nightscout-site.example.com
```

- **CARELINK_USERNAME / PASSWORD** — the same email and password you use to log in to CareLink
- **API_SECRET** — your Nightscout API secret (the same one you set up when you created your Nightscout site)
- **NS** — the full URL of your Nightscout site, starting with `https://`

If you're in the US, also add this line:

```env
MMCONNECT_SERVER=US
```

(The default is EU.)

### 3. Log in

Run:

```
npm run login
```

This will try to log in automatically. If CareLink asks for a CAPTCHA, a browser window will open — just log in like you normally would. Once you're in, the window closes by itself and your login is saved.

You only need to do this once. Your login tokens are saved in a file called `logindata.json`.

### 4. Check everything is ready (optional but recommended)

```
npm run doctor
```

This runs a quick pre-flight check: your `.env` settings are complete, your
login token is valid, and CareLink and Nightscout are both reachable (and your
`API_SECRET` is accepted). It doesn't fetch any pump data — safe to run anytime,
especially the first time you connect a new pump.

### 5. Start the bridge

```
npm start
```

That's it! The bridge will fetch your data every 5 minutes and upload it to Nightscout. Leave it running in the background.

## Troubleshooting

Start with `npm run doctor` — it pinpoints most setup problems (missing settings, expired login, unreachable CareLink/Nightscout, wrong API secret) in one command.

- **"No logindata.json found"** — Run `npm run login` first.
- **Login expired** — Delete the `logindata.json` file and run `npm run login` again.
- **Data not showing up in Nightscout** — Make sure your `NS` URL and `API_SECRET` are correct in the `.env` file.
- **US users seeing errors** — Make sure you have `MMCONNECT_SERVER=US` in your `.env` file.

## Settings

All settings go in the `.env` file. Only the first four are required — the rest are optional.

| Setting | Default | What it does |
|---|---|---|
| `CARELINK_USERNAME` | *(required)* | Your CareLink email/username |
| `CARELINK_PASSWORD` | *(required)* | Your CareLink password |
| `API_SECRET` | *(required)* | Your Nightscout API secret |
| `NS` | *(required)* | Your Nightscout URL (e.g. `https://mysite.herokuapp.com`) |
| `MMCONNECT_SERVER` | `EU` | Set to `US` if you're in the United States |
| `MMCONNECT_COUNTRYCODE` | `gb` | Your country code (e.g. `us`, `de`, `nl`) |
| `CARELINK_INTERVAL` | `300` | How often to fetch data, in seconds (300 = 5 minutes) |
| `CARELINK_PATIENT` | | Patient username, only needed if your care partner account has multiple patients |
| `CARELINK_QUIET` | `true` | Set to `false` to see more detailed logs |

### Proxy / firewall support

If you need to route CareLink traffic through a proxy (corporate firewall, Tor, etc.), set the standard `HTTPS_PROXY` (or `ALL_PROXY`) environment variable. `axios` respects it natively — no bridge-specific config needed. Example:

```bash
HTTPS_PROXY=http://proxy.example.com:8080 npm start
# or with authentication
HTTPS_PROXY=http://user:pass@proxy.example.com:8080 npm start
```

The bridge doesn't ship any proxy code of its own. Removed in v0.1.2 to shrink the dependency footprint and reduce supply-chain surface area for a medical-data app.

## For developers

```bash
npm run dev       # Run directly from TypeScript (no build needed)
npm run build     # Compile TypeScript
npm test          # Run tests
```

## Deployment

A full deployment runbook for running this as a long-lived service on a Linux host is in [`deploy/README.md`](./deploy/README.md). It includes:

- A hardened user-level systemd unit (`deploy/systemd/carelink-bridge.service`)
- An idempotent install script (`deploy/install.sh`)
- A Nightscout + cloudflared docker-compose stack (`deploy/nightscout-docker-compose.yml`) for getting Nightscout + a public URL up alongside the bridge

Tested against Node 20+ on Ubuntu 26.04 LTS.

## Acknowledgements

Inspired by [nightscout/minimed-connect-to-nightscout](https://github.com/nightscout/minimed-connect-to-nightscout), the original MiniMed Connect to Nightscout bridge by Mark Wilson and the Nightscout community.

This fork includes a fix from [upstream PR #2](https://github.com/domien-f/carelink-bridge/pull/2) authored by [@terminalcommand](https://github.com/terminalcommand), with co-authorship from Nicolas Raverdy (`@nraverdy`). It resolves empty-data / no-SGV-upload on 780G, Guardian 4, and Simplera CGM devices.

## Disclaimer

This project is for educational and informational purposes only. It is not FDA approved and should not be used to make medical decisions. It is not affiliated with or endorsed by Medtronic, and may violate their Terms of Service.

## License

[MIT](LICENSE)
