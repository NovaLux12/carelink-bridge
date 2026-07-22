# 0002 — Discovery app-version pinned to `android/3.6`

## Status

Accepted (since v0.1.6, 2026-07-19; promoted to a documented constant
in v0.2.0).

## Context

`carelink-bridge` is an unofficial client of Medtronic's CareLink
Cloud. The login flow starts with a **discovery** call to a Medtronic-
hosted endpoint that returns a JSON document describing which OAuth
flow, endpoints, and SSO configurations are available for the calling
app version.

The discovery endpoint returns a **different config per app version**.
A small set of versions is known to return the Auth0 SSO configuration
that this code's login flow consumes; other versions do not.

| App version   | CareLink cumulus | Auth0 SSO config returned? |
|---------------|------------------|----------------------------|
| `android/3.4` | v11              | No (legacy OAuth path)     |
| `android/3.6` | v13              | **Yes** (what this code uses) |
| `android/3.7` | v13              | **Yes**                    |
| `android/4.0` | v2 / careLink v1 | No                         |

This is load-bearing, not cosmetic. The login flow calls Auth0 Universal
Login; without the `Auth0SSOConfiguration` URL in the discovery
response, the flow has nothing to call. A well-meaning "bump to a
newer-looking number" would silently drop onto a no-Auth0 config
track, and the failure mode is "no error message that names the
version" — until v0.1.6 the operator would see a free-form
"configuration not found" string and have to guess.

The version string is in the discovery URL:

```
https://clcloud.minimed.{eu,com}/connect/carepartner/v13/discover/android/3.6
```

The host and the v13 base path are fixed; only the version suffix is
the variable.

## Decision

`DISCOVERY_APP_VERSION = 'android/3.6'` is a named, documented
constant in `src/discovery.ts`. `buildDiscoveryUrl(isUS)` builds the
URL with that constant.

The version is **pinned, not "the latest we know about."** A future
maintainer who wants to bump to `android/3.7` (or higher) must:

1. Probe Medtronic's live discovery endpoint and confirm the new
   version still returns an `Auth0SSOConfiguration`.
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
  documents the version matrix and the verification date. The
  matrix is right there in the file.
- **Easier:** Tests in `test/discovery.test.ts` cover the URL
  template and the `selectAuth0ConfigUrl` helper. Bumping the
  constant without updating the test forces a test failure.
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

## Notes

- Source: `src/discovery.ts` (the file's own header comment records
  the version matrix and the verification date 2026-07-19).
- v0.1.6 introduced the constant (CHANGELOG entry for 2026-07-19).
- The named error class lives in `src/login-errors.ts`.
- `test/discovery.test.ts` and `test/login-errors.test.ts` cover
  the constant, the URL builder, and the named error.
