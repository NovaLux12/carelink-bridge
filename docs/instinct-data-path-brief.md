# CareLink + Abbott-made Instinct: data-path technical brief

**Prepared for:** carelink-bridge (TypeScript) — first real-device validation, 780G + Instinct, UK/EU
**Date of research:** 2026-11-08 · **Evidence classes:** OBSERVED (live response I fetched today) · SOURCE-OBSERVED (`file:line` at a named commit) · SOURCE-PUBLISHED (an author's assertion) · INFERRED · UNVERIFIED

---

## Headline: the premise needs correcting before any code is written

The framing "Instinct uses a NEW 'Cumulus' API that no third-party client implements" is **two-thirds wrong**, and the error is the kind that sends a developer down a dead end for a week.

1. **"Cumulus" is not a new API.** It is the literal key name `baseUrlCumulus` in Medtronic's public discovery JSON. It has carried **v11** and now **v13** — the same versioned base that Guardian-era clients already use. There is no separate Instinct transport in that config. (OBSERVED — `https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/3.8`, fetched 2026-11-08.) **CONFIDENCE: high.**
2. **A third-party client does implement it, and has since 2026-01-30.** xDrip+ PR #4330 ("feat(carelink): upgrade to v13 api — Support for Instinct sensors") merged 2026-01-30 with the Instinct test checkbox ticked, and multiple users confirmed it worked. **CONFIDENCE: high.** (https://github.com/NightscoutFoundation/xDrip/pull/4330)
3. **What actually broke Instinct later was a client-version gate, not a new API.** In Aug 2026 `POST {baseUrlCumulus}/display/message` began rejecting `appVersion: "3.6.0"` with `HTTP 206 {"message":"Upgrade application"}`. Bumping the body field to `3.8.0` restored data. xDrip shipped that as PR #4711, merged 2026-08-29, release "2026.08.29 — Carelink fix". **CONFIDENCE: high** (two independent authors + merged code).

**Consequence for carelink-bridge:** the work is not "implement a new API". It is (a) confirm you are on `baseUrlCumulus` v13 `display/message` rather than `/patient/connect/data`, and (b) send a **body** `appVersion` ≥ 3.7. Those are small, testable changes.

---

## Q1 — What is the "Cumulus" API?

**It is the `baseUrlCumulus` base URL in Medtronic's public, unauthenticated discovery document, plus the `/display/message` endpoint on it.** Not a protocol, not a separate service.

The discovery document resolves **different API generations by the app-version path segment**, and I confirmed the whole axis live today:

| Discovery path `/connect/carepartner/v13/discover/android/{X}` | `baseUrlCumulus` | `baseUrlCareLink` | Auth0 SSO present? |
|---|---|---|---|
| `3.5` | `/connect/carepartner/v11` | `/api/carepartner/v2` | yes |
| `3.6` – `3.8` | **`/connect/carepartner/v13`** | `/api/carepartner/v2` | yes |
| `3.9`, `3.10`, `3.9.1`, `4.0`, `4.1`, `5.0` | **`/connect/carepartner/v2`** | `/api/carepartner/v1` | **no** — falls back to legacy `SSOConfiguration`, no `Auth0SSOConfiguration` key |

(OBSERVED — fetched all cells 2026-11-08; the high-version fallback is an inversion trap: asking for a *newer* app version yields an *older* API.) **CONFIDENCE: high.**

The `v13` cell also adds `Auth0SSOConfiguration` and `UseSSOConfiguration: "Auth0SSOConfiguration"`, which is what made the Jan-2026 client migration possible. This was first noticed by `ondrej1024` comparing v11 and v13 discovery JSONs in xDrip discussion #4318 (https://github.com/NightscoutFoundation/xDrip/discussions/4318). **CONFIDENCE: high.**

**The claim that Instinct specifically "uses Cumulus" is weaker than it reads.** The origin is a single comment by `m0rt4l1n` on 2026-01-03: *"The instinct sensor seem to use a new api called `Cumulus` so these sensors probably won't work until this is implemented"* — hedged with "seem to", and in the next breath he says his evidence is *"a few 'leaked' mock result assets"* in the 3.6.0 APK and *"it is not at all sure that this will work"*. **CONFIDENCE: low** that "Cumulus" denotes anything Instinct-specific. **CONFIDENCE: high** that it denotes the `baseUrlCumulus` config key.

There is **no** evidence of an Instinct-only endpoint, host, or content-type anywhere I looked (xDrip master, ondrej1024 client2, nightscout-connect `lib/sources/minimedcarelink`, domien-f/carelink-bridge, doctor-schmidt/carelink-cumulus-bridge). **CONFIDENCE: high** (negative finding across five codebases).

---

## Q2 — Is the Instinct data path different from Guardian 4's?

**Different on the wire; not different in transport.** The distinction is *which endpoint and which device-family token*, not *which API*.

**Yes, someone did pull Instinct to Nightscout successfully — twice, independently.**

- **xDrip+, 780G + Instinct, US.** `Navid200` (a maintainer) declared: "This sensor is supported as of the 2026.01.30 Nightly release." Users `damfly1234` ("confirm this new release works with instinct sensor") and `williamohicks` ("This latest nightly build works in the USA for the MiniMed 789G and Instinct sensor") confirmed. Before that, `PhilTU` relayed "at least two successes" and then "2 more successful tests" from the test build. (https://github.com/NightscoutFoundation/xDrip/discussions/4281) **CONFIDENCE: high.**
- **doctor-schmidt/carelink-cumulus-bridge, MiniMed Go + Instinct, EU, care-partner role.** States it was "Tested against a live MiniMed Go + Instinct account" and ships a `probe` command that "verifies the API returns your data". Repo created 2026-10-03, 18 commits, MIT, 0 stars. **CONFIDENCE: medium** — the author's assertion is specific and internally consistent (exact status codes, exact boundary values), but it is unstarred, unreviewed, and no third party has reproduced it.

**The Guardian 4 vs Instinct divergence is real and is captured in xDrip's own routing branch.** Before PR #4330, `getRecentData()` took the v13/display-message branch only for `isBle()` devices (`BLE`/`SIMPLERA`); `Patient.isCC()` (i.e. `lastDeviceFamily.contains("INSTINCT")`) did not exist. The PR added `isCC()` and changed the branch to `sessionPatients[i].isBle() || sessionPatients[i].isCC()`. That is a direct, source-observed statement that **Instinct needed an additional routing condition that Guardian did not**. **CONFIDENCE: high.** (https://github.com/NightscoutFoundation/xDrip/commit/39d79188, `client/CareLinkClient.java:288`)

Significantly, the *author of that change* noted a gap he did not close — the single-patient (non-M2M) path still reads:

```java
return this.sessionMonitorData.isBle(); // todo: check if CC should be added here as well
```

(`CareLinkClient.java:294`, master as of 2026-11-08) **CONFIDENCE: high** that this TODO is still open. It matters for you: if you authenticate as a **patient** account rather than a **care-partner**, xDrip's own Instinct routing is *not* applied. The doctor-schmidt README makes the same point from the other side: "Requires a CareLink **care partner** account (a patient account returns HTTP 204)".

**Caution on that last claim.** "Patient accounts cannot use display/message" is stated by one project and is contradicted in practice — xDrip has always called it with `role: "patient"` for patient logins (`CareLinkClient.java:229` passes `sessionUser.getUserRole()`). The 204 is more plausibly a *wrong-`patientId`/wrong-role-for-this-account* symptom, which is exactly how `m0rt4l1n` diagnosed several reports ("error 204 seems to indicate the wrong account type"). **CONFIDENCE: medium.**

---

## Q3 — What does `deviceFamily` carry for 780G + Instinct?

This is the most dangerous question in the brief, because **there are three different fields with three different names, and the bridge currently treats them as one.**

| Field | Endpoint | Instinct-era value | Evidence |
|---|---|---|---|
| `medicalDeviceFamily` (inside `patientData`) | `POST {baseUrlCumulus}/display/message` | **`CC`** | `m0rt4l1n`, xDrip #4318, 2026-01-06: "the `medicalDeviceFamily` (in the `/display/message` Endpoint) is `CC`" — prefixed "apparently" |
| `lastDeviceFamily` (patient list) | `GET /patient/m2m/links/patients` | **`INSTINCT`** | same comment, same sentence: "the `lastDeviceFamily` … is `INSTINCT`" |
| `deviceFamily` | `GET /patient/monitor/data` | **not documented anywhere** | xDrip matches it with `contains("BLE")`; `CC880`/`CC840` are the only published `CC*` families, and `CC880` maps to "MiniMed™ Flex" in vendor config |

**CONFIDENCE: medium-low** on `CC` and `INSTINCT` — one informed individual, hedged with "apparently", never corroborated by a pasted payload. **UNVERIFIED** on `/patient/monitor/data`'s `deviceFamily` for any 780G.

Supporting context that makes `CC` plausible: the 16 published family tokens from `personal.device.family.to.model.mapping` are `GM BLE700 BLE720 BLE740 BLE770 BLE780 GST SIMPLERA SIMPLERACC SIMPLERACCOLID NMX7 CC840 CC880 NMX8 INSTINCT EAGLE`, and `INSTINCT` is present as a **family** with SKU-789xx model codes. So `INSTINCT` is a legitimate published family token — it is not invented. (`CC` itself is *not* in that 16-token set; `CC840` and `CC880` are.) **CONFIDENCE: high** on the 16-token list.

**Two bugs worth knowing about, both source-observed, both upstream:**

- `RecentData.isCC()` in xDrip master is dead code — it compares against `DEVICE_FAMILY_NGP`, not `"CC"`:
  ```java
  public boolean isCC() { return getDeviceFamily().equals(DEVICE_FAMILY_NGP); }
  ```
  It has been wrong since the commit that introduced it (`39d79188`), so every `isNGP() || isCC()` test in `CareLinkDataProcessor.java` is currently just `isNGP()`. **CONFIDENCE: high.** Its only consumer is pump-status/reservoir population, so it is a data-completeness bug, not a no-data bug.
- `Patient.isBle()` / `isCC()` call `.contains(...)` on `lastDeviceFamily` with **no null guard** (`Patient.java:15,19`). A JSON entry missing that key throws NPE. **CONFIDENCE: high.**

---

## Q4 — BLE/standalone endpoint, or legacy `connect/data`?

**For 780G + Instinct: neither of the two you named. The answer is the third one — `{baseUrlCumulus}/display/message` (v13).**

Current xDrip routing (`CareLinkClient.getRecentData`, `:221-238`):

```
if (useConnectDisplayMessageData(patientUsername))   -> getConnectDisplayMessage(...)   // v13 display/message
else if (sessionM2MEnabled)                          -> getM2MPatientData(...)          // /patient/m2m/connect/data/gc/patients/{u}
else                                                 -> getLast24Hours()                // /patient/connect/data
```

with `useConnectDisplayMessageData` returning true for `isBle() || isCC()` (care-partner + M2M) and `monitorData.isBle()` (everyone else). **CONFIDENCE: high.**

**The `blePereodicDataEndpoint` is a red herring, and this is the single most useful correction in this brief.** I fetched `/patient/countries/settings` live for GB, US, NL, DE, IE, AU, CA today — **every one returns**

```
"blePereodicDataEndpoint": "https://clcloud.minimed.eu/connect/carepartner/v6/display/message"
```

i.e. **v6**, two generations behind. And xDrip no longer uses it: `getConnectDisplayMessage` accepts `endpointUrl` as a parameter, then **ignores it** whenever `useNewEndpoint` is true — and that flag is hard-coded `useNewEndpoint = true;` with the comment "use new v13 endpoint in every region" (`CareLinkClient.java:654, 673-677`). The v6 URL is dead code in the parameter list. **CONFIDENCE: high** (OBSERVED + SOURCE-OBSERVED).

This is a live trap for carelink-bridge, which *does* trust that field: `fetchBleDeviceData()` POSTs to `settingsResp.data.blePereodicDataEndpoint` verbatim. That is a v6 endpoint for a v13-era device. domien-f's fork already works around it by brute-forcing `/v{13,11,6,5}/` substitutions on that URL (https://github.com/domien-f/carelink-bridge/blob/main/src/carelink/client.ts). **CONFIDENCE: high** that posting to the literal v6 URL is the wrong default.

Liveness check I ran today (unauthenticated, POST, `{}` body): `v6 → 401`, `v11 → 401`, `v13 → 401`, `v2 → 403`. So v6/v11/v13 all exist and demand auth; v2 is present but rejects differently. **CONFIDENCE: high** (OBSERVED).

**Community position, summarised:** no one claims Instinct needs the standalone-CGM `monitor/data` → `blePereodicDataEndpoint` do-si-do. The Jan-2026 fix that demonstrably worked (PR #4330, confirmed by three US 780G+Instinct users) routed Instinct down the **v13 display/message** branch. That is the position to build against. **CONFIDENCE: high.**

---

## Q5 — Token / audience differences for the Instinct data plane

**No evidence of any. The `carepartner.patient.{ous,us}` audience is still the live one, and it demonstrably reaches Instinct data.**

Both SSO configs are served without authentication. I fetched them today:

| Region | Config URL | `client_id` | `audience` | `scope` | `client_secret` |
|---|---|---|---|---|---|
| OUS (EU/UK) | `carelink.minimed.eu/configs/v1/carepartner_auth0_ous_sso_config_v1.json` | `PeAhkbhQWlQRxJiQxWfcFBiGus1lxfe9` | **`carepartner.patient.ous`** | `profile openid offline_access` | `""` (empty) |
| US | `carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json` | `0FGoNwY0SP8ZmESYSfEOgMw03c58c1hk` | **`carepartner.patient.us`** | `profile openid offline_access` | `""` (empty) |

(OBSERVED 2026-11-08.) Note `client_secret` is empty → public client → PKCE applies. `authorization_endpoint_path` `/authorize`, `token_endpoint_path` `/oauth/token`, redirect `com.medtronic.carepartner:/sso`. **CONFIDENCE: high.**

The strongest empirical point: **doctor-schmidt's bridge logs in through exactly this client_id + audience and gets Instinct data back.** If Instinct needed a different audience, that project would have failed at the same wall xDrip hit. It didn't. **CONFIDENCE: medium-high.**

Independent corroboration that audience is the gate at all: `m0rt4l1n`, 2026-01-02 — *"Ok I am stupid, I forgot to add audience to the authorization request and I got it working"*, then *"its basically just a default Auth0 OAuth 2.0 flow without any accessories"*. **CONFIDENCE: high** that audience is load-bearing; **high** that it is unchanged.

One thing that *did* change alongside v13 and is worth knowing: the access token **no longer carries the username**, which broke older scripts that scraped it. `m0rt4l1n`: "the access token does not contain the username any more … so the current scripts don't work anymore". Hence `/users/me` as step 1. **CONFIDENCE: high.**

---

## The appVersion gate — the one thing most likely to bite you

Everything else in this brief is context. This is the failure you will actually hit.

`appVersion` is a **JSON body field** on `POST {baseUrlCumulus}/display/message`, not a header. Boundary, from single-field-varied testing against a live account:

| `appVersion` | Result |
|---|---|
| `3.5.0`, `3.6`, `3.6.1`, `3.6.9` | `206 {"message":"Upgrade application"}` |
| `3.7`, `3.7.0`, `3.8`, `3.8.0`, `4.0.0`, `10.0.0` | `200` + data |

**≥ 3.7 accepted, ≤ 3.6.9 rejected; both `X.Y` and `X.Y.Z` forms work.** Twelve header variants were tried and all failed (`User-Agent` spoofing to CareLinkConnect/okhttp/com.medtronic.carepartner, plus `x-app-version`, `app-version`, `client-version`, `x-client-version`, `x-carelink-app-version`). `os: "android"` is **optional** — the author publicly corrected his own earlier claim about this. **CONFIDENCE: medium-high** — one author, but the claim is falsifiable, matches xDrip's independent fix, and he published a correction to his own first version.

**Two version fields, two different constraints — do not conflate them:**

| Where | Constraint |
|---|---|
| Discovery path segment `/discover/android/{X}` | `3.5` → v11; **`3.6`–`3.8` → v13**; `3.9`+ → legacy v2, no Auth0 |
| Body `appVersion` | must be ≥ 3.7, no upper bound |

So: pin the discovery segment at **3.6–3.8**, and send body `appVersion` freely at 3.8.0 or above. Bumping the discovery segment to "be current" silently downgrades you to the v2 API with no Auth0 — a failure that looks nothing like its cause. **CONFIDENCE: high** (OBSERVED table above + source).

**Response shape also changes on v13** — three differences, all confirmed in merged xDrip code and the bridge:

1. Everything nests under **`patientData`** (legacy had it at the root). xDrip models this as `DisplayMessage{ metadata, patientData }`.
2. Readings carry **`timestamp`**, not `datetime`, and **no timezone** — they are the patient's local time (`patientData.clientTimeZoneName`).
3. **`sgs` is not sorted by time.** The bridge must sort.

**CONFIDENCE: high** on 1 and 3 (both modelled in code); **medium** on 2's timezone claim (one author; but consistent with xDrip's separate `correctTimeInDisplayMessage()` step existing at all).

---

## Diagnostic ladder for first real-device access

Ordered by information gained per unit of risk. Each step is cheap and each one *eliminates* a branch of the tree above.

**Step 0 — before the pump arrives (no account needed).**
Pin and assert the discovery segment. Fetch `/connect/carepartner/v13/discover/android/3.8`, assert the `CP[region=EU].baseUrlCumulus` ends `/v13`, and **fail loudly** if it does not. Then assert `UseSSOConfiguration == "Auth0SSOConfiguration"`. A silent change here invalidates everything downstream, and it is a one-request check.

**Step 1 — after login, before any data call.** `GET {baseUrlCareLink}/users/me`. Log `role` verbatim. This single string decides the code path: `CARE_PARTNER` / `CARE_PARTNER_OUS` → care-partner branch with `patientId`; anything else → patient branch. The 204 reports in #4318 were mostly this. Do **not** hardcode `role: "carepartner"`.

**Step 2 — capture the three family fields, raw, before writing any matcher.**
```
GET  /patient/m2m/links/patients        -> [].lastDeviceFamily        (expect "INSTINCT"?)
GET  /patient/monitor/data              -> .deviceFamily              (unknown - this is the gap)
POST {baseUrlCumulus}/display/message   -> .patientData.medicalDeviceFamily  (expect "CC"?)
```
Log all three, unnormalised, alongside the HTTP status. This is the highest-value authenticated check available and it takes one deploy. **Everything in Q3 above is secondhand until this runs.** `carelink-bridge` issue #81 says exactly this and warns — correctly — not to widen `isBleDevice()` before you have the values ("routing a non-BLE device down the BLE endpoint is its own silent failure").

**Step 3 — distinguish 204 from 206 from 200-empty. They mean different things.**
- `204` → authenticated, no content → wrong `role`/`patientId` pairing, or account type mismatch. **Not** an API-shape problem.
- `206 {"message":"Upgrade application"}` → `appVersion` body field too low. Bump to `3.8.0` and retry before touching anything else.
- `200` with `sgs: []` or `lastSG: null` → wrong endpoint generation (v6/v11 vs v13), or device not yet uploading.
- `401` → token/audience.

**Step 4 — prove endpoint generation, not just liveness.** POST the same body to v6, v11 and v13 and compare `sgs` counts and `lastSG.timestamp` recency. domien-f's fork already found that **a legacy backend answers `200` with the last records it ever held** — a stale-but-200 response. Accepting the first 200 ends the search before reaching the right backend. Add a freshness check (domien uses a threshold and keeps stale as a floor).

**Step 5 — only now, sort and normalise.** Sort `sgs` by `timestamp || datetime`, drop `sg == 0`, and parse timestamps as **local time in `clientTimeZoneName`**. Do this after you have a captured payload to test against, not from this document.

**Step 6 — never assume a token is single-use.** Auth0 rotates refresh tokens and reuse detection **revokes the whole family**. If you run a probe locally while the deployed bridge is also refreshing from the same `logindata.json`, you kill the deployment. doctor-schmidt hit this: "13 consecutive 403s and no data … until a fresh login". Make diagnostic probes **read-only on the token** — fail with instructions rather than refreshing.

---

## What we still cannot know without a real account

1. **The actual wire value of `deviceFamily` from `/patient/monitor/data` for a 780G.** Zero public captures. xDrip matches `contains("BLE")` and separately added `CC880`; those two are not reconcilable into one value and nobody has published the string.
2. **Whether `medicalDeviceFamily` is literally `CC`** for a 780G + Instinct, as opposed to `CC840`/`CC880`/`INSTINCT`. One hedged secondhand report says `CC`; `CC` is not in the 16 published family tokens, which is a mild contradiction worth resolving on the wire rather than trusting.
3. **Whether a 780G + Instinct (MiniMed Mobile app) and a MiniMed Go + Instinct (MiniMed Go app) produce the same `patientData` shape.** Every detailed Instinct capture published so far is from **MiniMed Go** (MDI, InPen) — doctor-schmidt's repo is explicitly "MiniMed Go / Instinct". The 780G evidence is *behavioural* ("it works"), not *structural* (no pasted payload). Your device is the 780G. **Do not assume the two payloads are identical.**
4. **Whether the appVersion boundary still holds in November 2026.** It was measured in Aug 2026. It is a server-side gate and can move without notice — which is precisely why it should be a config value with a loud failure, not a constant.
5. **Whether a patient-role account can use `display/message` for Instinct at all**, or whether care-partner is genuinely mandatory. Two sources disagree (see Q2).
6. **`lastAlarm`, `markers` and `clearedNotifications` shape changes** on v13. `m0rt4l1n` explicitly flagged these as possibly changed with "insufficient data to come to a real conclusion" — and alarm data is medical-content, not cosmetic.
7. **Real latency and rate limits.** doctor-schmidt measured sensor→cloud ≈ 4.5 min and end-to-end 5–8 min on MiniMed Go; that number is not transferable to a 780G upload path and should be measured, not assumed.
8. **Whether the 15-day wear cycle produces a distinct `sensorState` / `sensorDurationHours` pair.** `sensorDurationHours` is consumed by xDrip's pump-status block and by any Nightscout `connect.sensorDurationHours` field; 15-day wear will look anomalous against 7-day assumptions until observed.

**One process note.** The single most reliable primary source for this whole subject is `NightscoutFoundation/xDrip` master — the code is ahead of every prose write-up, including this one. Read `message/Patient.java`, `message/MonitorData.java`, `message/RecentData.java` and `client/CareLinkClient.java` at `master` before trusting any blog, README, or issue comment, including the ones cited here.
