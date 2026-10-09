import { createHash } from 'node:crypto';

/**
 * Discovery endpoint pin, plus the discovery-document tripwires that issue #77
 * added (pinned `certificates[]`; the undocumented `x-cum-signature` header).
 *
 * The discovery app-version string is load-bearing, not cosmetic. Medtronic's
 * discovery endpoint returns a *different* config per version, and only some
 * versions carry the Auth0 SSO config the login flow needs.
 *
 * VERIFIED matrix — live unauthenticated probe on 2026-10-08 (23 cells); the
 * Auth0SSOConfiguration key-presence question was settled 2026-10-09
 * (`GET /connect/carepartner/v13/discover/android/<version>`, every version
 * below returned HTTP 200; the EU entry of each document is quoted).
 * `.com` returns byte-identical documents to `.eu` (same sha256), so the
 * matrix is host-independent:
 *
 * | android/  | baseUrlCumulus   | UseSSOConfiguration     |
 * |-----------|------------------|-------------------------|
 * | 1.0, 2.0, 2.5, 3.0 | v2    | absent (legacy `SSOConfiguration`) |
 * | 3.1       | v6               | absent                  |
 * | 3.2, 3.3, 3.4 | v11        | absent (legacy OAuth path) |
 * | 3.5       | v11              | **Auth0SSOConfiguration** ← the trap |
 * | 3.6, 3.7, 3.8 | v13         | **Auth0SSOConfiguration** ← the pin |
 * | 3.9, 3.10, 4.0–4.8, 5.0, 6.0, 10.0 | v2 | absent      |
 *
 * Issue #75 records the same matrix from a 2026-10-08 probe.
 *
 * **The verified Auth0 + cumulus-v13 family is exactly `android/3.6`,
 * `android/3.7`, `android/3.8`** — see `VERIFIED_AUTH0_V13_FAMILY` below. Only
 * these are valid fallback pins: they are the only probed versions that both
 * select Auth0 and declare the cumulus-v13 track that this bridge is built
 * against (`buildDiscoveryUrl` below is pinned to the v13 path, and the
 * discovery response is what feeds the data-plane base host).
 *
 * One nuance worth stating so nobody reads the guard as stricter than it is:
 * `src/carelink/client.ts` keeps a *fallback* version list that spans v13 down
 * to v5 for its BLE endpoints, so a non-v13 base is not automatically fatal to
 * every individual call — some data calls may still be answered by the
 * fallback path. That is exactly why issue #75's symptom is "login works, then
 * the data call fails with no named error" instead of a clean break: a
 * wrong-together pin gets quietly papered over by a downgrade fallback that
 * was never validated for that generation. Failing closed at discovery is what
 * makes the mis-pin visible.
 *
 * `android/3.5` is NOT a valid fallback, and it is the whole reason issue #75
 * exists. It selects `Auth0SSOConfiguration`, so a key-presence check passes
 * and login looks healthy, but its `baseUrlCumulus` is
 * `https://clcloud.minimed.eu/connect/carepartner/v11` — a different API
 * generation. The failure then surfaces at the data call, with no named error
 * to grep. The runtime guard that catches this is in `src/login-errors.ts`
 * (`selectAuth0ConfigUrl`), which gates on the cumulus track rather than on
 * key presence.
 *
 * Why presence of the `Auth0SSOConfiguration` key is NOT a track signal
 * The 2026-10-08 reading recorded the key as present on *every* version
 * probed, android/1.0 … 10.0, including the cumulus-v2 cells. That was a
 * probe artifact — a `//` fallback returns the truthy string "-", so the
 * presence check read as always-true. The 2026-10-09 re-probe, confirmed by
 * replaying the pre-#75 guard against live documents, found the key *absent*
 * on the v2/v11 cells (which carry the legacy `SSOConfiguration` key
 * instead) and present from android/3.5 onward. So the guard was never
 * inert; android/3.5 was the one version it failed to reject, and that is
 * what #75 fixes. Do not treat the key as a track signal; gate on
 * `baseUrlCumulus`. See ADR 0002 Notes for the full record.
 *
 * Bumping this to a "newer"-looking number will silently drop onto a config
 * with no Auth0 SSO URL and break login. Keep it at a version verified to
 * return Auth0SSOConfiguration.
 *
 * Source: research/medtronic-carelink-2026-07-21/01-endpoint-matrix.md
 * (table at the top of the file), re-probed live 2026-10-09.
 */
