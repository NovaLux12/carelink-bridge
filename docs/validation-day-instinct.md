# Validation day — first real Instinct / 780G account

_Status: procedure, not a claim. Everything below is either a step to run or an
explicitly labelled inference. Nothing here has been executed against a live
CareLink account._

## Why this document exists

The bridge has never talked to a real CareLink account. Every payload shape it
handles is derived from community reverse-engineering and Medtronic's own
published configuration — not from an observed response. On top of that, the
sensor in scope is an **Abbott-made Instinct** (15-day wear, CE-marked for the
780G in Europe in March 2026), and there are community reports that
Instinct-era devices use a data path no third-party client implements.

So the first real fetch is a **discovery** exercise, not a smoke test. The goal
is to answer three questions and write the answers down:

1. Which family/model strings does the cloud actually send?
2. Which endpoint actually returns data for this device?
3. Does the payload shape match what `src/transform/` expects?

## Step 0 — before the pump arrives

```bash
npm ci
npm run typecheck
npm test          # expect 342 passing across 26 files (v0.2.0 + #111)
npm run doctor
```

`doctor` is credential-free for the CareLink reachability check and proves the
discovery endpoint is up in your region. Nightscout checks need `NS` and
`API_SECRET` set.

## Step 1 — log in and let strategy 2 run

Login is three strategies in order: automated POST, Puppeteer browser, terminal
paste. Medtronic has been rolling out MFA, so **expect strategy 1 to fail and
strategy 2 to be the one that works**. That is by design, not a fault. If all
three fail, that is a real finding — file it on the placeholder issue.

## Step 2 — read the identity line FIRST

As of #111 the client logs a redacted device-identity line on every monitor
fetch, once per distinct shape:

```
Device identity from monitor/data (patient): {"deviceFamily":"…","deviceModel":"…","sensorModel":"…"} (BLE match: yes|NO)
```

**This one line answers question 1.** Copy it verbatim into the issue.

Interpretation:

| What you see | What it means | Next step |
|---|---|---|
| `BLE match: yes` | `isBleDevice()` recognised the family or model. The BLE endpoint is in use. | Step 3 |
| `BLE match: NO` with a family like `CC` / `NGP` / `CGM` / `GUARDIAN` | The documented-vocabulary case from #81 has bitten. Detection failed. | **Stop, do not widen the matcher yet** — Step 4 |
| `deviceFamily` absent entirely, only `deviceModel` | Family vocabulary is moot; model prefix is doing the work. | Check the model against `BLE_DEVICE_MODELS` in `src/carelink/client.ts` |
| Empty `{}` | The payload had none of the identity keys. | Step 4 |

The documented vocabulary (`GUARDIAN`, `NGP`, `CGM`, `CC` — with `CC` reportedly
covering Instinct) and the spellings the matcher accepts (`BLE…`, `SIMPLERA…`,
`CC880`, `FLEX`, plus model prefixes) may not overlap. That is the whole risk.

## Step 3 — confirm which endpoint answered

```bash
journalctl -u carelink-bridge -f | grep -Ei 'GET data|BLE endpoint|identity|connect/data'
```

Which of these appears tells you the path:

- `GET data (BLE) <url>` → the `blePereodicDataEndpoint` path worked
- `GET data <url>` with `monitor/data` → the monitor response was used directly
- `GET data <url>` with `connect/data` → the legacy fallback answered

Then check that glucose actually arrived:

```bash
curl -s "$NS/api/v1/entries.json?count=5" -H "api-secret: $HASHED" | jq '.[].sgv'
```

**Zero entries with a success log is the failure mode this whole document
exists to catch.** A 200 with an empty or unusable body is not success.

## Step 4 — if detection failed, capture before changing anything

Do not widen `isBleDevice()` on a guess. Routing a non-BLE device down the BLE
endpoint is its own silent failure. Instead:

1. Save the identity line and the endpoint that answered.
2. Capture **one** full payload, redacted, into `test/fixtures/` — see
   `docs/vendor-api/README.md` for where fixtures belong. Strip `access_token`,
   `refresh_token`, `username`, `patientId`, and any serial numbers.
3. Only then decide, with the real family string in hand, whether the fix is:
   - add the family to `BLE_FAMILY_TOKENS` (exact-token match), or
   - add the model prefix to `BLE_DEVICE_MODELS`, or
   - accept that Instinct needs a different data path entirely (see below).

## The Instinct data-path question — corrected 2026-11-08

