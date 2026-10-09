# 0002 — Discovery app-version pinned to `android/3.6`

## Status

Accepted (since v0.1.6, 2026-07-19; promoted to a documented constant
in v0.2.0). **Evidence corrected 2026-10-08** after a live re-probe of
the discovery endpoint: the version matrix below replaced a four-row
partial table, and the "What reverses it" section was rewritten. The
**decision itself is unchanged** — `android/3.6` is still the pin — so
this is a correction of the recorded context, not a new decision
superseding this one.

## Context

`carelink-bridge` is an unofficial client of Medtronic's CareLink
Cloud. The login flow starts with a **discovery** call to a Medtronic-
hosted endpoint that returns a JSON document describing which OAuth
flow, endpoints, and SSO configurations are available for the calling
app version.

The discovery endpoint returns a **different config per app version**.
A small set of versions is known to return the Auth0 SSO configuration
that this code's login flow consumes; other versions do not.

### The full matrix (verified live 2026-10-08, 23 cells, all HTTP 200)

`clcloud.minimed.eu` and `clcloud.minimed.com` return byte-identical
documents. **The enumeration is open-ended** — `android/10.0` still
returns 200 — so this table is a snapshot, not a bounded set.

| App version | CareLink cumulus | `UseSSOConfiguration` | regions |
|-------------|------------------|------------------------|---------|
| 1.0, 2.0, 2.5, 3.0 | v2 | *absent* | 2 |
| 3.1 | **v6** | *absent* | 2 |
| 3.2 | v11 | *absent* | 2 |
| 3.3, 3.4 | v11 | *absent* | 3 |
| **3.5** | **v11** | **Auth0SSOConfiguration** | 3 |
| **3.6, 3.7, 3.8** | **v13** | **Auth0SSOConfiguration** | 3 |
| 3.9, 3.10, 4.0–4.8 (probed 4.0/4.1/4.2/4.3/4.5/4.8), 5.0, 6.0, 10.0 | v2 | *absent* | 2 |

`regions` is the number of `CP[]` entries in the returned document:
2 = US + EU, 3 = US + EU + CLINICAL.

Two things the earlier, partial matrix got wrong, and both matter for
the pin:

- **`android/3.5` selects the Auth0 config but sits on cumulus v11.** It
  is a near miss, not a fallback: the Auth0 selector is present but the
  document points at a different cumulus track, so the bridge's data
  call would not find its version. The 2026-07-19 matrix recorded the
  Auth0 family as 3.6/3.7/3.8 only; the selector alone now covers
  3.5–3.8.
- **3.6 / 3.7 / 3.8 are the only cells that are Auth0 *and* cumulus
  v13, full stop.** That conjunction is the property the pin actually
  depends on — not "returns an Auth0 URL" on its own.

This is load-bearing, not cosmetic. The login flow calls Auth0 Universal
Login; without the `Auth0SSOConfiguration` URL in the discovery
response, the flow has nothing to call. A well-meaning "bump to a
newer-looking number" would silently drop onto a no-Auth0 config
track, and the failure mode is "no error message that names the
version" — until v0.1.6 the operator would see a free-form
"configuration not found" string and have to guess.

### The discovery URL has TWO orthogonal axes

```
https://clcloud.minimed.{eu,com}/connect/carepartner/{basePath}/discover/android/{version}
```

The two path segments vary on independent things, which is
counter-intuitive and worth stating explicitly:

- **Base path = which tenant / deployment** is being served. It is *not*
  an API-generation number: `v11` does not mean "older API", it means a
  different tenant.
- **App version = which cumulus the returned document references.**

| Base path | What it serves |
|-----------|----------------|
| `v10` | 204, empty body |
| **`v11`** | **the trials tenant** — all three regions (US, EU, CLINICAL) point at `*-trials` hosts, and `baseUrlCumulus` is `…trials…/v13` for every region |
| `v12` | 401 `Authentication failure` |
| **`v13`** | **the patient API** — what this bridge uses |
| `v14`–`v20` | 403 `Missing Authentication Token` |

### The discovery document is global and host-independent

