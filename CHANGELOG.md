# Changelog

All notable changes to this fork are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(0.x: minor = phase, patch = fixes within a phase).

Entries before v0.1.0 describe the upstream history this fork carries.
Written retroactively on 2026-07-19; dates are taken from the git/tag/release
record, not reconstructed.

## [Unreleased]

### Fixed

- **`npm run doctor` reported a correctly-secured Nightscout as unreachable.**
  `/api/v1/status.json` is not public on a default Nightscout —
  `AUTH_DEFAULT_ROLES=denied` makes an unauthenticated request return `401`, so
  doctor called a healthy server `✗ unreachable` and then returned early,
  skipping the API-secret check that would have proved it was fine. The
  reachability probe now sends the hashed secret, a `401`/`403` is reported as
  *reachable but unauthorised* (one root cause, one `✗`, not two), and a bare
  `401` with no secret configured still fails closed. Measured against a live
  Nightscout 15.0.9: two `✗` → two `✓`; a wrong secret still exits `1`.
- **A correct `API_SECRET` was reported as rejected.** Nightscout 15 returns a
  nested `{message:{…,message:"OK"}}` from `/api/v1/verifyauth`; the old
  `String(message)` produced `"[object Object]"`, which never contains `"OK"`.
  Both the nested and the older flat shape are now read.