export const DISCOVERY_APP_VERSION = 'android/3.6';

/**
 * The app versions that are verified to return Auth0SSOConfiguration *and*
 * declare the v13 cumulus track (VERIFIED live 2026-10-09 — all three regions,
 * US/EU/CLINICAL, of each document). Oldest first, so index 0 is the pinned
 * `DISCOVERY_APP_VERSION`.
 *
 * Only this family may be used as a fallback `DISCOVERY_APP_VERSION`.
 * Explicitly excluded, with the reason:
 *   - `android/3.5` — selects Auth0 but `baseUrlCumulus` is v11 (the #75 trap).
 *   - `android/3.4`, 3.3, 3.2 — cumulus v11, no Auth0 selector (legacy OAuth).
 *   - `android/3.1` — cumulus v6, no Auth0 selector.
 *   - `android/1.0`, 2.0, 2.5, 3.0, 3.9, 3.10, 4.0–4.8, 5.0, 6.0, 10.0 —
 *     cumulus v2, no Auth0 selector.
 */
export const VERIFIED_AUTH0_V13_FAMILY = ['android/3.6', 'android/3.7', 'android/3.8'] as const;

/**
 * The cumulative-version path suffix the bridge requires the discovery
 * document to declare (VERIFIED live 2026-10-09). `baseUrlCumulus` in the
 * live document is a full URL — e.g.
 * `https://clcloud.minimed.eu/connect/carepartner/v13` — so the check is a
 * suffix test, not an equality test.
 *
 * The trailing element is `v13` exactly; a hypothetical `.../v130` or
 * `.../v13/` does not match and therefore fails closed (see
 * `selectAuth0ConfigUrl` in src/login-errors.ts).
 */
export const CUMULUS_V13_PATH_SUFFIX = '/connect/carepartner/v13';

/**
 * Build the discovery URL for the chosen region. The host and base path are
 * fixed; only the version string is the load-bearing variable.
 *
 * US -> clcloud.minimed.com (Auth0 tenant: carelink-login.minimed.com)
 * EU -> clcloud.minimed.eu (Auth0 tenant: carelink-login.minimed.eu)
 */
export function buildDiscoveryUrl(isUS: boolean): string {
  const host = isUS ? 'clcloud.minimed.com' : 'clcloud.minimed.eu';
  return `https://${host}/connect/carepartner/v13/discover/${DISCOVERY_APP_VERSION}`;
}

// ---------------------------------------------------------------------------
// Discovery-document integrity tripwires (issue #77)
// ---------------------------------------------------------------------------

/**
 * `x-cum-signature` — the response header Medtronic puts on discovery
 * documents. VERIFIED by live probe 2026-10-09:
 *
 *  - Carried by `GET /connect/carepartner/{v11,v13}/discover/*` on
 *    `clcloud.minimed.eu` and `clcloud.minimed.com` (issue #77 records it on
 *    `clcloud-trials.minimed.com` as well; not re-probed here).
 *  - Value is base64, exactly 344 characters, decoding to 256 bytes.
 *  - **Deterministic**: byte-identical across repeated requests for the same
 *    document (verified: 2 requests per host, identical every time).
 *  - **Host-bound, not body-bound**: `.eu` and `.com` return byte-identical
 *    documents (sha256
 *    `f84886265667b1b685ad0d362793c0478354f2ec30d7c81e30a52ca86a3b1609`
 *    for both) but *different* signatures. So the signature is computed over
 *    something beyond the body — host, region, or a per-tenant key.
 *
 * **The algorithm is UNKNOWN. Do not guess it.** The document's pinned
 * `certificates[]` (see below) suggests the intended client pins a signer, but
 * nothing in the wire format says which scheme is used, which bytes are
 * signed, or which key signs.
 *
 * DO NOT ATTEMPT TO VERIFY THIS HEADER CRYPTOGRAPHICALLY. A guessed verifier
 * is worse than no verifier: if the guess is wrong it either always passes
 * (security theatre that buys false confidence on a medical-adjacent auth
 * path) or always fails (login breaks for every user with an error that names
 * nothing real). TLS already authenticates the transport, so this header is
 * discarded defence-in-depth from the vendor. If you discover the algorithm,
 * write the *evidence* that proves it into this comment before wiring it in —
 * "it looks like RSA" is not evidence.
 *
 * Issue #77 records the header as absent on `/patient/*`, on
 * `/patient/countries/settings`, and on the `v12`/`v14+` base paths. NOT
 * re-verified here: unauthenticated requests to those paths returned 401/403
 * in this probe, so for us they are *unknown*, not known-absent. Treat the
 * absence claim as INFERRED from issue #77's evidence, not VERIFIED.
 */

