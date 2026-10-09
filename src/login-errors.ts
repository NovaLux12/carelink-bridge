/**
 * Named error class for the "discovery returned no Auth0 SSO URL" path.
 *
 * Distinguishes the Auth0 cut-over / discovery-version-pin failure from a
 * plain network error so on-call can grep journald for the named marker
 * rather than parsing a free-form message string. The accompanying message
 * carries the actionable guidance ("point DISCOVERY_APP_VERSION at a config
 * known to return Auth0SSOConfiguration").
 *
 * Source: research/medtronic-carelink-2026-07-21/README.md line 26 and
 * 04-operational-history.md 2026-01-02 (legacy `mdtlogin-ocl.medtronic.com`
 * RST, all four community clients lost connectivity on the same day).
 *
 * Since issue #75 (2026-10-08) this class also covers the cumulus-track
 * failure, which is the same operational story wearing a different hat: a bad
 * `DISCOVERY_APP_VERSION` pin used to be caught by the absence of an Auth0
 * URL, and now has to be caught by the track the Discovery document declares.
 */

import { CUMULUS_V13_PATH_SUFFIX, VERIFIED_AUTH0_V13_FAMILY } from './discovery.js';

export class NoAuth0SSOConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAuth0SSOConfigurationError';
    Object.setPrototypeOf(this, NoAuth0SSOConfigurationError.prototype);
  }
}

/**
 * Shape of a single CP entry from the discovery JSON, restricted to the
 * fields this helper reads. Defined locally so this module doesn't depend
 * on src/types/carelink.js (which keeps the policy module importable in
 * isolation for tests).
 *
 * `baseUrlCumulus` is included because issue #75 made it load-bearing: it is
 * the only field that says which cumulus track the entry points at. It is
 * OPTIONAL, and that is exactly why it needs a documented policy — see
 * `assertSupportedCumulusTrack` below for why a missing field fails closed.
 */
export interface DiscoveryCpEntry {
  UseSSOConfiguration?: string;
  Auth0SSOConfiguration?: string;
  Layer7SSOConfiguration?: string;
  /**
   * Full cumulus base URL, e.g.
   * `https://clcloud.minimed.eu/connect/carepartner/v13`. Optional in the
   * type; treated as a failure when missing (fail-closed, issue #75).
   */
  baseUrlCumulus?: string;
  [key: string]: unknown;
}

/**
 * Fail-closed cumulus-track gate (issue #75).
 *
 * The Auth0-URL check in `selectAuth0ConfigUrl` used to be a sufficient pin
 * guard, because "no `Auth0SSOConfiguration` key" reliably meant "this is a
 * no-Auth0 track". That stopped being true. `android/3.5` is the concrete
 * counterexample, VERIFIED live 2026-10-09: it selects
 * `Auth0SSOConfiguration` (so discovery looks healthy) while its
 * `baseUrlCumulus` is `.../connect/carepartner/v11` — a different API
 * generation. Pinning `android/3.5` therefore produced a working-looking login
 * and then a failure at the data call, with no named error to grep. The pin
 * guard was one version wide, not total — it correctly rejected every
 * cumulus-v2 cell and the other cumulus-v11 cells, but not `android/3.5`.
 * (An earlier draft of this comment and of issue #75 called it "inert";
 * that was a probe artifact, since corrected there and in ADR 0002.)
 *
 * So the guard now checks the *track*, not the key: the entry must declare the
 * v13 cumulus path this bridge is built against. A resolved URL plus a
 * non-v13 track is a contradiction, and the contradiction is the signal.
 *
 * FAIL-CLOSED on a missing `baseUrlCumulus`, deliberately. The field is
 * optional in the type, so three ways to treat "absent" were available; the
 * argument for failing closed:
 *
 *  1. The field is present on every document probed (android/1.0 … 10.0, both
 *     hosts, VERIFIED live 2026-10-09). An absent field therefore means "this
 *     is not the shape we probed", which is precisely the situation in which
 *     guessing is most dangerous.
 *  2. Failing open would rebuild the inert guard in a new place: with no
 *     cumulus value to check, the only remaining signal is key presence, and
 *     issue #75 exists because key presence cannot distinguish android/3.5
 *     (Auth0, v11) from android/3.6 (Auth0, v13).
 *  3. This is a pre-authentication, medical-adjacent path. A wrong pin must
 *     become a named error at discovery time, where the operator still knows
 *     they just changed a constant — not an unnamed failure minutes later at
 *     the data call, after the bridge may already have written bad data
 *     downstream.
 *
 * The cost of failing closed is a legitimate Medtronic rename of this field
 * breaking login until the constant is updated. That cost is acceptable here:
 * the bridge is pinned to one app version in any case, so a shape change
 * already means a code change and a re-probe; and the error message names the
 * field to look for. Failing open would trade a loud, named, attributable
 * break for a silent mis-configuration of the data plane — the wrong trade on
 * this path.
 */