`clcloud.minimed.eu`, `clcloud.minimed.com` **and**
`clcloud-trials.minimed.com` return a byte-identical document (same
sha256), differing only in the `x-cum-signature` response header. The
hostname does not select the region: the document carries all three
`CP[]` entries (order US, EU, CLINICAL) and the client picks one by
`region` — `src/login.ts` does exactly that.

⇒ The `isUS ? 'clcloud.minimed.com' : 'clcloud.minimed.eu'` split in
`buildDiscoveryUrl()` is **effectively cosmetic**. It is not a bug and
it is worth keeping (the two tenants do serve different configs under
other paths), but a future maintainer must not read it as "this selects
my region". What actually puts you on a different tenant is the **base
path**, not the hostname and not the app version.

## Decision

`DISCOVERY_APP_VERSION = 'android/3.6'` is a named, documented
constant in `src/discovery.ts`. `buildDiscoveryUrl(isUS)` builds the
URL with that constant.

The version is **pinned, not "the latest we know about."** A future
maintainer who wants to bump to `android/3.7` (or higher) must:

1. Probe Medtronic's live discovery endpoint and confirm the new
   version **both** still returns an `Auth0SSOConfiguration` **and**
   still resolves a cumulus-v13 `baseUrlCumulus`. These are separate
   checks: `android/3.5` passes the first and fails the second.
2. Probe and confirm the new version's `cumulus` and
   `careLinkVersion` numbers match the data endpoint the bridge calls
   (currently `v13` and `v13` respectively).
3. Update the constant, update the comment block above it with the
   new verification date, and add a CHANGELOG entry that explains
   what was probed.

A named error class, `NoAuth0SSOConfigurationError` in
`src/login-errors.ts`, is thrown when the discovery response lacks
`Auth0SSOConfiguration`. The message names the pinned version string
as the likely cause. This makes the failure grep-distinguishable in
journald and points the operator at the constant to inspect.

## Consequences

- **Easier:** A future operator who hits the no-Auth0 failure sees a
  named error and a constant name to look at, not a free-form
  string to google.
- **Easier:** A future contributor who edits the discovery code
  path sees a single constant to change, with a comment block that
  summarises the version matrix and the verification date. The
  **authoritative** matrix is the table in this ADR; the comment block
  in `src/discovery.ts` is a summary of it and must be kept in step.
- **Easier:** Tests in `test/discovery.test.ts` cover the URL
  template and the `selectAuth0ConfigUrl` helper. Bumping the
  constant without updating the test forces a test failure.
- **Easier:** The eu/com host split needs no reasoning about: it is
  cosmetic, and this ADR says so, so nobody spends an afternoon
  "fixing" region selection that already works.