⚠ **An earlier version of this document said Instinct "uses a Cumulus API that no
third-party client implements". That was wrong, and the correction matters.**
Full evidence: [`instinct-data-path-brief.md`](./instinct-data-path-brief.md).

What is actually true:

- **"Cumulus" is not a new API.** It is the literal key name `baseUrlCumulus` in
  Medtronic's public discovery JSON, and it has carried v11 and now **v13** — the
  same versioned base Guardian-era clients already use. There is no separate
  Instinct transport in that config.
- **A third-party client does implement it, and has since 2026-01-30.** xDrip+
  PR #4330 ("upgrade to v13 api — Support for Instinct sensors") merged with the
  Instinct box ticked, and multiple users confirmed data.
- **What broke Instinct later was a client-version gate, not a new API.** In Aug
  2026 `POST {baseUrlCumulus}/display/message` started rejecting
  `appVersion: "3.6.0"` with `206 {"message":"Upgrade application"}`. Bumping the
  body field restored data; xDrip shipped that as PR #4711 (2026-08-29).

So the work is not "implement a new transport". It is: be on `baseUrlCumulus`
v13 `display/message`, and send a **body** `appVersion` ≥ 3.7. Both are now
implemented (`src/carelink/cumulus.ts`, `CARELINK_DATA_PATH`).

The residual risks that remain genuine:

1. **The wire family value is unverified.** Three different fields carry a family
   and the bridge has historically treated them as one:
   `deviceFamily` (`/patient/monitor/data` — zero public captures),
   `medicalDeviceFamily` inside `patientData` (reportedly `CC` for Instinct, one
   hedged secondhand source), and `lastDeviceFamily`
   (`/patient/m2m/links/patients` — reportedly `INSTINCT`). `CC` is not one of
   the 16 published family tokens. **Do not widen the matcher on this** — the
   identity log is what settles it.
2. **Legacy backends answer 200 with stale records.** Accepting the first 200
   ends the search before reaching the right backend, which is why
   `buildEndpointCandidates()` now leads with v13 regardless of what the config
   hands out. A freshness check on the result is still worth doing by hand.
3. **`blePereodicDataEndpoint` is a v6 URL in every country probed** (GB/US/NL/
   DE/IE/AU/CA, 2026-11-08) while the device is v13-era. Treat it as a fallback,
   never the default.
4. **Diagnostic probes must be read-only on the token.** Auth0 rotates refresh
   tokens and reuse detection revokes the whole family: probing locally while the
   deployed bridge refreshes from the same `logindata.json` kills the deployment.
5. **The 780G + Instinct payload shape is unconfirmed.** Every detailed published
   Instinct capture is from **MiniMed Go** (MDI/InPen), not the 780G. Behavioural
   reports say 780G works; no pasted payload exists. Do not assume the two are
   identical.

## Known-fragile spots, in order of what will bite first

1. **The legacy `connect/data` fallback can return 200 with nothing useful.**
   `hasPayload()` guards the sibling-host case, but a genuinely empty body from
   the configured host is returned as-is (deliberate — it preserves single-host
   behaviour). Watch for entries landing as zero.
2. **Pump clock offset.** `src/transform/pump-offset.ts` infers the offset from
   `pumpTime` minus `serverTime`, rounded to a quarter hour. If SGV timestamps
   look skewed by whole or half hours, this is the suspect. `relativeOffset` is
   typed on `CareLinkSG` (#85) but **not yet consumed** — it is the better
   input if the guess turns out wrong.
3. **Token refresh under continuous operation.** Refresh is reactive (within
   ~1 min of expiry). Whether the refresh_token survives ~30 days of uptime is
   untested. A 4xx from refresh without `Retry-After` is treated as permanent.
4. **Rate limiting.** 3 retries with exponential backoff and jitter; 429 honours
   `Retry-After`. CareLink's actual limits are undocumented.
5. **`sensorModel` vs `deviceModel`.** The BLE source prefers `deviceModel` then
   `sensorModel`. If a sensor-only payload carries `sensorModel` and no
   `deviceModel`, detection depends entirely on the model prefix list.

## What to write down

Answer these on the placeholder issue after validation day:

- [ ] The `Device identity from …` line, verbatim
- [ ] Which endpoint logged `GET data`
- [ ] SGV count in Nightscout in the first hour
- [ ] Whether `BLE match` was yes or NO
- [ ] Auth strategy that worked (1/2/3)
- [ ] Any 429s in the first week
- [ ] Whether timestamps landed correctly

The first two close #81 step 1. The rest set the priority order for the
post-arrival work.