/**
 * How many entries the live discovery document's `certificates[]` pin list
 * carries. VERIFIED live 2026-10-09: 8 entries on every document inspected —
 * android/1.0, 3.4, 3.5, 3.6, 3.7, 3.8, 4.0 and 10.0, on both hosts, on-track
 * and off-track versions alike.
 *
 * Recorded shape, because it matters for how much the list is worth: each
 * entry is `{ host: string, cert: string }` where `cert` is base64 without PEM
 * armour (~1220 chars, 914 bytes decoded on 2026-10-09), and **all 8 entries
 * carry the same certificate**. So the "8 pinned certs" are really one
 * certificate pinned for 8 hostnames — carelink.minimed.com,
 * carelink.minimed.eu, clcloud.minimed.com, clcloud.minimed.eu,
 * carelink-trials.minimed.com, clcloud-trials.minimed.com,
 * www.medtronic.com, carelink-content.medtronic.com. A change detector must
 * therefore watch the *host set* as well as the certificate bytes, which is
 * why the fingerprint below covers both.
 */
export const VERIFIED_DISCOVERY_CERT_COUNT = 8;

/**
 * sha256 over the canonical form of the pinned list: the `[host, cert]` pairs
 * sorted by host (then cert), JSON-serialised, hashed. Order-insensitive on
 * purpose so a reordered array is not a false alarm. VERIFIED live 2026-10-09
 * against `android/3.6` on `clcloud.minimed.eu` and `.com`, and also against
 * `android/3.5` and `android/4.0` — i.e. off-track versions share the same pin
 * list, so this fingerprint is not itself a track check.
 *
 * This is a tripwire, not a security control: it tells you the pin list moved.
 * It cannot tell you the signer is legitimate — that is the `x-cum-signature`
 * algorithm above, which is unknown.
 */
export const PINNED_DISCOVERY_CERT_FINGERPRINT =
  '3f8b62b3c53942b3722209a8ff6450374caebe77cd33edb28bd2a3a2793dc5f1';

/** What `checkDiscoveryCertificates` reports back to its caller. */
export interface DiscoveryCertificatesReport {
  /** `certificates[]` resolved to at least one usable `{host, cert}` entry. */
  present: boolean;
  /** Usable `{host, cert}` entries found. */
  count: number;
  /** Count expected from the live probe (`VERIFIED_DISCOVERY_CERT_COUNT`). */
  expectedCount: number;
  /** sha256 of the canonical pin list, or null when nothing could be hashed. */
  fingerprint: string | null;
  /** Fingerprint this run compared against; null disables the comparison. */
  pinnedFingerprint: string | null;
  /** Whether the fingerprint matched, or null when it could not be compared. */
  fingerprintMatches: boolean | null;
  /** Host names seen, in document order. Useful context in the warning. */
  hosts: string[];
  /**
   * Set whenever the observed list differs from the pinned expectation —
   * including "absent" and "unparseable", which are also changes. The caller
   * is expected to log this as a warning, NOT to fail: see below.
   */
  warning?: string;
}

/**
 * Compare `[host, cert]` pairs by host, then cert. This is the ordering the
 * pinned fingerprint was computed with, so it must not drift silently.
 */