function assertSupportedCumulusTrack(
  cpEntry: DiscoveryCpEntry,
  context: { region: string; appVersion: string },
): void {
  const cumulus = cpEntry.baseUrlCumulus;
  if (typeof cumulus === 'string' && cumulus.endsWith(CUMULUS_V13_PATH_SUFFIX)) {
    return;
  }

  // Name the observed value precisely, and say which of the two failure modes
  // we are in — "wrong track" and "unknown shape" need different fixes.
  const seen =
    typeof cumulus === 'string'
      ? `"${cumulus}"`
      : cumulus === undefined
        ? 'absent (the entry carries no baseUrlCumulus at all)'
        : `not a string (got ${typeof cumulus}: ${JSON.stringify(cumulus)})`;

  throw new NoAuth0SSOConfigurationError(
    `Discovery for region "${context.region}" (pinned app version ` +
    `"${context.appVersion}") declares cumulus ${seen}, but this bridge ` +
    `requires the "${CUMULUS_V13_PATH_SUFFIX}" track. An Auth0 config URL ` +
    `resolved, but it belongs to a different cumulus generation, so the pin ` +
    `is wrong even though discovery looks healthy (this is the failure issue ` +
    `#75 added this gate for: android/3.5 does exactly this). Fix: keep ` +
    `DISCOVERY_APP_VERSION ("${context.appVersion}") on one of the verified ` +
    `Auth0 + cumulus-v13 family — ${VERIFIED_AUTH0_V13_FAMILY.join(', ')} ` +
    `(UseSSOConfiguration=${cpEntry.UseSSOConfiguration ?? 'absent'}).`,
  );
}

/**
 * Returns the SSO config URL declared by the discovery entry, or throws
 * `NoAuth0SSOConfigurationError` when the entry is not on the supported
 * cumulus track, or when neither the explicit selector nor the default key
 * resolves to a non-empty string. The helper owns the throw so the production
 * call site in login.ts is a single line and the behavioural contract
 * (instanceof + name) is provable directly.
 *
 * `context` carries the values the operator needs to diagnose the failure
 * (region, UseSSOConfiguration value, pinned app version). The defaults
 * match the discovery-response shape documented in
 * 01-endpoint-matrix.md.
 *
 * Order of the two guards is deliberate (issue #75): the cumulus-track gate
 * runs FIRST. It is the structural invariant — "is this document on the
 * track this bridge is built against" — and it is the check that can say
 * something the URL-resolution check cannot. When the cumulus value is wrong
 * the message names the version, the cumulus value and the verified fallback
 * family; when the cumulus value is right but no URL resolves, the original
 * message (unchanged since v0.1.6) still fires. Happy path is unchanged: a
 * v13 entry falls straight through and returns the URL untouched.
 */
export function selectAuth0ConfigUrl(
  cpEntry: DiscoveryCpEntry,
  context: { region: string; appVersion: string } = { region: 'unknown', appVersion: 'unknown' },
): string {
  // Issue #75: validate the track before trusting any URL the entry carries.
  assertSupportedCumulusTrack(cpEntry, context);

  const explicitKey = cpEntry.UseSSOConfiguration;
  const key = explicitKey ?? 'Auth0SSOConfiguration';
  const candidate = cpEntry[key];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  throw new NoAuth0SSOConfigurationError(
    `Discovery returned no Auth0 SSO config URL for region "${context.region}" ` +
    `(UseSSOConfiguration=${explicitKey ?? 'absent'}). This usually means ` +
    `DISCOVERY_APP_VERSION ("${context.appVersion}") points at a config track without Auth0 — ` +
    `keep it on a version known to return Auth0SSOConfiguration, i.e. one of the ` +
    `verified cumulus-v13 family: ${VERIFIED_AUTH0_V13_FAMILY.join(', ')}.`,
  );
}
