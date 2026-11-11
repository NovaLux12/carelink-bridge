/**
 * Named error class for the "discovery returned no Auth0 SSO URL" path.
 *
 * Distinguishes the Auth0 cut-over / discovery-version-pin failure from a
 * plain network error so on-call can grep journald for the named marker
 * rather than parsing a free-form message string. The accompanying message
 * carries the actionable guidance ("point DISCOVERY_APP_VERSION at a config
 * known to return Auth0SSOConfiguration").
 *
 * Source: https://github.com/NovaLux12/carelink-api-research/blob/main/findings-log/medtronic-carelink-2026-07-21/README.md line 26 and
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
 * Named error for "the identity endpoint answered, but not with a user record".
 *
 * Separate from `NoAuth0SSOConfigurationError` on purpose: that one is about the
 * *discovery* document and the app-version pin, this one is about
 * `/patient/users/me` and the identity namespace. They point at different fixes
 * and must not be grepped as one marker.
 *
 * Why this exists (area AO / research `docs/02` §4): the bridge asks
 * `GET {host}/patient/users/me` for the account identity, while the official
 * app uses `/api/carepartner/v2/{users/me,links/patients}`. Both 401
 * unauthenticated, so which one a given token can actually read is unverified
 * from outside — the carepartner/v2 namespace is account-gated and NOT
 * implemented. What can be fixed without credentials is the failure mode: before
 * this guard, a 200 carrying anything that is not a user record (an HTML error
 * page, a JSON array, `{"error":{"type":"InvalidToken"}}`, a bare number) was
 * assigned to `currentUser`, produced an empty `role`, fell through the legacy
 * chain, and ended as an empty `{}` payload reported as success — a silent
 * zero-data fetch with no error to grep.
 */
export class UnexpectedUserInfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedUserInfoError';
    Object.setPrototypeOf(this, UnexpectedUserInfoError.prototype);
  }
}

/**
 * Assert that a `/patient/users/me` body is a user record — a non-null,
 * non-array object — and return it typed as one.
 *
 * Deliberately SHAPE-only, not field-strict:
 *
 *  - A body that is not an object at all cannot be an account record under any
 *    namespace, so it fails loudly here rather than becoming an empty role and
 *    an empty data payload three calls later.
 *  - A body that IS an object but omits `username` or `role` does not throw.
 *    `username` legitimately differs from `CARELINK_USERNAME` and callers
 *    already fall back to the configured value (pinned by
 *    test/username-source.test.ts); a missing `role` is tolerated by the legacy
 *    routing. Tightening those would turn a tolerated field difference into an
 *    outage.
 *  - The ONE exception to that leniency is an object that carries a top-level
 *    `error` and no usable `role`: the vendor's own rejection envelope is
 *    `{"error":{"type":"InvalidToken"}}`, and it can arrive with a 200. That is
 *    a failure wearing a success status, not a field difference.
 *
 * `context` carries what an operator needs and nothing that could leak account
 * data: the URL and the region. The body itself is never quoted — it may carry
 * the account's username or e-mail. `error.type` IS quoted: it is a vendor
 * error code, not account data, and it is the most greppable thing available.
 */
