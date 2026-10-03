import { describe, it, expect } from 'vitest';
import { isPermanentRefreshFailure } from '../src/refresh-failure.js';

/**
 * Refresh-failure classification contract.
 *
 * Source: research/medtronic-carelink-2026-07-21/02-ecosystem-parity.md
 * (memo line 40: "classify permanent auth failures separately from
 * transport/5xx failures").
 *
 * Issue #65 widened the predicate: any 4xx-from-refresh WITHOUT a
 * `Retry-After` header is permanent. Auth0 has been seen returning HTTP
 * 403 with an empty body when the refresh token is revoked out-of-band
 * (e.g. by the CareLink phone app logging in), so the previous narrow
 * shape (400 + invalid_grant/invalid_client only) let the bridge enter
 * an infinite refresh loop. The broadened shape keeps the OAuth
 * 400+invalid_grant/invalid_client cases as a subset (still permanent)
 * while adding the 401/403-with-empty-body and other unexpected 4xx
 * cases the operator actually hits in production.
 *
 * Four behaviors the predicate must enforce:
 *   1. HTTP 4xx (no Retry-After) → permanent (delete token). The classic
 *      Auth0 invalid_grant / invalid_client shapes are a subset.
 *   2. HTTP 4xx + Retry-After → transient (honour Retry-After).
 *   3. HTTP 5xx → transient (server-side, not token-side).
 *   4. Transport errors (ECONNRESET, ETIMEDOUT, ENOTFOUND) → transient
 *      (network, not token-side).
 *
 * 4xx + Retry-After is a narrow edge case — Auth0 in practice never
 * sends it — but the predicate handles it correctly so a future tenant
 * change can't silently delete the token file.
 */

function axiosError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): unknown {
  return {
    response: { status, data: body, headers },
  };
}

function transportError(code: string): unknown {
  // Axios sets `code` for transport-level failures.
  return { code, message: 'simulated transport error' };
}

