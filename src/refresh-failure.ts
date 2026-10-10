/**
 * Refresh-failure classification predicate.
 *
 * The bridge previously deleted `logindata.json` on *any* exception thrown
 * from the refresh code path, which conflated three distinct failure modes:
 *
 *   (a) Permanent auth failures — the refresh token is invalid and the
 *       operator must re-login. Auth0 / OAuth signals this with HTTP 400
 *       + body `error: 'invalid_grant'` (refresh token expired/revoked)
 *       or HTTP 400 + body `error: 'invalid_client'`, but it also
 *       surfaces the same condition as HTTP 401 / 403 with an empty body
 *       (account deactivated, refresh token revoked out-of-band by the
 *       CareLink phone app, tenant policy change, etc.). Any 4xx
 *       response from the refresh endpoint — with no `Retry-After`
 *       header — means the refresh token is not going to come back to
 *       life by retrying. Delete the token file.
 *
 *   (b) Transport / 5xx / 429-with-Retry-After failures — server is
 *       unreachable, rate-limiting, or transiently broken. Refresh token
 *       is still good; retain the file so the next fetch cycle can
 *       re-attempt refresh.
 *
 *   (c) Non-OAuth exceptions thrown from our own code path
 *       (`writeLoginDataAtomic` EACCES / ENOSPC, malformed JSON, etc.)
 *       — these are local-disk failures, not Auth0 contracts. Retain
 *       the file and surface the real error.
 *
 * The predicate is conservative on transport failures and liberal on
 * 4xx-from-refresh: a 4xx without `Retry-After` is treated as a
 * permanent rejection. The original motivation (issue #65) was that
 * Auth0 returns HTTP 403 with an empty body when the refresh token is
 * revoked (most commonly because the operator logged in on the
 * CareLink phone app, which invalidates the bridge's session), and the
 * previous narrow predicate (400 + invalid_grant/invalid_client only)
 * treated those 403s as recoverable — sending the bridge into an
 * infinite refresh loop, with the circuit breaker eventually opening
 * and the operator seeing hundreds of consecutive failures with no
 * actionable signal. Prompting for re-login is the right recovery.
 *
 * Source: https://github.com/NovaLux12/carelink-api-research/blob/main/findings-log/medtronic-carelink-2026-07-21/02-ecosystem-parity.md
 * (memo line 40: "classify permanent auth failures separately from
 * transport/5xx failures; honour Retry-After, add jitter, use capped
 * exponential delay, use status-aware retry").
 */

/**
 * Returns true when `error` represents a permanent Auth0 refresh failure
 * that justifies deleting the cached `logindata.json`. Returns false
 * for transport errors, 5xx, 4xx-with-Retry-After, and any non-Axios
 * exception — those are recoverable and the cached refresh token may
 * still be valid.
 *
 * The rule is: any HTTP 4xx from the refresh endpoint, with no
 * `Retry-After` header, is permanent. 5xx and `Retry-After` 4xx are
 * transient. Anything else (transport errors, local exceptions) defaults
 * to recoverable.
 *
 * Accepts the loose `unknown` shape so callers don't need to narrow
 * before passing the error in.
 */
export function isPermanentRefreshFailure(error: unknown): boolean {
  // Axios HTTP errors carry the response on `error.response` (an Axios
  // extension; not on standard Error). Inspect it without forcing a cast
  // that would mislead readers — narrow inline.
  if (!error || typeof error !== 'object') return false;
  const e = error as { response?: unknown; code?: unknown };

  const response = e.response;
  if (!response || typeof response !== 'object') return false;
  const r = response as { status?: unknown; data?: unknown; headers?: unknown };
  if (typeof r.status !== 'number') return false;

  // 5xx is always transient — server is the problem, not the token.
  // The retry-policy's capped-exponential + jitter handles 5xx.
  if (r.status >= 500) return false;

  // Only 4xx-from-refresh can be a permanent auth failure. Anything
  // else (1xx/2xx/3xx) reaching here is a non-error status — treat as
  // not-permanent so the caller doesn't accidentally delete the token
  // file on a successful-but-misclassified response.
  if (r.status < 400) return false;
  if (r.status >= 500) return false; // (kept for symmetry with the >=500 guard)

  // 4xx with Retry-After: the server is asking us to back off and try
  // again later. That's transient, regardless of the body's `error`
  // field. (Retry-After on a 4xx is uncommon but legal per RFC 7231;
  // honour it.)
  if (hasRetryAfter(r.headers)) return false;

  // Permanent. The prior implementation also keyed on the OAuth
  // `error` field (invalid_grant / invalid_client) at status 400, but
  // Auth0 demonstrably returns HTTP 401 / 403 with empty bodies when
  // the refresh token has been revoked out-of-band (issue #65,
  // carepartner account). Widening the predicate to "any 4xx with no
  // Retry-After" catches all of those without losing the 400+invalid_*
  // behaviour, which remains a subset.
  //
  // We do NOT consult r.data here on purpose: an empty / non-OAuth
  // body must not trick the bridge into retaining a dead token. If a
  // future Auth0 tenant ever returns 400 + a body that signals
  // "please retry", it should do so with a Retry-After header, and
  // this predicate will correctly keep the token file.
  return true;
}

/**
 * Reads the `Retry-After` header from an Axios response.headers bag.
 * Returns false when the header is absent — the caller treats that as
 * "no backoff hint from the server", which is the signal to classify
 * 4xx as permanent.
 *
 * We don't parse the value here (we don't need the delay in
 * milliseconds; the refresh path always rethrows on non-2xx and lets
 * the fetch loop's decideRetry apply its own backoff). Presence alone
 * is the contract.
 */
function hasRetryAfter(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  const h = headers as Record<string, unknown>;
  // Axios normalises header keys to lowercase. Look for the canonical
  // name and a few case variants the broader HTTP ecosystem uses.
  const candidates = ['retry-after', 'Retry-After', 'RETRY-AFTER'];
  for (const key of candidates) {
    const v = h[key];
    if (typeof v === 'string' && v.trim() !== '') return true;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return true;
  }
  return false;
}