/**
 * Refresh-failure classification predicate.
 *
 * The bridge previously deleted `logindata.json` on *any* exception thrown
 * from the refresh code path, which conflated three distinct failure modes:
 *
 *   (a) Permanent auth failures — the refresh token is invalid and the
 *       operator must re-login. OAuth signals this with HTTP 400 + body
 *       `error: 'invalid_grant'` (refresh token expired/revoked) or
 *       HTTP 400 + body `error: 'invalid_client'`. Delete the token file.
 *
 *   (b) Transport / 5xx / 429 failures — server is unreachable, rate-
 *       limiting, or transiently broken. Refresh token is still good;
 *       retain the file so the next fetch cycle can re-attempt refresh.
 *
 *   (c) Non-OAuth exceptions thrown from our own code path
 *       (`writeLoginDataAtomic` EACCES / ENOSPC, malformed JSON, etc.)
 *       — these are local-disk failures, not Auth0 contracts. Retain
 *       the file and surface the real error.
 *
 * The predicate is conservative: it returns `true` ONLY for the two
 * specific OAuth error codes Medtronic's Auth0 tenant emits. Every
 * other error returns `false` (retain + rethrow). This avoids
 * accidentally deleting the token file on a transient 5xx, a 429
 * rate-limit, a network reset, or a local write failure.
 *
 * Source: research/medtronic-carelink-2026-07-21/02-ecosystem-parity.md
 * (memo line 40: "classify permanent auth failures separately from
 * transport/5xx failures; honour Retry-After, add jitter, use capped
 * exponential delay, use status-aware retry").
 */
const PERMANENT_OAUTH_ERRORS: Readonly<Record<string, true>> = Object.freeze({
  invalid_grant: true,
  invalid_client: true,
});

/**
 * Returns true when `error` represents a permanent Auth0 refresh failure
 * that justifies deleting the cached `logindata.json`. Returns false
 * for transport errors, 5xx, 429, and any non-Axios exception —
 * those are recoverable and the cached refresh token may still be valid.
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
  const r = response as { status?: unknown; data?: unknown };
  if (r.status !== 400) return false;

  // 400 alone is not enough — many Auth0 paths return 400 for malformed
  // requests, missing fields, etc. The OAuth RFC 6749 §5.2 contract says
  // the `error` field of the JSON body identifies the failure mode.
  const data = r.data;
  if (!data || typeof data !== 'object') return false;
  const d = data as { error?: unknown };
  return typeof d.error === 'string' && PERMANENT_OAUTH_ERRORS[d.error] === true;
}