describe('isPermanentRefreshFailure', () => {
  describe('permanent (token MUST be deleted)', () => {
    it('returns true for HTTP 400 + invalid_grant', () => {
      expect(
        isPermanentRefreshFailure(axiosError(400, { error: 'invalid_grant' })),
      ).toBe(true);
    });

    it('returns true for HTTP 400 + invalid_client', () => {
      expect(
        isPermanentRefreshFailure(axiosError(400, { error: 'invalid_client' })),
      ).toBe(true);
    });

    it('returns true even when the body also carries an error_description', () => {
      // Auth0 commonly returns both `error` and `error_description`. The
      // predicate must key on status alone (with no Retry-After); the
      // description is human text and must not be inspected.
      expect(
        isPermanentRefreshFailure(axiosError(400, {
          error: 'invalid_grant',
          error_description: 'Refresh token expired',
        })),
      ).toBe(true);
    });

    // Issue #65: this is the regression test that pinned the bug.
    // Auth0 returns HTTP 403 with an empty body when the refresh token
    // has been revoked out-of-band (carepartner account logging in on
    // the CareLink phone app is the canonical trigger). Pre-fix the
    // predicate returned false → bridge looped forever. Post-fix it
    // returns true → bridge prompts for re-login.
    it('returns true for HTTP 403 with an empty body (#65 regression)', () => {
      expect(
        isPermanentRefreshFailure(axiosError(403, null)),
      ).toBe(true);
    });

    it('returns true for HTTP 403 with a JSON body (#65 regression, JSON shape)', () => {
      // Some Auth0 tenants return a small JSON body alongside 403; the
      // predicate must not require an empty body.
      expect(
        isPermanentRefreshFailure(axiosError(403, { error: 'forbidden' })),
      ).toBe(true);
    });

    it('returns true for HTTP 401 with no body', () => {
      expect(
        isPermanentRefreshFailure(axiosError(401, null)),
      ).toBe(true);
    });

    it('returns true for HTTP 404 from the refresh endpoint', () => {
      // Misconfigured token_url or moved endpoint — surface it.
      expect(
        isPermanentRefreshFailure(axiosError(404, { error: 'not_found' })),
      ).toBe(true);
    });

    it('returns true for HTTP 422 (e.g. malformed refresh token)', () => {
      expect(
        isPermanentRefreshFailure(axiosError(422, { error: 'invalid_grant' })),
      ).toBe(true);
    });
  });

  describe('recoverable (token MUST be retained)', () => {
    it('returns false for HTTP 500', () => {
      expect(
        isPermanentRefreshFailure(axiosError(500, { error: 'server_error' })),
      ).toBe(false);
    });

    it('returns false for HTTP 503', () => {
      expect(
        isPermanentRefreshFailure(axiosError(503, { error: 'unavailable' })),
      ).toBe(false);
    });

    it('returns false for HTTP 502 / 504 (transient gateway failures)', () => {
      expect(isPermanentRefreshFailure(axiosError(502, null))).toBe(false);
      expect(isPermanentRefreshFailure(axiosError(504, null))).toBe(false);
    });

    it('returns false for HTTP 429 with a Retry-After header (transient)', () => {
      // Auth0 / a future tenant change could start returning 429 +
      // Retry-After on the refresh endpoint. Server is asking us to
      // back off, so the refresh token may still be valid.
      expect(
        isPermanentRefreshFailure(axiosError(
          429,
          { error: 'rate_limited' },
          { 'retry-after': '5' },
        )),
      ).toBe(false);
    });

    it('returns false for HTTP 403 with a Retry-After header (transient)', () => {
      // 4xx + Retry-After is the narrow edge case the predicate handles
      // to stay robust against future tenant behaviour changes.
      expect(
        isPermanentRefreshFailure(axiosError(
          403,
          { error: 'temporarily_blocked' },
          { 'retry-after': '30' },
        )),
      ).toBe(false);
    });

    it('returns false for HTTP 400 with a Retry-After header (transient)', () => {
      // Same edge case at the OAuth-canonical status.
      expect(
        isPermanentRefreshFailure(axiosError(
          400,
          { error: 'invalid_grant' },
          { 'retry-after': '60' },
        )),
      ).toBe(false);
    });

    it('honours a numeric Retry-After value of 0 as a no-op signal', () => {
      // RFC 7231 allows retry-after=0 (try again immediately). The
      // presence of the header alone signals "transient", so the
      // predicate must classify this as recoverable. The fetch loop's
      // decideRetry decides the *delay*; this predicate decides *whether
      // to delete the token*.
      expect(
        isPermanentRefreshFailure(axiosError(
          429,
          { error: 'rate_limited' },
          { 'retry-after': '0' },
        )),
      ).toBe(false);
    });

    it('returns false for ECONNRESET (transport failure)', () => {
      expect(isPermanentRefreshFailure(transportError('ECONNRESET'))).toBe(false);
    });

    it('returns false for ETIMEDOUT (transport failure)', () => {
      expect(isPermanentRefreshFailure(transportError('ETIMEDOUT'))).toBe(false);
    });

    it('returns false for ENOTFOUND (DNS failure)', () => {
      expect(isPermanentRefreshFailure(transportError('ENOTFOUND'))).toBe(false);
    });
  });

  describe('defensive defaults', () => {
    it('returns false for null', () => {
      expect(isPermanentRefreshFailure(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isPermanentRefreshFailure(undefined)).toBe(false);
    });

    it('returns false for a plain Error with no response', () => {
      // Local exceptions from our own code (e.g. writeLoginDataAtomic's
      // ENOENT/EACCES) must not be classified as permanent.
      expect(isPermanentRefreshFailure(new Error('EACCES'))).toBe(false);
    });

    it('returns false for a string (TypeScript unknown at the boundary)', () => {
      expect(isPermanentRefreshFailure('something')).toBe(false);
    });

    it('returns false for a number', () => {
      expect(isPermanentRefreshFailure(42)).toBe(false);
    });

    it('returns false for an error-like object with response but no status', () => {
      expect(isPermanentRefreshFailure({ response: { data: { error: 'x' } } })).toBe(false);
    });

    it('returns false for an error-like object with response but a non-numeric status', () => {
      expect(isPermanentRefreshFailure({ response: { status: 'bad', data: {} } })).toBe(false);
    });
  });
});