export function assertUserInfoShape(
  body: unknown,
  context: { url: string; region?: string },
): Record<string, unknown> {
  const isRecord =
    typeof body === 'object' && body !== null && !Array.isArray(body);

  if (!isRecord) {
    const observed = Array.isArray(body)
      ? `an array of ${body.length} element(s)`
      : body === null
        ? 'null'
        : `a ${typeof body}`;
    throw new UnexpectedUserInfoError(
      `Identity endpoint ${context.url} returned HTTP 200 with ${observed}, ` +
      `which is not a user record (expected a JSON object with at least "role"; ` +
      `${context.region ? `region "${context.region}", ` : ''}` +
      `no credentials in the body are logged). The bridge cannot resolve a ` +
      `username or role from this, so every data call downstream would be ` +
      `addressed to an empty identity — stopping here instead of uploading an ` +
      `empty payload. Usual causes: the token is not valid for the carelink ` +
      `host's /patient namespace (the official app uses /api/carepartner/v2), ` +
      `or a gateway returned an HTML body with a 200.`,
    );
  }

  // An OBJECT body can still be an error: the vendor's own 401 shape is
  // `{"error":{"type":"InvalidToken"}}`, and a 200 carrying that envelope is
  // indistinguishable from a user record purely by `typeof`. It is only
  // recognisable by the `error` key, which is why the shape test above is not
  // sufficient on its own.
  //
  // Narrow by construction: an envelope is `error` present AND no usable `role`.
  // A user record carries `role` (the legacy routing branches on it), so the
  // conjunction cannot reject one, and a record that merely happens to carry an
  // unrelated `error` field alongside its role is still accepted.
  const errorField = (body as Record<string, unknown>)['error'];
  const roleField = (body as Record<string, unknown>)['role'];
  const hasRole = typeof roleField === 'string' && roleField.trim() !== '';
  if (errorField !== undefined && !hasRole) {
    const type =
      typeof errorField === 'object' && errorField !== null
        ? (errorField as Record<string, unknown>)['type']
        : undefined;
    throw new UnexpectedUserInfoError(
      `Identity endpoint ${context.url} returned HTTP 200 carrying an error envelope` +
      `${typeof type === 'string' ? ` (error.type="${type}")` : ''} instead of a user record` +
      `${context.region ? ` [region "${context.region}"]` : ''}. The endpoint reports failure ` +
      `with a 200 here, so the status line is not an oracle: the token was rejected even ` +
      `though nothing threw. The bridge reads identity from /patient/users/me while the ` +
      `official app reads /api/carepartner/v2/users/me, so this is the likely place a token ` +
      `valid for one namespace and not the other shows up. Not uploading an empty payload.`,
    );
  }

  return body as Record<string, unknown>;
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

  // The selector, with a defensive default.
  //
  // ⚠ `?? 'Auth0SSOConfiguration'` is **unproven-but-harmless, and deliberately
  // kept** — do not read it as a live code path. Area AO (2026-11-11 §4)
  // measured it against every entry this project has a record of: across the
  // **67 `CP[]` entries** of area AO's ledger and area AH's, on three hosts,
  // `UseSSOConfiguration` and `Auth0SSOConfiguration` appear **together or not
  // at all** (0 entries carry the Auth0 key while the selector is missing), and
  // where both are present the selector holds the literal string
  // `Auth0SSOConfiguration`. So the right operand cannot be reached by any
  // recorded document: the expression resolves on its left operand every time.
  //
  // Why keep it rather than delete it:
  //   1. Deleting it changes the failure mode of an unseen document from "we
  //      read the Auth0 key the vendor has always published under that exact
  //      name" to "we throw despite the key being right there". The default is
  //      the name the live documents use verbatim, so it can only help.
  //   2. It is not masking a misconfiguration: the track gate above runs first
  //      and fails closed, so an entry that reaches this line is already on
  //      cumulus v13. A wrong-track cell can never be silently rescued here.
  //   3. It costs nothing at runtime — one nullish check on a value that is
  //      already in hand.
  //
  // What it must NOT be used for is a claim that the bridge supports documents
  // where the selector is absent. It does not; that shape has never been
  // observed (INFERRED from AO's key-membership measurement, not executed
  // against the vendor's server).
  const explicitKey = cpEntry.UseSSOConfiguration;
  const key = explicitKey ?? 'Auth0SSOConfiguration';
  const candidate = cpEntry[key];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }

  // Name WHICH unresolved shape this is, because the three need different
  // fixes and they arrive as the same `undefined` otherwise. This is the
  // legibility requirement for area AO's `3.9`/`3.10` case: there the entry
  // carries no Auth0 key at all, and "no URL resolved" alone would send an
  // operator hunting the wrong field.
  const carrier = Object.prototype.hasOwnProperty.call(cpEntry, key);
  const observed =
    explicitKey === undefined
      ? `the entry carries no UseSSOConfiguration selector and no ` +
        `${carrier ? 'usable' : 'missing'} "${key}" value`
      : !carrier
        ? `UseSSOConfiguration="${explicitKey}" names a key this entry does not carry`
        : `UseSSOConfiguration="${explicitKey}" names "${key}", whose value is ` +
          `${typeof candidate === 'string' ? 'an empty string' : `not a string (got ${typeof candidate})`}`;

  throw new NoAuth0SSOConfigurationError(
    `Discovery returned no Auth0 SSO config URL for region "${context.region}" ` +
    `(UseSSOConfiguration=${explicitKey ?? 'absent'}) — ${observed}. This usually means ` +
    `DISCOVERY_APP_VERSION ("${context.appVersion}") points at a config track without Auth0, ` +
    `which is the shape android/3.9, 3.10 and every 4.x tail return (area AO/AH measured the ` +
    `Auth0 key as absent there; it is present on 3.5–3.8). ` +
    `Fix: keep it on a version known to return Auth0SSOConfiguration, i.e. one of the ` +
    `verified cumulus-v13 family: ${VERIFIED_AUTH0_V13_FAMILY.join(', ')}.`,
  );
}
