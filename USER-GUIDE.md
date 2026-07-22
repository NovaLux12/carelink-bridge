# User guide

This is a step-by-step guide for people who want to **use**
`carelink-bridge` to get their Medtronic pump and CGM data into
Nightscout. It assumes you have never used a terminal before.

If you want to **read or modify** the bridge's code, see
[ARCHITECTURE.md](./docs/ARCHITECTURE.md) instead.

## What is this?

`carelink-bridge` is a small program that runs on your computer
(or a small server). Every 5 minutes it:

1. Logs into your [Medtronic CareLink](https://carelink.minimed.com/)
   account (the same one you use with the CareLink phone app).
2. Downloads your latest pump and CGM (sensor) data.
3. Uploads it to your [Nightscout](http://www.nightscout.info/) site.

Nightscout is a free, open-source website for tracking diabetes
data. Once your data is there, you (and your chosen tools) can see
trends, set alarms, and feed looping systems like Loop, xDrip, or
AAPS.

This is useful if you want to:

- See your CGM data in Nightscout without using a separate uploader
  (like a phone with the official app open).
- Feed Nightscout data to a DIY closed-loop system.
- Have a backup of your pump and sensor data in a place you control.

## Is this for me?

You need all three of these:

- **A Medtronic pump.** MiniMed 7xxG (720G, 740G, 754), MiniMed 780G,
  MiniMed Connect, or Guardian Connect. (The 780G is what this fork
  was specifically fixed for; older models also work.)
- **A CareLink account** with your pump already paired. If you can
  see your pump data in the CareLink phone app, you have this.
- **A working Nightscout site.** If you don't have one, set one up
  first — the [Nightscout project](http://www.nightscout.info/)
  has instructions. Heroku is the easiest free option, but they
  removed their free tier; the most common options now are
  self-hosting or paying a small monthly fee to a Nightscout host.

## What you will need

- **A computer** that can stay on or be on during the day. A small
  always-on machine is ideal — a Raspberry Pi, a home server, an
  old laptop. It needs to be on the same network as the internet
  (most are). It does not need to be fast; this is a tiny program.
- **A CareLink username and password.** The same email and password
  you use to log in to the CareLink website or app.
- **A Nightscout URL and API secret.** The URL is something like
  `https://yoursitename.herokuapp.com` or
  `https://nightscout.yourdomain.com`. The API secret is a long
  random string you set when you created your Nightscout site.
  Both are required.
- **15 minutes.** First-time setup takes about that long.

## What is a "terminal"?

A terminal (also called a "command line" or "shell") is a
text-based way to talk to your computer. On Windows it's called
**Command Prompt** or **PowerShell**. On macOS it's called
**Terminal**. On Linux it's usually called a terminal too.

You'll be typing commands like `npm install` and pressing Enter.
The computer will print back results. If you've never used one
before, don't worry — every command you need is listed below,
in order, with the expected output.

## Glossary

These words come up a lot in this guide. Skim this once and come
back if you hit a confusing word.

- **Bridge** — a small program that moves data from one place to
  another. This project is a bridge between CareLink and Nightscout.
- **CGM** — Continuous Glucose Monitor. The sensor that measures
  your blood sugar every few minutes.
- **SGV** — Sensor Glucose Value. One reading from your CGM.
- **Nightscout** — a free, open-source website for displaying
  CGM and pump data.
- **API secret** — a password that lets a program write to your
  Nightscout site. It's different from your CareLink password.
- **OAuth / OAuth2** — a way to log into a website without
  sharing your password with the program. The bridge uses
  OAuth2 to log into CareLink.
- **PKCE** — an extra safety layer on top of OAuth2. The bridge
  uses it; you don't need to do anything special.
- **`.env` file** — a plain text file in the project folder that
  holds your secrets. The bridge reads it on startup. Never share
  this file; never commit it to git.
- **`logindata.json`** — a file the bridge creates after you log
  in for the first time. It holds the OAuth tokens. Treat it like
  a password — never share it.
- **npm** — "Node Package Manager". A tool that downloads the
  bridge's code dependencies. It comes with Node.js.
- **Node.js** — the program that actually runs the bridge. You
  install it once.
- **git** — a tool for downloading source code. You install it
  once.

## Step 1: Install Node.js

The bridge is written in TypeScript and runs on Node.js. You need
**Node 20 or newer**.

**Check if you already have it.** Open a terminal and type:

```bash
node --version
```

If you see something like `v20.x.x` or `v22.x.x`, skip to the
next step. If you see `command not found` or a version below 20,
install Node:

- **Windows / macOS:** download the LTS installer from
  <https://nodejs.org/>. Run it. Accept the defaults. Open a
  **new** terminal window when it's done.
- **Linux:** use your package manager (`apt install nodejs npm`
  on Debian / Ubuntu, `dnf install nodejs npm` on Fedora,
  `pacman -S nodejs npm` on Arch). Or use
  [nvm](https://github.com/nvm-sh/nvm) if you prefer.

Verify the install:

```bash
node --version
npm --version
```

You should see two version numbers, both 20 or higher. (npm's
version is separate from Node's; it ships with Node so they were
installed together.)

## Step 2: Get the bridge code

You need **git** to download the code. If you don't have it:

- **Windows:** install from <https://git-scm.com/>. Accept the
  defaults.
- **macOS:** open Terminal and type `git --version`. If it says
  not found, macOS will offer to install the Command Line Tools
  — accept.
- **Linux:** `apt install git` / `dnf install git` / your
  package manager.

Then download the bridge:

```bash
git clone https://github.com/NovaLux12/carelink-bridge.git
cd carelink-bridge
```

You should see a folder called `carelink-bridge` containing
files like `package.json`, `README.md`, and `src/`. You're now
inside it.

## Step 3: Install dependencies

Still inside the `carelink-bridge` folder, run:

```bash
npm install
```

Expected output: a list of packages being added, ending with
something like `added 60 packages in 5s`. There will likely be
some warnings (deprecation notices, mostly); these are fine to
ignore. **If you see red error text, see the
[Troubleshooting](#troubleshooting) section below.**

Then compile the TypeScript code:

```bash
npm run build
```

Expected output: nothing on success. (TypeScript compiles
silently when there are no errors.) You should now see a new
folder called `dist/`.

## Step 4: Configure your secrets

Copy the example config file and edit it:

```bash
cp .env.example .env
```

Now open the new `.env` file in any text editor. (Notepad on
Windows, TextEdit on macOS — but make sure TextEdit is in
"plain text" mode, not rich text. VS Code is a popular free
editor that handles this correctly.)

Fill in four required values:

```env
CARELINK_USERNAME=your-carelink-username
CARELINK_PASSWORD=your-carelink-password
API_SECRET=your-nightscout-api-secret
NS=https://your-nightscout-site.example.com
```

- **CARELINK_USERNAME** — the email or username you use to log
  into CareLink. If your CareLink username is different from
  your email (some accounts are), use the username, not the
  email. The bridge will figure out which is which on the
  first fetch.
- **CARELINK_PASSWORD** — your CareLink password.
- **API_SECRET** — your Nightscout API secret. This is a
  long random string you set when you created your Nightscout
  site. (It might be called `API_SECRET`, `Nightscout API
  Secret`, or similar in your Nightscout settings.)
- **NS** — the full URL of your Nightscout site, starting
  with `https://`. Example: `https://nightscout.example.com`.

**Are you in the US?** Add this line:

```env
MMCONNECT_SERVER=US
```

The default is `EU` (Europe). If you're not sure, leave it as
`EU` and run `npm run doctor` (next step) — it will tell you
if the wrong region is the problem.

**Save the file.** Don't share it with anyone. Don't paste it
into chat. Don't commit it to git (the bridge's `.gitignore`
already prevents that, but be careful).

## Step 5: Run the pre-flight check

Before logging in, run:

```bash
npm run doctor
```

Expected output on success: a list of green checkmarks (✅)
or `[ok]` lines, ending with something like "All checks
passed. The bridge is ready to start." This means:

- Your `.env` is complete and parseable.
- CareLink's servers are reachable.
- Your Nightscout site is reachable and your `API_SECRET` is
  accepted.

If anything fails, the doctor will tell you exactly what.
This is the fastest way to find setup problems — run it any
time something seems off.

## Step 6: Log into CareLink

This is the only step that takes human action beyond typing
commands. The bridge needs your CareLink login tokens; it
gets them by logging in on your behalf.

```bash
npm run login
```

What happens next depends on your account:

- **If it just works:** you'll see a success message and the
  bridge will save your tokens to `logindata.json`. Move on
  to Step 7.
- **If a browser window opens:** CareLink wants you to
  complete a CAPTCHA or multi-factor authentication in a
  real browser. The bridge will open Chrome / Edge / Chromium
  automatically. Log in like you normally do. The window
  will close itself when it's done.
- **If neither happens and you see a URL printed:** your
  environment doesn't have a browser the bridge can use.
  Copy the URL, paste it into any browser, log in, then copy
  the URL the browser redirects you to (it will contain
  `code=...`), and paste it back into the terminal. Press
  Enter.

You only need to do this once. Your tokens are saved in
`logindata.json` and the bridge will refresh them
automatically.

## Step 7: Start the bridge

```bash
npm start
```

Expected output: a few lines of startup messages, then either
silence (with `CARELINK_QUIET=true`, the default) or a
log line every 5 minutes. The bridge is now running.

**To stop it:** press `Ctrl+C` in the terminal. The bridge
shuts down cleanly.

**To run it in the background** (so you can close the terminal
window and the bridge keeps running), see
[Run as a long-lived service](#run-as-a-long-lived-service)
below.

Open your Nightscout site in a browser. Within 5 minutes, you
should see your CGM data appearing. If you don't, see
[Troubleshooting](#troubleshooting).

## What happens every 5 minutes

The bridge wakes up, checks if it's time to fetch, and:

1. **Reads your tokens** from `logindata.json`.
2. **Refreshes them if needed.** Tokens last about 30 days;
   the bridge refreshes them silently in the background.
3. **Calls CareLink's data API** for your latest pump and
   sensor readings.
4. **Transforms the data** into Nightscout's format.
5. **Uploads only the new entries.** The bridge remembers
   what's already been uploaded (in memory) and skips it
   on the next round.
6. **Sleeps until the next interval.** Default is 300
   seconds (5 minutes).

## Settings

All settings go in the `.env` file. Only the first four are
required — the rest are optional.

| Setting | Default | What it does |
|---|---|---|
| `CARELINK_USERNAME` | *(required)* | Your CareLink email/username |
| `CARELINK_PASSWORD` | *(required)* | Your CareLink password |
| `API_SECRET` | *(required)* | Your Nightscout API secret |
| `NS` | *(required)* | Your Nightscout URL (e.g. `https://mysite.herokuapp.com`) |
| `MMCONNECT_SERVER` | `EU` | Set to `US` if you're in the United States |
| `MMCONNECT_COUNTRYCODE` | `gb` | Your country code (e.g. `us`, `de`, `nl`) |
| `MMCONNECT_LANGCODE` | `en` | Your language code |
| `CARELINK_INTERVAL` | `300` | How often to fetch data, in seconds (300 = 5 minutes) |
| `CARELINK_SGV_LIMIT` | `24` | How many SGV entries to upload per fetch |
| `CARELINK_QUIET` | `true` | Set to `false` to see more detailed logs |
| `CARELINK_PATIENT` | *(empty)* | Patient username, only needed if your care-partner account has multiple patients |

After changing any setting, restart the bridge (`Ctrl+C`,
then `npm start`).

## Proxy / firewall support

If you need to route CareLink traffic through a proxy
(corporate firewall, Tor, etc.), set the standard
`HTTPS_PROXY` environment variable. `axios` (the HTTP
library the bridge uses) respects it natively — no bridge-
specific config needed.

```bash
HTTPS_PROXY=http://proxy.example.com:8080 npm start
# or with authentication
HTTPS_PROXY=http://user:pass@proxy.example.com:8080 npm start
```

The bridge has no proxy code of its own. (A previous
version did, but it was removed because the design was
insecure for a medical-data app — see
[ADR 0004](./docs/adr/0004-no-fork-specific-proxy-code.md).)

## Run as a long-lived service

If you want the bridge to run unattended (24/7), you have
three options:

### Option A: A server with `screen` or `tmux` (easy)

Install `screen` or `tmux` on your Linux/macOS server, start
a session, run `npm start` inside it, detach. The bridge
runs in the background and survives your SSH session ending.

### Option B: A Linux server with systemd (recommended)

If you're on a Linux server with systemd (Ubuntu, Debian,
most modern Linux), the project ships a hardened user-level
systemd unit. See [deploy/README.md](./deploy/README.md) for
the full step-by-step. The short version:

```bash
bash deploy/install.sh     # clones, installs, builds, enables
# edit the .env file the installer created
npm run login
systemctl --user start carelink-bridge
journalctl --user -u carelink-bridge -f
```

### Option C: Windows / macOS desktop

The bridge will run as long as the terminal window is open
and the computer is on. For a 24/7 setup on Windows, consider
[Windows Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)
or a small always-on Linux machine (a Raspberry Pi is
sufficient).

## Troubleshooting

Start with `npm run doctor` — it pinpoints most setup
problems (missing settings, expired login, unreachable
CareLink / Nightscout, wrong API secret) in one command.

### Common problems

- **"No logindata.json found"** — Run `npm run login` first.
- **"Login expired"** — Delete the `logindata.json` file
  and run `npm run login` again.
- **Data not showing up in Nightscout** — Make sure your
  `NS` URL and `API_SECRET` are correct in the `.env` file.
  Try `npm run doctor` and check the Nightscout checks
  pass.
- **US users seeing errors** — Make sure you have
  `MMCONNECT_SERVER=US` in your `.env` file.
- **"npm install" fails with permission errors** — On
  Linux/macOS, do not use `sudo npm install`. Either fix
  your npm permissions
  (<https://docs.npmjs.com/resolving-eula-permissions-errors>)
  or use nvm to install Node into your home directory.
- **"No-Auth0 SSO configuration" error** — Your `.env`
  has the wrong region, or Medtronic has changed their
  config. Run `npm run doctor`; the error message will
  name the version string the bridge is pinned to.
- **Bridge keeps saying "fetch failed"** — Run with
  `CARELINK_QUIET=false npm start` to see the actual
  errors. The retry policy is documented in
  [ADR 0001](./docs/adr/0001-status-aware-retry-policy.md).

### Where to get more help

- Read [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for a deeper
  look at how the bridge works.
- Check [CHANGELOG.md](./CHANGELOG.md) — what version
  you're on and what changed recently.
- Open an issue on GitHub:
  <https://github.com/NovaLux12/carelink-bridge/issues>.
  Include the output of `npm run doctor` and the relevant
  log lines (with secrets redacted).

## Updates

To update to the latest version:

```bash
git pull
npm install
npm run build
```

Then restart the bridge. If you set it up with the systemd
unit, the `deploy/install.sh` script does all of this and
reloads the service.

Before a major version (e.g. v0.2.0 → v0.3.0), check the
[release notes](https://github.com/NovaLux12/carelink-bridge/releases)
— there may be new `.env` settings or breaking changes.

## Acknowledgements

This project is a community fork of
[domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge)
by [@domien-f](https://github.com/domien-f), maintained by
[@NovaLux12](https://github.com/NovaLux12) while upstream is
quiet.

It includes a fix from
[upstream PR #2](https://github.com/domien-f/carelink-bridge/pull/2)
by [@terminalcommand](https://github.com/terminalcommand) and
[@nraverdy](https://github.com/nraverdy), which fixes
empty-data issues on 780G, Guardian 4, and Simplera CGM
devices.

Inspired by
[nightscout/minimed-connect-to-nightscout](https://github.com/nightscout/minimed-connect-to-nightscout),
the original MiniMed Connect to Nightscout bridge by Mark
Wilson and the Nightscout community.

## Disclaimer

This project is for educational and informational purposes
only. It is **not FDA approved** and should not be used to
make medical decisions. It is **not affiliated with or
endorsed by Medtronic**, and may violate their Terms of
Service. Using it is at your own risk.

## License

[MIT](LICENSE)