function compareCertEntries(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/**
 * Canonical fingerprint of a `[host, cert]` pair list. Exported so the
 * pinned constant can be recomputed by a maintainer who re-probes the live
 * document (fetch the URL, map `certificates` to pairs, hash the output).
 */
export function fingerprintCertificates(
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  const canonical = JSON.stringify(
    entries.map(([host, cert]) => [host, cert] as [string, string]).sort(compareCertEntries),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Check the discovery document's `certificates[]` pin list against the values
 * recorded from the live endpoint.
 *
 * This is deliberately WEAK, and deliberately not fatal:
 *
 *  - `present` / `count` are the cheap, definitely-correct facts — the cheap
 *    part of issue #77. Medtronic may legitimately rotate their pin list at
 *    any time, and a rotation is not evidence of an attack, so every
 *    observation that differs from the pin is reported through `warning` and
 *    the caller decides what to do (log it; do not abort the login).
 *  - `fingerprint` / `fingerprintMatches` are a change detector, NOT a
 *    verification. It says "this list is no longer the one we recorded", which
 *    is exactly the tripwire issue #77 asks for. It says nothing about whether
 *    the signer is authentic.
 *  - Pass `pinnedFingerprint: null` to run presence-only (no change
 *    detection), e.g. if the pin has been re-probed and not yet updated.
 *
 * INFERRED, not verified: nothing here is wired into the login flow yet. The
 * helper is exported and unit-tested so a future change can call it at the
 * discovery fetch in `src/login.ts`; that call site is intentionally left
 * alone in this change to keep the auth path's diff minimal. The intended
 * wiring, for whoever does it:
 *
 *   const report = checkDiscoveryCertificates(discoverResp.data);
 *   if (report.warning) logger.warn(report.warning, { component: 'login' });
 *
 * Until that lands, the warning is only produced when the helper is called
 * explicitly, and TLS remains what actually authenticates the transport.
 */
export function checkDiscoveryCertificates(
  document: { certificates?: unknown } | null | undefined,
  options: { expectedCount?: number; pinnedFingerprint?: string | null } = {},
): DiscoveryCertificatesReport {
  const expectedCount = options.expectedCount ?? VERIFIED_DISCOVERY_CERT_COUNT;
  const pinnedFingerprint =
    options.pinnedFingerprint === undefined ? PINNED_DISCOVERY_CERT_FINGERPRINT : options.pinnedFingerprint;

  const raw = document?.certificates;
  const entries: ReadonlyArray<readonly [string, string]> =
    Array.isArray(raw)
      ? raw.flatMap((entry): Array<readonly [string, string]> => {
          if (!entry || typeof entry !== 'object') return [];
          const record = entry as { host?: unknown; cert?: unknown };
          if (typeof record.host === 'string' && typeof record.cert === 'string') {
            return [[record.host, record.cert]];
          }
          return [];
        })
      : [];

  const count = entries.length;
  const hosts = entries.map(([host]) => host);
  const present = count > 0;
  const fingerprint = present ? fingerprintCertificates(entries) : null;
  const fingerprintMatches =
    pinnedFingerprint === null || fingerprint === null ? null : fingerprint === pinnedFingerprint;

  const report: DiscoveryCertificatesReport = {
    present,
    count,
    expectedCount,
    fingerprint,
    pinnedFingerprint,
    fingerprintMatches,
    hosts,
  };

  if (!present) {
    report.warning =
      'discovery document carries no usable certificates[] pin list — the signer set ' +
      'this bridge records for Medtronic discovery is no longer observable. TLS still ' +
      'authenticates the transport, so this is not a transport failure; the pinned-cert ' +
      'tripwire (issue #77) is simply blind until the shape is re-probed.';
    return report;
  }

  if (fingerprintMatches === null) {
    report.warning =
      `discovery document's certificates[] (${count} entries) could not be fingerprinted ` +
      'against the pin (fingerprinting disabled), so no change detection ran for it.';
    return report;
  }

  if (!fingerprintMatches) {
    report.warning =
      `discovery document's certificates[] changed since the recorded pin ` +
      `(fingerprint ${pinnedFingerprint}): now ${count} entries, fingerprint ${fingerprint}. ` +
      'Medtronic rotating its pin list is legitimate — if the rotation is expected, ' +
      're-probe and update VERIFIED_DISCOVERY_CERT_COUNT / ' +
      'PINNED_DISCOVERY_CERT_FINGERPRINT in src/discovery.ts.';
    return report;
  }

  if (count !== expectedCount) {
    // Same bytes, different cardinality: only reachable if a caller passed a
    // non-default expectedCount. Still worth naming rather than ignoring.
    report.warning =
      `discovery document's certificates[] has ${count} entries but ${expectedCount} were ` +
      'expected; the fingerprint matched, so the pin list bytes are unchanged in aggregate.';
  }

  return report;
}