- **Harder:** The pin is only as good as the guard behind it, and until
  the 2026-10-08 re-probe that guard had one real hole.
  `selectAuth0ConfigUrl()` resolved
  `UseSSOConfiguration ?? 'Auth0SSOConfiguration'`, so it accepted the
  default key whenever the entry carried one — and the selector is not
  exclusive to the v13 track (`android/3.5` has it and is a v11 cell).
  A bump to `android/3.5` therefore did **not** throw
  `NoAuth0SSOConfigurationError`; it resolved the same config URL and
  failed later at the data call with no named error (issue #75). The hole
  was one version wide, not total: the key is genuinely **absent** on the
  other off-track cells (see Notes), so the guard did reject them — the
  2026-10-08 note that the guard was wholly inert was itself a probe
  artifact. **The guard now gates on the cumulus track**
  (`selectAuth0ConfigUrl` asserts a `baseUrlCumulus` ending in
  `/connect/carepartner/v13`, and fails closed when the field is missing)
  — which is the correction this ADR's "What reverses it" section
  demanded, implemented in `src/login-errors.ts`.
- **Harder:** The bridge cannot be "future-proofed" against
  Medtronic rotating to a new config track. If Medtronic
  deprecates `android/3.6`, the bridge breaks until the version is
  updated. This is the right tradeoff — silently picking a
  unverified version would be worse.
- **Harder:** The verification work to bump the version has to be
  done by a maintainer with a CareLink account (or against a public
  read-only probe — `clcloud.minimed.{eu,com}` accepts unauthenticated
  discovery calls). Documented above as a required step.

## What reverses it

- **A guard that checks only the presence of the
  `Auth0SSOConfiguration` key is NOT a reversal condition — it is a
  silent pass.** The selector is present on `android/3.5`, which is a
  cumulus-v11 cell and therefore unusable, so "the config key is there"
  no longer discriminates between a live pin and a broken one. **Any
  guard, comment, or test that protects this pin must check the
  cumulus track — `baseUrlCumulus` ending in
  `/connect/carepartner/v13` — and not merely the presence of the config
  key.** This is the single most important correction from the 2026-10-08
  re-probe.
- The pin itself is reversed only by a probed cell that is **both**
  Auth0 **and** cumulus v13 (today: 3.6 / 3.7 / 3.8), or by Medtronic
  moving the Auth0 track off cumulus v13 entirely — in which case the
  data endpoint's version fallback list in `src/carelink/client.ts`
  (`[13, 11, 6, 5]`) has to move with it, and that is a code change, not
  a constant change.
- If Medtronic ships a version that returns a structurally different
  Auth0 config (e.g. different field names, different OAuth flow),
  the constant alone is not enough — the consumer code in
  `src/carelink/client.ts` and `src/login.ts` has to be updated
  in lockstep. The new ADR for that change should supersede this
  one.
- If Medtronic deprecates the discovery endpoint entirely and moves
  to a different config-discovery mechanism, the
  `buildDiscoveryUrl` shape changes, and the constant is replaced
  by whatever the new mechanism requires.
- If Medtronic ever starts **varying** the document by hostname or by
  base path in a way that matters (today it does not — the document is
  byte-identical across `clcloud.minimed.eu`, `clcloud.minimed.com` and
  `clcloud-trials.minimed.com`), the "host split is cosmetic" note above
  is what reverses, not the pin.

## Notes

- Source: `src/discovery.ts` (the file's own header comment records
  a summary of the version matrix and the verification date).
- **Re-probed live on 2026-10-08** (23 cells, unauthenticated, both
  hosts, byte-identical documents). The prior evidence in this ADR was
  dated 2026-07-19 and 2026-08-05 and was a partial subset — it omitted
  `android/3.5`, `android/3.9`/`3.10`, the cumulus **v6** track on
  `3.1`, and the open-endedness of the version enumeration.
- **A second probe on 2026-10-09 settled** the one point the first two
  disagreed on: whether the `Auth0SSOConfiguration` *key* is present on the
  v2/v11 cells. The 2026-10-08 probe recorded it present on every version
  probed — that was an artifact of a `//` fallback in the probe script,
  which returns the truthy string `"-"` and so read as present. The
  2026-10-09 re-probe, confirmed by replaying the pre-#75 guard logic
  against live documents, found the key **absent** on the v2/v11 cells,
  which carry a legacy `SSOConfiguration` URL instead. The guard was
  therefore never inert, and the only version it failed to reject was
  `android/3.5` — which is what #75 actually fixes. **Do not treat the
  key as a track signal — gate on `baseUrlCumulus`.**
- **This ADR and the `src/discovery.ts` header comment are aligned.** An
  earlier draft of that comment recorded the 2026-10-08 / 2026-10-09
  reading of the `Auth0SSOConfiguration` key as "noted rather than
  resolved"; it now states the settled position, matching this ADR.
- **Issue #77's second suggestion is deliberately deferred, not
  forgotten.** Recording the observed `x-cum-signature` for the pinned
  `android/3.6` + region as a test fixture, and asserting the presence
  and stability of that header, is **not done**. Two reasons: (1) an
  unauthenticated probe can observe the response header but cannot
  exercise the client's *consumption* of it, and there is no consumer
  yet — the algorithm is undocumented, the header is discarded, and TLS
  is what actually authenticates the transport; (2) a 344-character
  base64 value committed into the repository is a maintenance liability
  that buys nothing until something actually reads it. What landed for
  #77 is the header's documentation (the `src/discovery.ts` header comment
  plus the byte-identical-document note above) and the `certificates[]`
  change tripwire. When a caller wires that tripwire in, the
  signature-assertion fixture should ship with it.