- **`doctor` hardcoded the discovery pin** (`.../discover/android/3.6`) instead
  of importing `DISCOVERY_APP_VERSION`, so moving the pin changed what login
  probed and not what doctor probed (#145). It now uses `buildDiscoveryUrl()`
  and names the pin in its output.
- **Docker users had no `doctor` or `login`.** The runtime stage runs
  `npm ci --omit=dev` and those scripts invoked `tsx`, a devDependency, so both
  failed with `sh: 1: tsx: not found` (exit 127) — verified against the
  published image. Added `doctor:dist` / `login:dist` running `node dist/…`,
  which the build stage already compiles (#146).

### Changed

- `deploy/README.md` no longer claims the compose file still carries the `:ro`
  token mount (it does not), and documents that the container's `login:dist`
  has no browser — the first login stays on the host.
- `CONTRIBUTING.md` recorded the branch-protection contexts as broken; the live
  config is `ci (22)`, `ci (24)`, `cross-links`, matching the `[22, 24]` matrix.
  Rewritten to keep the drift rule rather than the stale status.
- `ROADMAP.md` v0.5.0 now marks the published image done, and records that the
  workflow landed after `v0.4.1` was tagged, so `latest` is an unversioned
  build of `main` until the next tag.

## [0.4.1] — 2026-11-14

**A patch, because v0.4.0's own headline claim was undermined one commit later.**

v0.4.0's stated purpose was that the silent failure modes were gone. Checking
the two subagent handoff reports afterwards found three integration gaps that
had landed *after* the tag — and one of them was a metric that lied in exactly
the scenario it was added to catch. Shipping a tag whose purpose is contradicted
by one commit on `main` is the release-hygiene failure this repo has already been
bitten by twice (v0.1.1, and v0.3.0 marked shipped while untagged).

### Fix — `carelink_stale` did not track the stale watchdog

The gauge was set only on the stale-**payload** branch, where CareLink serves a
payload that is itself hours old. The commoner condition — **every fetch
failing**, so no payload arrives at all — fires the STALE warning and the webhook
while the gauge still reads `0`.

A gauge reporting healthy while the watchdog is shouting is worse than no gauge,
and it is precisely the "flat green graph means nothing" failure the metric
exists to fix.

The predicate is now `decideStale()` in `src/stale-watchdog.ts`, called by
`checkStale()`. It is a separate module because `src/main.ts` is a top-level
script that starts a fetch loop on import and therefore cannot be unit-tested —
the same shape as the v0.4.0 gate defect, where the file that decides health was
the only one with no coverage.

`decideStale()` returns **`null`, never `false`**, when there has never been a
successful fetch: a null must not be read as "fine" (`/healthz` reports that case
as `degraded`), and a backwards clock step clamps to `0` rather than a negative
age that would never fire.

### Fix — the Docker compose file could never refresh a token

`deploy/nightscout-docker-compose.yml` bind-mounted `logindata.json` `:ro`.
`writeLoginDataAtomic()` writes a temp file and `rename()`s it over the
destination, and a rename onto a bind-mounted **file** is `EBUSY` regardless of
the `:ro`/`:rw` flag — measured on both, plus `EBUSY` on `unlinkSync` against the
`:ro` mount. So once the access token expired, every fetch failed with a bare
errno and the bridge never re-logged in, because the file was still sitting
there.

`deploy/README.md` was corrected in v0.4.0; the compose file it ships was not.
The mount is now commented out with the measurement attached, rather than
shipped as a line that looks harmless.

### Fix — `install.sh` contradicted itself

Its header comment said `Node.js >= 20` while the runtime check two lines below
correctly required `22.12`. The check was right; the comment was wrong, and it is
the one a re-reader sees first.

665 tests / 46 files. `npm run links:check` PASSED.

## [0.4.0] — 2026-11-14

**This release is validation-day readiness.** It is not a feature release: it is
the set of changes that make the bridge survive its first real CareLink payload,
and make every remaining wrong guess fail loudly instead of silently.

> **Nothing in this release was validated against a live CareLink account.**
> The bridge has still never talked to one. What shipped here is unit-provable
> only. The 780G is expected within the month, and after that first fetch every
> item below stops being a pull request and becomes a production incident.

The organising principle: every defect found was one of three shapes — a value
that defaulted to something plausible, a success reported without verifying the
effect, or a shape assumption that had never met the wire. 594 green tests had
proved nothing about the payload, because `src/main.ts` — the file that decides
whether a fetch succeeded — had **zero test coverage**.

### Fix — the v13 payload was rejected by the only gate that mattered

`src/main.ts` decided a fetch was valid with
`if (!data?.lastMedicalDeviceDataUpdateServerTime)`. The v13 `display/message`
route **never sends that field** — `src/transform/index.ts` said so in a comment,
and `test/ble-payload-shape.test.ts` built its v13 fixture by deleting it, so the
two halves of the bridge disagreed about the shape they handled.

Measured: the gate returned `false` for a payload that `transform()` converted
into 2 entries + 1 devicestatus + 1 treatment. On the exact device this fork's
v0.3 line targets, the bridge fetched good data, logged `Empty or invalid data
from CareLink`, incremented `failure`, uploaded nothing, and tripped the stale
watchdog. Now delegates to `isUsablePayload()` (`src/payload-shape.ts`), pinned
by `test/payload-gate.test.ts`.

### Fix — one meal became one Nightscout row per poll

`treatmentId()` hashes a marker's derived millisecond, and that millisecond
inherited whatever sub-slot residue the anchor carried.
`lastMedicalDeviceDataUpdateServerTime` is never slot-aligned (real fixtures
carry residues of 170,381 ms and 275,436 ms), so one physical meal at index 280
then 279, with 7 s of anchor jitter across two polls, hashed to two different
`_id`s:

```
poll1  carelink-marker-7890e2…  created 11:25:00.381Z
poll2  carelink-marker-5633cf…  created 11:25:02.881Z
```

Nightscout dedups treatments on `_id` alone, so each poll appended another row —
and its IOB/COB sums then counted that insulin and those carbs twice, in the app
people dose from. The anchor is now quantised to the 300 s slot in
`mapMarkers()`. `test/treatment-idempotence.test.ts` fails on the previous code.

### Fix — alarm severity now follows the vendor's own strings

The tiering was inferred from *group* membership: any non-critical vendor group
meant "delivery stopped". Measured against the vendor's own display strings, that
was wrong in both directions.

- **12 codes that are battery or notification messages fired a priority-1
  `[LastAlarm] Delivery stopped`** — `006 Pump Battery Out Limit`,
  `011`/`073 Replace Pump Battery Now`, `051 Bolus Stopped`,
  `062 New notification received from CareLink` and others. Added an `attention`
  tier: these still WARN, in the vendor's own words, without claiming basal has
  stopped.
- **`809`/`810` — "Suspend On Low. Delivery Stopped. Check BG" — were tiered
  `other`, i.e. silent by default.** They are the NGP-era suspend alarms and are
  exactly what a SmartGuard pump raises when it takes basal away.
- All 116 codes now carry the vendor's text. `ALARM_TEXT` previously disagreed
  with the vendor on every code it shipped.

Source: `https://carelink.minimed.eu/crm/ocl/15.5/i18n/ui/app/en.json` — 200,
`application/json`, 137,123 B, sha256 `a6b8180b87c022d6…`, byte-identical on
`carelink.minimed.com`, 63 `connect.ble.<code>` keys. This was **never
token-gated**; the research repo had recorded it as blocked on a clinician token
and that is now corrected there. `test/alarm-severity-vs-vendor-text.test.ts`
pins every code's text against the bundle.

Corrects a figure from the working notes: **10** codes carry the phrase "Delivery
Stopped", not 11. `024` is not one of them — it reads "Critical Pump Error. Stop
Pump Use. Use Other Treatment", which is stricter and tiers `stop_using_pump`.

### Fix — upload honesty, and a stale payload no longer counts as success

- A **200 with a non-array body reported the SENT count as stored.** Against a
  Nightscout behind a proxy/SSO answering `200 text/html` with a login page, the
  old code claimed success for a payload that was never written. It now throws.
- The POST had **no timeout** (axios defaults to none), so a stalled Nightscout
  blocked the fetch loop indefinitely. Now 30 s.
- A **stale payload was counted as a successful fetch**, which reset the very
  watchdog that exists to catch it — a pump that stopped syncing looked healthy.
  `transform()` now returns a stale verdict and the loop refuses to advance the
  success clock.
- The comment claiming the upload log reported what was *stored* was false:
  Nightscout's response is the request echoed back (`treatments.js:163` returns
  `objOrArray`; `devicestatus.js:159,170` returns `statuses` including copies it
  did not insert), so that branch is unreachable. Corrected rather than left as a
  comfortable lie in a medical-data path.

### Fix — glucose readings that were silently dropped or mis-ordered

- **`kind` was a guess.** `sgv.kind !== 'SG'` dropped the reading, but `kind` has
  never been observed on `display/message`. Measured: no `kind` → 0 entries;
  `kind: "sg"` → 0 entries. A total, silent glucose outage from a field-name
  assumption. Absence is now accepted; only a *known* non-SG token (`CAL`,
  `BG`, …) is rejected.
- **SGV order was never normalised.** On a descending payload the trend was
  attached to the *oldest* reading, and `.slice(-limit)` kept the oldest `limit`
  readings and discarded the newest. Measured with limit 2: kept `[100, 90]`,
  dropped `200`. Now sorted ascending, with the trend gate moved onto the newest
  *slot* so a trailing `sg: 0` sentinel still suppresses it.

### Fix — the Nightscout fields consumers actually read

- **Loop was discarding every treatment this bridge uploaded.** LoopKit's
  `NightscoutTreatment.init?` is failable and requires `entry["timestamp"]`,
  which Nightscout never synthesises. The bridge emitted `created_at` only, so
  every meal, bolus and carb correction returned nil — a Loop user saw a CGM with
  no insulin history. AAPS masked it by falling back
  `date ?: mills ?: timestamp ?: created_at`.
- **Loop also discarded every `BG Check`** — `BGCheckNightscoutTreatment` requires
  `units`, now emitted as `mg/dL`.
- **`pump.status.suspended` is now published** — the ONE suspend field Nightscout
  renders. `pump.js` `updateStatus()` reads it as a **boolean** and, with
  `prefs.warnOnSuspend` on, raises a real Nightscout WARNING ("Pump Suspended").
  The bridge previously wrote only `autoMode.suspendFired`, which returns zero
  hits anywhere in that repo. Set from `medicalDeviceSuspended === true` or
  `suspendFired === true`; absent otherwise, never asserted as "Normal".
- **devicestatus now carries a deterministic 24-hex `_id`**, so re-sends dedupe.
  Without one Nightscout ran `insertMany` on every POST, and the recency filter is
  in-memory, so every restart re-inserted too — ~288 docs/day of growth.

### Added — observability that can actually go red

`/healthz` returned `200 {"status":"ok"}` unconditionally: circuit open,
never-succeeded, twelve hours stale — all "ok". The Docker `HEALTHCHECK` and any
uptime monitor could detect a dead *process* but never a bridge that had silently
stopped receiving data. It now returns 503 for anything but healthy:

```
healthy         HTTP 200  status=ok        staleFor=null
stale 40min     HTTP 503  status=stale     staleFor=2400
circuit open    HTTP 503  status=degraded  staleFor=null
never succeeded HTTP 503  status=degraded  staleFor=null
```

A separate `liveness` field keeps "container up, data dead" distinguishable from
"container down". New metrics, all with closed label sets: `carelink_data_age_seconds`
(age of the newest READING, not of the fetch — a successful fetch of an hour-old
payload looked identical to a fresh one in every other counter),
`carelink_upload_failures_total{endpoint,reason}` where `discarded` is its own
reason for the 200-that-stored-nothing case, and the `carelink_stale` gauge.
`incTokenRefresh` had **zero call sites** in `src/` while being documented in
USER-GUIDE.md and rendered in the exposition — a panel that could never move. Now
wired, and verified moving.

### Changed — the Node contract

`engines.node` was `>=20.0.0`. `puppeteer-core@25` is a **runtime** dependency
(imported eagerly by `src/login.ts`, which `src/main.ts` imports) and requires
Node ≥ 22.12, so advertising Node 20 was a false claim: it produced `EBADENGINE`
warnings on every CI run and hard-fails under `--engine-strict`. Node 20 also went
EOL 2026-04-30. Floor is now `>=22.12.0`, matrix `[22, 24]`, and
`deploy/install.sh` compares major *and* minor (a major-only check accepted
22.0–22.11, which the dependency also refuses).

ADR 0007 claimed Node 20 "cannot run the suite". It can — CI ran 594 passing
tests on 20.20.2 on every push. Amended with the correction stated and the
original text kept.

### Changed — release plumbing

- **A tag push ran no workflow at all.** `ci.yml` triggers on branches only, so
  tagging was the one moment nothing was checked — the release object was a
  hand-typed string on a commit nothing re-verified. New
  `.github/workflows/release.yml` asserts: tag is semver, `package.json` **and**
  `package-lock.json` agree with it, the commit is an ancestor of `main`, a
  non-trivial CHANGELOG section exists, then typecheck/test/build, then
  `gh release create --notes-file`.
- `"private": true` — the name `carelink-bridge` is unclaimed on npm, and
  `npm pack` shipped 113 files with **zero from `dist/`** while `main` pointed
  at `dist/index.js`.
- CI: `permissions: contents: read`, a concurrency group (v0.3.1's branch ran a
  full duplicate matrix three times in twelve minutes), timeouts, `npm run build`
  (the artefact operators actually run was never built in CI), and a
  package.json-vs-lockfile version assert — the one release step `npm ci` cannot
  catch.

### Fixed — documentation that would strand the reader

- **`docs/validation-day-instinct.md` was inoperative as written.** Its whole
  procedure depends on three log lines that are all verbose-only, gated by
  `CARELINK_QUIET`, which defaults to `true` — and the document never mentioned
  it. A reader following it exactly saw an empty journal. Also had two undefined
  shell variables (`$NS`, `$HASHED`) in its final `curl`.
- `USER-GUIDE` recommended `apt install nodejs`, which ships Node 18 on every
  Debian/Ubuntu/Pi OS stable and is now refused by the installer; and recommended
  nvm, which cannot work against a unit hardcoding `ExecStart=/usr/bin/node`
  (fails `203/EXEC` with nothing naming the cause). `.env` now explicitly
  `chmod 600`.
- `deploy/README` said to run `npm run login` from `deploy/`, where there is no
  `package.json`. It also advertised `npm run doctor` as a deploy gate, but a
  missing `logindata.json` exits **0**.
- Both `.env` templates were missing keys the other had.
  `CARELINK_ASSUME_TIMEZONE` is the one that bites: absent it, an unzoned
  reading is parsed as UTC and a UK user in BST gets every value shifted an hour,
  with a warning that is invisible at default verbosity.
- ROADMAP had no `v0.3.1` row and still claimed `package.json` read `0.3.0` —
  the same drift the 0.3.1 doc sweep was meant to kill.

657 tests / 45 files. `npm run links:check` PASSED.

## [0.3.1] — 2026-11-12

### Fix

**`docs/validation-day-instinct.md` told readers to publish their pump serial
number.** The guide described the device-identity log line as *"redacted"* and
then instructed *"Copy it verbatim into the issue."* It is not redacted:
`DEVICE_IDENTITY_KEYS` in `src/carelink/client.ts` includes
`deviceSerialNumber`, and the snapshot prints raw values. Anyone following that
page during validation day would have pasted a persistent hardware identifier
into a public GitHub issue.

The page now states plainly that the line is NOT redacted, names the key to
remove, and the source comment no longer justifies the behaviour with *"a device
family name is not a secret"* — true of the family names, false of the serial in
the same array. The code change is comment-only; no behaviour changed.

This is a **patch release rather than an edit to v0.3.0** on purpose: the
defective instruction is inside the v0.3.0 tag, and moving a published tag would
rewrite what an existing release points at. The correction ships forward.

### Everything else in this release is documentation

Sixteen prose files were audited against the running code and corrected. Notable
among them: every "what it uploads" description that predated treatments and
auto-mode; `npm run doctor`'s output symbols and closing line; two error messages
that were never emitted; "both version numbers should be 20 or higher" (only
Node's is — npm is 11.x on Node 24); the access-token lifetime, which is
refreshed inline rather than ~30 days in the background; `BLE_API_VERSIONS`
listed as `[13, 11, 6, 5]` when it is `[13, 12, 11, 6]`; SECURITY.md's "no
inbound network listeners", false since the loopback metrics server landed; the
module map, which omitted six modules; the test table, which omitted 17 of 40
files; and ROADMAP's v0.2.0 row, which credited that tag with work that landed
five days after it.

One correction went the other way. A draft audit claimed the write path's
symlink protection was unimplemented. It is implemented — `fs.renameSync` replaces
the directory entry rather than following the link, verified by replicating the
syscall sequence against a symlinked file. ADR 0003 now explains the mechanism
accurately instead of saying the write "refuses", which it does not: it silently
replaces, and an operator who symlinked the file into a backup directory should
know that.

594 tests / 40 files. `drift:check` 85 passed, 0 failed.

## [0.3.0] — 2026-11-12

**This release is the one that carries the pump data.** Before it, the bridge
reached Nightscout as a CGM with no insulin history: `markers[]` — every meal,
bolus and fingerstick — was parsed and thrown away. It also pulled the
observability and reliability work that had merged but was never tagged
(v0.3.0/v0.4.0 in `ROADMAP.md`), which is why this release closes both.

Headline changes:

- **Pump events become Nightscout treatments** — `markers[]` → `Meal Bolus`,
  `Correction Bolus`, `Carb Correction` and `BG Check`, with a deterministic
  `_id` so CareLink's rolling re-send updates rather than duplicates (#123).
- **SmartGuard auto-mode becomes devicestatus** — `therapyAlgorithmState` →
  `pump.autoMode` with `shieldState`, `plgmState` and `suspendFired` (#123).
- **Alarm tiering corrected against the vendor's own table** — the model had
  been built from a third-party dictionary and left **53 of the vendor's 73
  codes** logging at INFO instead of raising the WARN (#128).
- **Circuit breaker, persistent state, structured logs, `/healthz` + `/metrics`**
  — merged earlier, released here.

594 tests across 40 files. `npm run drift:check` green: 85 vendor assertions, 0
failed. The entries below carry the full detail.

### Publish pump events as Nightscout treatments, and SmartGuard auto-mode as devicestatus (#123)

Before this change the bridge posted two Nightscout documents per fetch —
`entries` and `devicestatus` — and silently discarded `markers[]`, which is where
CareLink puts every meal, bolus and fingerstick. A working pump therefore reached
Nightscout as a CGM with no insulin history. The research repo calls this the
single largest "available but unused" gap, and `ROADMAP.md` had it deferred
until "a real pump arrives".

**That blocker was wrong.** Both this and `therapyAlgorithmState` were recovered
from the vendor's own client parser, which is a published description of the
response the app receives — two unauthenticated `GET`s of a JS bundle, not a
pump. The reason four months of searching found nothing is structural: the
pump-data parser lives **entirely in one lazy chunk**, and **21 of 24** pump-data
tokens are zero in the hash-pinned eager bundle the repo had been reading
(`carelink-api-research` area DP).

Added:

- `src/transform/treatments.ts` — `markers[]` → Nightscout treatments.
  - A `MEAL` and its `INSULIN` at the same `index` become **one `Meal Bolus`**
    carrying both carbs and insulin; an unpaired `INSULIN` is a
    `Correction Bolus`; a meal with no bolus is a `Carb Correction`.
  - `BG_READING` / `BG` / `CALIBRATION` become `BG Check` with
    `glucoseType: 'Finger'`.
  - Marker times are derived as `anchor − (287 − index) × 300_000 ms`. **A
    marker array with no usable anchor is refused, not dated** — emitting
    `Date.now()` there would stamp every historic meal with the fetch time,
    which is the same defect this bridge already carries a correction for on
    the CGM path.
  - `_id` is a deterministic hash of `(time, eventType, carbs, insulin)`, so
    CareLink's rolling 24 h re-send **updates** rather than appending a
    duplicate meal every poll.
  - `AUTO_BASAL_DELIVERY` and `AUTO_MODE_STATUS` are **counted and logged, not
    mapped**: the vendor's own client never handles them either, so inventing a
    treatment shape would be fabrication.
- `therapyAlgorithmState` → `devicestatus.pump.autoMode`, carrying
  `shieldState`, `plgmState` and a derived `suspendFired` boolean.
  `plgmLgsState` is the Low-Glucose-Suspend state — `SUSPEND_FIRED_PLGM` /
  `SUSPEND_FIRED_LGS` mean the pump has stopped delivering. Values pass through
  verbatim because the vocabularies were recovered from the parser, never from a
  captured payload, so an unrecorded value is possible and is data rather than
  corruption.

**The alarm safety contract is unchanged and still enforced.** Several NGP codes
mean *"Critical Pump Error. Stop using pump"*; those must never be auto-published
as treatments. The guard in `test/last-alarm.test.ts` was written as a blanket ban
on the string `treatments` in `src/`, which was correct while nothing posted
there. It is now **scoped to what it protects**: a reviewed list of files that may
mention treatments, plus assertions that none of them carries an alarm into one
and that the mapper is blind to alarm fields. Plant-tested — adding an alarm read
to the mapper fails the suite.

### Correct the device-family matcher against Medtronic's published vocabulary (#95)

Medtronic publishes the complete device-family vocabulary, unauthenticated, at
`GET /patient/v2/configuration/public` — the same host the bridge already talks
to. #93 added the six Minimed Flex *model* prefixes and, alongside them, guessed
the family token as a `FLEX` substring match.

The published document settles it: `personal.device.family.to.model.mapping`
lists sixteen families, and `system.settings.transfer.feature.config.device.mapping`
independently maps `"CC880"` to the display name `"MiniMed™ Flex"`. So **CC880 is
the Flex family**, and the six models #93 added do appear under it.

- `isBleDevice()` now matches the exact published token `CC880`, so a
  **family-only** payload — the hard case, since `monitor/data` returns
  `deviceFamily` while `medicalDeviceFamily` is undefined on the patient path —
  is detected without relying on `deviceModel` being present. Before this, a
  `CC880` payload returned false and reproduced #91's silent zero-data fetch.
- The `FLEX` substring match is **kept**, as a fallback for the display-name
  spelling the vendor also publishes (`"Minimed™ Flex"`), on the same reasoning
  that `SIMPLERA_SYSTEM` may arrive as `"Simplera™ system"`. Audited against all
  sixteen published families: none contains `FLEX`, so no real device is
  misrouted today. Detection of `CC880` never depended on it — that token has
  no `FLEX` in it. The residual looseness (a substring match also accepts
  nonsense like `REFLEX`) is documented rather than eliminated, and is not
  pinned as a contract, so a later contributor can tighten the matcher.
- **New test pins the whole published vocabulary** — all sixteen families, each
  with its expected verdict and a stated reason. `CC840`, `EAGLE`, `GST`, `NMX7`,
  `NMX8`, `GM` and `INSTINCT` are deliberately left unmatched: nothing confirms
  they are BLE-paired, and routing a non-BLE device down the BLE endpoint is its
  own silent failure. The table exists so that a family Medtronic adds later is a
  decision someone makes, rather than a gap that surfaces weeks later as "the
  bridge uploaded nothing".

Caveat, unchanged: this is Medtronic's published *configuration*, not an
observation of a `monitor/data` response. It establishes the vocabulary, not
which field carries it or in what casing. #81 stays open until a token confirms.

### Minimed Flex detection (#91)

- The Flex (MMT-8062/8063/8082/8083/8084/8085, "Minimed Flex") is now
  BLE-detected by model prefix and by the `FLEX` family token. Reported
  live upstream (domien-f/carelink-bridge#3): silent zero-data fetch after
  a 780G-to-Flex upgrade, the exact failure mode of undetected BLE. Both
  spellings are INFERRED from Medtronic's portal bundle, unverified on
  the wire.
- The `FLEX` match is deliberately a substring test, unlike the `BLE`
  token (prefix-only, since `BLE` is a substring of ordinary words).
  Audited: `FLEX` is not a substring of any other known family value.
  The reasoning is recorded next to the code so a future reviewer does
  not "fix" it back.
### Test-infra and logger/config safety (#87, #88, #89, #90)

- [#87] — CI now typechecks `test/` too, via `tsconfig.test.json`. Previously
  neither `npx tsc --noEmit` nor CI could see a type error in any test file —
  which is how a TS2322 in a test went unnoticed. The override has to restate
  both `include` and `exclude`, because the base config excludes `test/`, and
  it sets `rootDir: "."` because the base sets `rootDir: "src"`. Verified by
  injecting a type error into a test file and watching CI's new step fail.
  Clean today, so this only stops the next one.
- [#88] — `logger.ts` redaction widened to `authorization` / `bearer` /
  `api-key` / `credentials` / `passwd` / `cookie` spellings and made recursive:
  sensitive keys are redacted at any nesting depth, through objects and arrays.
  Cycles terminate (`[CIRCULAR]`); a *shared* reference is rendered once per
  occurrence, because only the current ancestor path is tracked — not every
  object seen. Non-plain values (`Date`, `Error`, `Buffer`) pass through
  untouched rather than being flattened to `{}`. Plus the module's first direct
  test coverage: every sensitive spelling, nested redaction, shared-reference
  and array-of-array shape, cycle survival, 2000-deep nesting, benign fields
  untouched, both formats, gating, and the JSON record shape. The walk reads own
  enumerable keys with no prototype check, so class instances and cross-realm
  objects are redacted too, and it neutralises the ways a value can smuggle
  itself past the walk:
  - functions are dropped, and an **inherited** `toJSON` is replaced — the
    `#private`-field class whose `toJSON` returns its secret has no own keys,
    so `JSON.stringify` would otherwise invoke it after redaction;
  - a throwing getter or `ownKeys` trap — including a `toJSON` getter — yields
    `[UNREADABLE]` instead of
    propagating out of `warn()`, which matters because `warn()` is called from
    error handlers;
  - nesting past 100 levels yields `[MAX_DEPTH]` rather than a `RangeError`;
  - a typed array is handed to `JSON.stringify` intact, but a NON-index own
    key attached to one is redacted like any other field — a bare `Uint8Array`
    has no `toJSON`, so JSON.stringify would otherwise emit it verbatim;
  - a payload `JSON.stringify` rejects (BigInt) degrades to
    `log_stringify_error` **while keeping `ts`/`level`/`msg`** — a bare error
    flag with no level and no message is untriageable, which is the one moment
    the log matters;
  - `Buffer`/typed arrays pass to `JSON.stringify` intact instead of collapsing
    to `{"0":117,...}`.

  Key-NAME matching remains best-effort, and the legacy `log()` helper takes
  positional arguments rather than a fields object so it does not redact at
  all — both now stated in USER-GUIDE rather than implied away.
- **Docs corrected rather than left absolute**: the "secrets are never emitted"
  line in USER-GUIDE, "no PII" in the ARCHITECTURE module map, and the
  `npx tsc --noEmit` verification step in both ARCHITECTURE and CONTRIBUTING
  (now `npm run typecheck`, which is what CI runs) all overstated what the code
  does. `.env.example` documents the `CARELINK_QUIET` coercion too.
- [#89] — first direct coverage for `src/config.ts`: required-var errors,
  safety-relevant defaults, `LOG_FORMAT` fallback, and the `CUSTOMCONNSTR_`
  fallback. The `CARELINK_QUIET` truthiness table is pinned as current
  behaviour, and the guide row now says plainly what that behaviour is: only
  the literal `false` turns verbose logging on, so `0`/`no`/`yes` mean quiet
  and an empty value counts as unset.
- [#90] — documented that verbose mode logs the full upload payload: the
  `CARELINK_QUIET` settings row and the `LOG_FORMAT` row now say so, and
  `src/nightscout/upload.ts` carries the warning. Deliberate debug facility,
  silent by default — documented, not removed.


### Payload-schema typings (#82, #83, #85)

Three fields the `RecentData` payload carries, taken from the reference
client's model classes (**INFERRED** from third-party source — unverified
on the wire):

- [#82] — `pumpBatteryLevelPercent`: the transform now prefers it over
  `medicalDeviceBatteryLevelPercent`, falling back only when it is 0 or
  absent (mirroring the reference client's `getDeviceBatteryLevel()`).
  Previously a device reporting only the new field surfaced 0% battery.
  Older devices sending only the medical-device field are unchanged.
  Both values are also passed through on the `connect` mirror.
- [#83] — `reservoirLevelPercent`: typed on `CareLinkData`. The Nightscout
  `pump.reservoir` output deliberately keeps using the units fields
  (`reservoirRemainingUnits ?? reservoirAmount`), because the percent is
  quantised, the units are rounded, and downstream looping clients read
  the units value. Removed from the ROADMAP's pump-gated deferred list:
  the blocker was a missing type, not a missing pump.
- [#85] — `sensorState` and `relativeOffset` typed per-reading on
  `CareLinkSG`. Typing only: the transform does not consume them yet, and
  SGV timestamp semantics are unchanged. `relativeOffset` is recorded as
  the natural input for the whole-hour pump-offset rounding — that
  investigation is a separate change, not this one.

### 2026-10-08/09 research pass (previous entry, retained)

A research pass into CareLink's live API surface, followed by the fixes
it produced. The branch is one squashed commit carrying both the code and
the documentation changes, so this entry covers both.

The underlying evidence for this pass — and every claim in it — is filed in
the sister research repo,
**[NovaLux12/carelink-api-research](https://github.com/NovaLux12/carelink-api-research)**
([start with the map](https://github.com/NovaLux12/carelink-api-research/blob/main/docs/00-summary-the-map.md),
dated findings in
[`findings-log/`](https://github.com/NovaLux12/carelink-api-research/tree/main/findings-log)).
That repo is re-verified continuously, so a drift found after this entry
should be reported there, not here.

Every CareLink fact below was verified live on 2026-10-08 unless it is
labelled **INFERRED** (from a third-party client or Medtronic's own
published assets) or **UNVERIFIED** (needs a real CareLink credential).
For orientation, the code changes this pass produced, one line each:

- [#73] — case-insensitive, normalised BLE family matching that also
  reads `deviceModel` / `sensorModel`, with the portal's model table
  documented as an offline fallback.
- [#74] — dual data-host fallback for the legacy `connect/data`
  endpoint: configured host first, sibling second, the first 200 with a
  non-empty body wins, and the configured host's error is re-thrown when
  every candidate fails.
- [#75] — the discovery pin guard now gates on the cumulus track rather
  than on the mere presence of the `Auth0SSOConfiguration` key, and fails
  closed when `baseUrlCumulus` is absent.
- [#77] — the `certificates[]` change tripwire plus the header
  documentation. Recording and asserting the live `x-cum-signature` value
  is **deliberately deferred** — see
  [ADR 0002](./docs/adr/0002-discovery-app-version-pin.md).

Behaviour changes in this pass, stated plainly (both are intended and
tested — "nothing changes" holds only for configurations that return
data, which are byte-identical):

- **CP entries without `baseUrlCumulus` now fail closed at discovery.**
  `selectAuth0ConfigUrl()` throws `NoAuth0SSOConfigurationError` instead
  of resolving the URL when the entry carries no (or a non-string)
  `baseUrlCumulus`. No live probed document does this — the field is
  present on every document probed (android/1.0 … 10.0, both hosts,
  VERIFIED live 2026-10-09) — so this changes nothing that returns data
  today, and turns a future shape change into a named error instead of a
  silent resolve. ([#75])
- **A configuration that returns an empty body now spends one extra
  request on the sibling host.** A configuration that returns data is
  unchanged (exactly one request, sibling untouched); when the
  configured host answers `200 + {}` — exactly what
  `msgType=last24hours` returns for a pump with no data in 24h — the
  legacy branch now tries the sibling host before answering. ([#74])

What follows is what the probe established and where it is now written
down.

The CareLink facts below come from a read-only, unauthenticated, low-rate
probe (~500 requests, no credentials, nothing written to Medtronic) — the
2026-10-08 sweep, which is what "verified live" refers to. "401 / 403"
means *the path exists*; that is all a token-less probe can establish.
A few statements rest instead on Medtronic's public portal bundle, on a
third-party client, or on the 2026-10-09 re-probe, and those are labelled
**INFERRED** / **UNVERIFIED** or re-dated where they appear.

### Changed

- **Discovery version matrix corrected** — the matrix in
  `src/discovery.ts` and
  [ADR 0002](./docs/adr/0002-discovery-app-version-pin.md) was a partial
  subset recorded 2026-07-19. The live matrix is **23 cells, all HTTP
  200**, and the enumeration is **open-ended** (`android/10.0` still
  returns 200), so the table is a snapshot rather than a bounded set.
  `android/3.5` now returns
  `UseSSOConfiguration=Auth0SSOConfiguration` but sits on cumulus
  **v11** — a near miss, not a fallback. `android/3.1` is cumulus
  **v6**, a track nobody had recorded. `android/3.9` and `3.10` are new
  cells. **3.6 / 3.7 / 3.8 remain the only cells that are Auth0 *and*
  cumulus v13**, so the `android/3.6` pin is unchanged and still
  correct. ([#78])

- **The discovery URL documented as two orthogonal axes** —
  `/connect/carepartner/{basePath}/discover/android/{version}` varies on
  the base path (which **tenant**) and the app version (which
  **cumulus**) independently. `v11` is not "an older API": it serves the
  **trials** tenant, with all three regions (US, EU, CLINICAL) pointing
  at `*-trials` hosts and `baseUrlCumulus` at `…trials…/v13` for every
  region. `v13` is the patient API; `v12` is 401 and `v14`–`v20` are 403.
  The eu/com split in `buildDiscoveryUrl()` is recorded as
  **effectively cosmetic**, because `clcloud.minimed.eu`, `.com` *and*
  `clcloud-trials.minimed.com` return a byte-identical document (same
  sha256, differing only in the `x-cum-signature` header) that carries
  all three regions — `login.ts` picks one by `region`. ([#78])

- **ADR 0002's "What reverses it" rewritten, and the guard it asked for
  now exists** — a guard that checks only the presence of the
  `Auth0SSOConfiguration` key is a **silent pass**: the selector exists
  on `android/3.5`, which is a v11 cell and therefore unusable, so
  bumping the pin onto it produced a healthy-looking login and a nameless
  failure at the data call ([#75]). Any guard, comment, or test that
  protects the pin must also check the **cumulus track** —
  `baseUrlCumulus` **ending in** `/connect/carepartner/v13`; a substring
  check on `/v13` would admit `.../v131` — not merely the presence of the
  config key.
  `selectAuth0ConfigUrl()` in `src/login-errors.ts` now asserts the v13
  track and fails closed when `baseUrlCumulus` is absent. ([#78], [#75])

- **Live CareLink API surface documented** in
  [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#live-carelink-api-surface)
  — host families (which are the patient API, which are not), the
  metadata-vs-data host split, and the three live namespaces.
  `carelink.*` serves the `/patient/*` metadata; `clcloud.*` serves the
  `/connect/carepartner/*` data and answers 403 for most `/patient/*`
  paths; `commoncore.medtronic.{eu,com}` is the **reports** API on
  **`medtronic.eu`, not `minimed.eu`** — which is why sweeps limited to
  `*.minimed.*` never found it. `carelinkhp.minimed.eu` is an Angular
  SPA, not an API; `commoncore.minimed.*` is a *different* host and
  currently 502. ([#78])

- **Region naming documented as three-way** — the discovery `CP[]`
  entries say `EU`, country-settings says `OUS`, and the SSO
  `client.audience` says `carepartner.patient.ous`. Three names, one
  tenant. `MMCONNECT_SERVER=EU` and `resolveServerName()` match the
  discovery naming, which is consistent but easy to miss. ([#78])

- **README disclaimer tightened** — the intro no longer claims the bridge
  logs in "the same way the official CareLink app does". That holds for
  the **data** leg only: the official app's identity leg is
  `/api/carepartner/v2/*` (the `baseUrlCareLink` its own discovery
  document declares), while this bridge calls bare `/patient/*`. Both
  answer 401 unauthenticated, so which one returns data with a valid
  token is **unverified**. ([#78])

- **Unauthenticated `/patient/*` endpoints documented** —
  `/patient/configuration/system/personal.cp.m2m.enabled` answers 200
  with no credentials and no headers, on `carelink.*` only (`clcloud.*`
  403s the same path). Nearby siblings
  (`…mobileEnabled`, `…device.ble.enabled`, `…uploaderAllowed`,
  `…cgm.ioxEnabled`) all 404, so it is one exposed key, not a wildcard.
  The bridge does not call it, and a 401 on it must not be treated as
  fatal. `/patient/countries/settings` is also public and is already
  relied on for `blePereodicDataEndpoint`. ([#79])

- **Device identification documented** — the API returns `deviceModel`
  and `sensorModel` (sentinel `"NO_SENSOR"`) alongside the
  `deviceFamily` / `medicalDeviceFamily` strings. Only the `*Family`
  strings reach the Nightscout payload (`src/transform/index.ts`); the
  model fields are consumed for BLE endpoint selection only.
  Model-code tables from Medtronic's own portal bundle are recorded as a
  **fallback** only, because the live `deviceModelMapping` /
  `deviceToFamilyMapping` is server-driven and must not be hardcoded.
  **Unverified (vendor bundle, not a wire observation):** the bundle
  defines `SIMPLERA_SYSTEM = "Simplera™ system"`, a mixed-case display
  string, so family matching normalises both sides instead of doing a raw
  `includes()`. ([#78])

- **`/connect/pde/v3/*` is 403, not 401 — a correction of a correction** —
  the original 2026-10-08 probe returned **403**
  `{"message":"Missing Authentication Token"}`; the research note then
  recorded it as 401; and a later review round "corrected"
  [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) from 403 (right) to
  401 (wrong) by trusting the note rather than re-probing. **Re-probed
  twice on 2026-10-09: 403, identical both times.** The distinction is
  load-bearing for this doc: on `clcloud.*` a 403 with that body is a
  **gateway-level rejection** (the host does not route the path to a
  CareLink-app auth check at all), which is a different thing from the
  app-level **401 `{"error":{"type":"InvalidToken","group":"AUTH"}}`**
  the bridge's own endpoints return. `/patient/users/me` on `clcloud.*`
  behaves identically to `pde/v3`. ([#78])

- **Pre-pump watch recorded as unchanged** — all 109 country-settings
  entries swept: `defaultDevice` is still `GM` in all 108 real
  countries, `uploaderAllowed` is still true everywhere,
  `cpMobileAppAvailable` is present in 72/109 with **only AU `true`**,
  and 37 entries (GB, IE, NZ, SA, KR and others) do not carry the key at
  all — *unconfigured*, not "not yet available". One of the 109
  "countries" is `CLINICAL`, a pseudo-region. ([#78])

### Added

- **Reports-API lead for the deferred fixtures** —
  **NOT YET ACHIEVED. NOT INTEGRATED. Token-gated.**
  `commoncore.medtronic.{eu,com}` serves CSV + PDF reports over the same
  account; country-settings advertises 11 `supportedReports` and
  Medtronic's portal bundle enumerates 14 — the same 11 plus three
  portal-only types, `PATIENT_DASHBOARD`, `DATA_TABLE` and
  `SETTINGS_HISTORY` (sources Pump / Sensor /
  Meter; periods 0/14/30 days and 2–12 months). Recorded as a candidate
  source for the v0.2.0 deferred 780G fixtures, and if it is ever wired
  in it must stay **opt-in and off by default**. ([#76])
- **"Pre-pump authenticated checks" section in [ROADMAP.md](./ROADMAP.md)** —
  the two cheapest token-bearing checks are `npm run login` end-to-end,
  then `GET /api/carepartner/v2/users/me` against
  `GET /patient/users/me` on the same account and token.

### Notes

- **Verified vs inferred, explicitly.** Status codes, the 23-cell
  matrix, the two-axis base-path behaviour, the byte-identical
  discovery document, and the country-settings sweep are all
  **live-verified** 2026-10-08. The device tables, report catalogue and
  `hcp/*` map come from **Medtronic's own public portal bundle** — a
  public asset fetched without auth, but not a wire observation. The
  claim that `clcloud.*/patient/connect/data` is *needed* for EU
  accounts comes from a **third-party client** (xDrip+ PR #3859) and is
  labelled **inferred / unverified** everywhere it is used; it is why
  the sibling host is tried as a *fallback* (configured host first) and
  not as a switch.
- A hardcoded key present in the vendor's public bundle is
  **not reproduced in this repository**; it is tracked privately with
  the probe notes.
- Internal-only hostnames found during passive certificate-transparency
  enumeration are deliberately **not** recorded in this repo — they
  carry no operational value for this bridge and are reconnaissance
  data.
- Two probes, one disagreement, **settled on 2026-10-09**: the
  2026-10-08 pass recorded the `Auth0SSOConfiguration` key present on
  every version probed, which was a probe artifact (a `//` fallback
  returning the truthy string `"-"`). The 2026-10-09 re-probe found the
  key **absent** on the v2/v11 cells, which carry the legacy
  `SSOConfiguration` key instead. It does not change the design —
  `android/3.5` resolves an Auth0 URL on a v11 entry under either
  reading, so a resolved URL proves nothing about the data-plane track.
  [ADR 0002](./docs/adr/0002-discovery-app-version-pin.md) carries the
  settled record; the header comment in `src/discovery.ts` states the same
  position.

## [0.2.0] — 2026-07-22

### Added

- **Atomic 0600 `logindata.json` write** — `writeLoginDataAtomic` in
  `src/carelink/token.ts` opens the temp file with `O_CREAT|O_EXCL|O_WRONLY`
  and `mode(0o600)`, fsyncs, then renames atomically. Closes the
  world-readable window between temp create and chmod that umask-022
  boxes had. `tightenLoginDataIfLoose` runs on the `loadLoginData` read
  path so an older bridge with a pre-existing 0644 file is closed
  without a one-shot migration step.

- **P0.1 mmol/L safety** — `src/transform/index.ts` detects
  `bgunits`/`bgUnits` of `MMOL_L` (with casing fallbacks) and converts
  `sg` to mg/dL at the SGV assignment site via
  `Math.round(sg * 18.0182)`. Without this, a mmol/L CareLink
  account flowing into Nightscout is interpreted as mg/dL by
  downstream looping clients (Loop, xDrip, AAPS) and over-delivers
  insulin. Asserted numerically: `5.5 mmol/L → 99 mg/dL`,
  `2.0 → 36`, `22.2 → 400`.

- **P0.2 lastAlarm policy** — `src/last-alarm.ts` plus
  `NightscoutLastAlarmAnnotation` in `src/types/nightscout.ts`. CareLink
  alarms surface as `devicestatus.last_alarm` with
  code/datetime/text/severity. Priority-1 codes (paradigm
  delivery-stopped 4/5/6/16/43/61) hit `console.warn` always-on,
  irrespective of verbose mode. **No alarm relay to Nightscout
  `/api/v1/treatments.json`** — verified by an absence-grep test over
  `src/`. NGP-tier codes are intentionally empty pending a
  sanitised 780G fixture.

- **forceRefresh successive-401 regression fix** — `authenticate()`
  now returns `Promise<boolean>` (true iff `refreshToken` actually
  ran). `fetch()` only clears `forceRefresh` when authenticate did NOT
  refresh. The pre-fix code re-sent a dead token across consecutive
  401s because the flag was unconditionally reset every iteration.
  The successive-401 test pins the fix: a 401 immediately after a
  successful refresh+401 still triggers a second `refreshToken`
  call.

- **P3 trend `NONE` → `{trend: 4, direction: 'Flat'}`** — matches
  Nightscout convention and every other CGM source's flat (xDrip,
  nightscout-connect). Tested against the real `missingLastSgv`
  fixture in `test/samples.ts` (with the trailing sg=0 entry
  dropped at the test site so the production guard for "trend
  attaches only when the most recent SG is real" is honoured).

- **`NoAuth0SSOConfigurationError` named class +
  `selectAuth0ConfigUrl` helper** — the named error is
  grep-distinguishable in journald. The helper throws it on missing
  `Auth0SSOConfiguration` in the discovery entry, carrying the
  diagnostic context (region, appVersion) for operators. The
  helper's behaviour is tested directly against a synthetic
  `DiscoveryCpEntry` shaped like the v3.4 / v4.0 no-Auth0 tracks.

- **Discovery pinning** — `DISCOVERY_APP_VERSION` and
  `buildDiscoveryUrl(isUS)` extracted into `src/discovery.ts`. The
  version string and the URL template
  (`/connect/carepartner/v13/discover/...`) are testable
  constants; a future contributor who edits either cannot
  silently regress the bridge to a no-Auth0 track (3.4 / 4.0).

- **Refresh-failure classification** — `isPermanentRefreshFailure`
  predicate in `src/refresh-failure.ts` distinguishes permanent
  (HTTP 400 + `invalid_grant` / `invalid_client`) from recoverable
  (5xx, 429, transport, anything not matching the OAuth contract).
  The catch in `authenticate()` is split: one try for
  `refreshToken` (classified), one for `writeLoginDataAtomic`
  (always retain + rethrow so a local disk failure doesn't nuke
  the token). 18-test suite covers the three behaviours plus
  defensive defaults (null, undefined, plain Error, etc.).

- **Status-aware capped exponential backoff with jitter, honour
  `Retry-After`** — `decideRetry` in `src/retry-policy.ts`
  classifies each failed attempt: permanent 4xx fail fast, 429
  honours `Retry-After` (numeric or HTTP-date) up to a cap, 5xx
  and transport errors retry with full-jitter exponential backoff
  (capped). The pre-fix fixed 2s/4s/8s path is replaced. The
  401/403 path is short-circuited before `decideRetry` so the
  existing force-refresh cycle still runs. Two integration
  tests pin the wiring: 429 + `Retry-After: 25` — advance 10s,
  assert no retry (the fixed 2s/4s/8s path would have retried
  here); advance 20s more, assert the retry fired. 404 — one
  call, not three.

### Changed

- The systemd unit now uses systemd's `%h` specifier instead of a hardcoded
  home-directory path, so it is portable across machines and accounts with no
  editing — install into `~/carelink-bridge` and it resolves to the running
  user's home. (This also removes the maintainer's own paths from the shipped
  artifacts.)

### Removed

- **`CARELINK_MAX_RETRY_DURATION` env, the `Config.maxRetryDuration`
  field, the `CareLinkClientOptions.maxRetryDuration` field, and
  the `DEFAULT_MAX_RETRY_DURATION` constant** — the option had no
  defined unit, the fetch loop never honoured it, and the fix-path
  is the status-aware policy in `src/retry-policy.ts`.

### Notes

- This is expected to be the last contribution in the current
  maintenance window. The 780G-payload-fixture items
  (`markers[]` for treatments, `therapyAlgorithmState` for auto-mode,
  `limits[]` schedule, multi-patient fan-out,
  `reservoirLevelPercent` snap-points, NGP-tier alarm codes) are
  deferred until a real pump arrives (currently expected November
  2026) or another operator contributes sanitised fixtures. Project
  maintenance continues passively — issue reports and security
  advisories are still monitored. The token-permission and
  atomic-write fixes shipped here provide the security baseline
  the deferred items will inherit; the discovery-pinning and
  named-error work provides the operational baseline.
- The PR references for the new items are intentionally left as
  plain bullets rather than `([#N])` because the GitHub PR/issue
  numbers are not yet assigned. When the PR is opened, replace
  the inline rationale with the assigned number to match the
  existing convention.

## [0.1.6] — 2026-07-19

### Added

- `npm run doctor` — a pre-flight self-check that validates `.env`
  completeness, decodes and reports the login token's validity/expiry,
  and confirms CareLink and Nightscout are reachable with an accepted
  `API_SECRET`, without fetching pump data. One request each to two hosts,
  safe to run repeatedly. Exit code is non-zero on failure so it can gate a
  deploy. First item of the v0.2.0 operability set ([#8]). ([#28])

### Changed

- The discovery app-version string (`android/3.6`) is now a documented,
  named constant in `src/login.ts`. Live probing showed Medtronic's discovery
  endpoint returns a different config per version — only 3.6/3.7 carry the
  Auth0 SSO config this flow needs, while 3.4 and 4.0 return no-Auth0 tracks —
  so a well-meaning "bump to a newer number" would silently break login. The
  no-SSO-URL error now names the version string as the likely cause. ([#27])

## [0.1.5] — 2026-07-19

### Fixed

- Data POST bodies (BLE and carepartner) now use the username CareLink reports
  from `/patient/users/me` instead of `CARELINK_USERNAME` verbatim, falling
  back to the configured value. Operators who enter their email while their
  CareLink username differs no longer send the wrong identifier on every data
  request. A verbose-mode log notes when the two differ. ([#25])

### Notes

- Round 2 of the auth-flow research validated the automated-login page
  scraping against Medtronic's live Auth0 Universal Login (field names,
  hidden fields, submit action all match) and confirmed nightscout-connect
  uses the same data-endpoint family. Findings: [#12 round-2 comment].

## [0.1.4] — 2026-07-19

### Fixed

- A 401/403 from the CareLink API now forces a token refresh on the next
  retry. Previously a token invalidated mid-lifetime (most commonly by the
  CareLink phone app logging into the same account) was retried until its
  natural expiry, stalling the bridge. ([#22], closes [#21])

### Changed

- Token expiry margin widened from 60s to 600s, matching the
  carelink-python-client reference, so a token passing the check cannot
  expire mid-fetch. ([#22])
- Carepartner data-endpoint fallbacks are now derived from a known-version
  list (13, 11, 6, 5) instead of a hardcoded v5/v6 replace-chain, adding the
  v13 generation that Medtronic's app discovery config now advertises and
  degrading sanely for unknown future versions. ([#23])

### Notes

- Round 1 of the auth-flow research validated the implementation against
  Medtronic's live discovery/SSO/OpenID configs: the Auth0 migration is
  complete for US and EU, the config shapes match our types field-for-field,
  and PKCE S256 is explicitly supported. Findings: [#12 round-1 comment].

## [0.1.3] — 2026-07-19

### Added

- `deploy/` directory: hardened user-level systemd unit, idempotent
  `install.sh`, Nightscout + MongoDB + cloudflared docker-compose stack, and
  a full deployment runbook. ([#6])
- Maintainer release checklist in CONTRIBUTING.md so version metadata cannot
  drift silently again. ([#18], closes [#17])

### Fixed

- Pump timezone offset now rounds to the nearest 15 minutes instead of whole
  hours. Users in half/quarter-hour timezones (+05:30 India, +09:30 central
  Australia, +05:45 Nepal, −03:30 Newfoundland) previously had every SGV
  timestamp skewed by up to 30 minutes. Pump clocks off by more than 7.5
  minutes are no longer silently rounded away. ([#20], closes [#15])
- systemd unit grants `ReadWritePaths` at directory level; the previous
  per-file bind mounts would have blocked deletion of `logindata.json` on
  refresh-token expiry (unlink EBUSY), silently defeating the stale-token
  recovery path. The `.env` write grant (never needed) was dropped.
  ([#19], closes [#16])
- CONTRIBUTING.md no longer claims CI runs on Node 18; `package.json` version
  synced with the release tag. ([#18], closes [#17])

## [0.1.2] — 2026-07-19

### Removed

- All fork-specific proxy code (`loadProxyList`, `createProxyAgent`,
  `ProxyRotator`, the `https.txt` proxy-list file, and the `USE_PROXY` env
  var), along with the `https-proxy-agent` and `socks-proxy-agent`
  dependencies. Pure attack-surface reduction: −146/+18 lines, two fewer
  supply-chain deps. ([#4])

### Changed

- Outbound proxying is now done via the standard `HTTPS_PROXY` /
  `ALL_PROXY` env vars, which axios respects natively; documented in the
  README. ([#4])

## [0.1.1] — 2026-07-19

### Security

- `USE_PROXY` defaults to `false`. A previous version silently routed all
  CareLink traffic (OAuth tokens, CGM data) through proxies listed in an
  undocumented `https.txt` file if it existed. Undocumented `my.env` config
  lookups removed. SECURITY.md gained a durable security-decisions section
  explaining each choice and what would justify reversing it.

### Added

- Regression test for the cherry-picked BLE device detection fix, locking in
  the `deviceFamily || medicalDeviceFamily` fallback from upstream PR #2.
- Acknowledgements crediting @terminalcommand and @nraverdy.
- Dependabot security updates, issues, and branch protection on `main`
  (required CI checks, `enforce_admins`).

### Changed

- Dropped Node 18 (EOL 2025-04-30); CI matrix is now Node 20 + 22.
- vitest bumped to ^4, clearing five transitive dev-dependency CVEs.
- `package.json` version corrected from the inherited `2.0.0` to `0.1.0` to
  match the tag line.

## [0.1.0] — 2026-07-18

Minimum viable community fork of
[domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge),
picked up while upstream is quiet.

### Added

- Cherry-picked [upstream PR #2] by @terminalcommand: BLE device detection
  for patient accounts. The patient `monitor/data` endpoint reports the
  device family as `deviceFamily`, not `medicalDeviceFamily`; without the
  fallback, 780G, Guardian 4, and Simplera devices fell through to a legacy
  endpoint that returns empty data.
- CI workflow (`tsc --noEmit` + vitest).
- Community fork README notice, ROADMAP.md, CONTRIBUTING.md, SECURITY.md.

## Pre-fork upstream history

Carried in this repository's git history from
[domien-f/carelink-bridge](https://github.com/domien-f/carelink-bridge):

- **2026-06-11** — BLE device detection fix for patient accounts (the change
  later formalized as [upstream PR #2] and credited above).
- **2026-02-16** — BLE device support and country/language configuration
  (upstream #1).
- **2026-02-13** — Initial upstream implementation: CareLink mobile-app OAuth
  (three-strategy login), pump/CGM fetch, Nightscout transform and upload.

[Unreleased]: https://github.com/NovaLux12/carelink-bridge/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/NovaLux12/carelink-bridge/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/NovaLux12/carelink-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/NovaLux12/carelink-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NovaLux12/carelink-bridge/releases/tag/v0.1.0
[#4]: https://github.com/NovaLux12/carelink-bridge/pull/4
[#6]: https://github.com/NovaLux12/carelink-bridge/pull/6
[#8]: https://github.com/NovaLux12/carelink-bridge/issues/8
[#15]: https://github.com/NovaLux12/carelink-bridge/issues/15
[#16]: https://github.com/NovaLux12/carelink-bridge/issues/16
[#17]: https://github.com/NovaLux12/carelink-bridge/issues/17
[#18]: https://github.com/NovaLux12/carelink-bridge/pull/18
[#19]: https://github.com/NovaLux12/carelink-bridge/pull/19
[#20]: https://github.com/NovaLux12/carelink-bridge/pull/20
[#21]: https://github.com/NovaLux12/carelink-bridge/issues/21
[#22]: https://github.com/NovaLux12/carelink-bridge/pull/22
[#23]: https://github.com/NovaLux12/carelink-bridge/pull/23
[#25]: https://github.com/NovaLux12/carelink-bridge/pull/25
[#27]: https://github.com/NovaLux12/carelink-bridge/pull/27
[#28]: https://github.com/NovaLux12/carelink-bridge/pull/28
[#12 round-1 comment]: https://github.com/NovaLux12/carelink-bridge/issues/12#issuecomment-5016844704
[#12 round-2 comment]: https://github.com/NovaLux12/carelink-bridge/issues/12#issuecomment-5016878393
[#73]: https://github.com/NovaLux12/carelink-bridge/issues/73
[#74]: https://github.com/NovaLux12/carelink-bridge/issues/74
[#75]: https://github.com/NovaLux12/carelink-bridge/issues/75
[#76]: https://github.com/NovaLux12/carelink-bridge/issues/76
[#77]: https://github.com/NovaLux12/carelink-bridge/issues/77
[#78]: https://github.com/NovaLux12/carelink-bridge/issues/78
[#79]: https://github.com/NovaLux12/carelink-bridge/issues/79
[upstream PR #2]: https://github.com/domien-f/carelink-bridge/pull/2