- v0.1.6 introduced the constant (CHANGELOG entry for 2026-07-19).
- The named error class lives in `src/login-errors.ts`; the cumulus-track
  gate that closes issue #75 lives beside it.
- `test/discovery.test.ts` and `test/login-errors.test.ts` cover
  the constant, the URL builder, the named error, and the track gate.

## Amendment (2026-10-08)

Appended under the evidence-correction clause added to
[docs/adr/README.md](./README.md) on 2026-10-09. The **decision** above is
unchanged — `android/3.6` is still the pin — so no superseding ADR was
written. But the 2026-10-08 re-probe replaced two pieces of recorded
evidence **in place** and added one new reversal condition, which is
the thing the immutability rule protects
against. The superseded text is therefore quoted verbatim below, each
marked **superseded with date**, so this ADR's history is recoverable
without reading the git log. The third block below is marked **Added**,
not superseded: it records a new reversal condition for which there is
no prior text to quote.

### Superseded 2026-10-08 — the original four-row 2026-07-19 matrix

This is the table the Context section carried before the 23-cell matrix
above replaced it. Verbatim, including its column layout:

| App version   | CareLink cumulus | Auth0 SSO config returned? |
|---------------|------------------|----------------------------|
| `android/3.4` | v11              | No (legacy OAuth path)     |
| `android/3.6` | v13              | **Yes** (what this code uses) |
| `android/3.7` | v13              | **Yes**                    |
| `android/4.0` | v2 / careLink v1 | No                         |

It was right as far as it went and wrong in the parts that matter: it
omitted `android/3.5`, which is the near miss that issue #75 exists
because of, and it said nothing about the cumulus **v6** track on
`android/3.1` or about the enumeration being open-ended. The 23-cell
matrix above supersedes it.

### Superseded 2026-10-09 — the "guard was inert" claim

Quoted verbatim from what the Consequences section carried between the
2026-10-08 re-probe and the 2026-10-09 one:

> **Harder:** The pin is only as good as the guard behind it, and until
> the 2026-10-08 re-probe that guard was **inert**.
> `selectAuth0ConfigUrl()` resolved
> `UseSSOConfiguration ?? 'Auth0SSOConfiguration'`, so it accepted the
> default key whenever the entry carried one — and the selector is not
> exclusive to the v13 track (`android/3.5` has it and is a v11 cell).
> A bump to a selector-carrying but wrong-track version therefore did
> **not** throw `NoAuth0SSOConfigurationError`; it resolved the same
> config URL and failed later at the data call with no named error
> (issue #75). **The guard now gates on the cumulus track**
> (`selectAuth0ConfigUrl` asserts a `baseUrlCumulus` ending in
> `/connect/carepartner/v13`, and fails closed when the field is
> missing) — which is the correction this ADR's "What reverses it"
> section demanded, implemented in `src/login-errors.ts`.

The wording was itself the artifact of a probe bug — a `//` fallback in
the probe script returns the truthy string `"-"`, so every key read as
present. Replaying the pre-#75 guard logic against live documents showed
the key **absent** on the v2/v11 cells, so the guard was never inert and
the only version it failed to reject was `android/3.5`. The "one version
wide, not total" wording in Consequences supersedes the quote above, and
the full record is in the Notes section.

### Added 2026-10-09 — new reversal condition

The first bullet of "What reverses it" above was added on 2026-10-09:
any guard, comment, or test that protects this pin must check the
cumulus track — `baseUrlCumulus` **ending in**
`/connect/carepartner/v13` — and not merely the presence of the config
key. This is a new condition, not a correction of earlier wording: no
prior text is quoted here because the merged ADR's "What reverses it"
never addressed the cumulus track at all (it covered only a
structurally-different Auth0 config and endpoint deprecation). The
condition says *ending in* the full suffix deliberately — a substring
check on `/v13` would admit `.../v131` — matching the suffix assertion
`cumulus.endsWith(CUMULUS_V13_PATH_SUFFIX)` in `src/login-errors.ts`.
