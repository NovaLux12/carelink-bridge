import { describe, it, expect } from 'vitest';
import { isPermanentRefreshFailure } from '../src/refresh-failure.js';

/**
 * Refresh-failure classification contract.
 *
 * Source: research/medtronic-carelink-2026-07-21/02-ecosystem-parity.md
 * (memo line 40: "classify permanent auth failures separately from
 * transport/5xx failures").
 *
 * Three behaviors the predicate must enforce:
 *   1. HTTP 400 + body `error: 'invalid_grant'` → permanent (delete token)
 *   2. HTTP 400 + body `error: 'invalid_client'` → permanent (delete token)
 *   3. Transport errors (ECONNRESET, 5xx, 429) → recoverable (retain token)
 *
 * Anything not matching the OAuth 400 invalid_grant/invalid_client shape
 * defaults to recoverable. This is conservative: a future Auth0 surface
 * that returns a new error code does not silently delete the token file.
 */

function axiosError(status: number, body: unknown): unknown {
  return {
    response: { status, data: body },
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
      // predicate must key on `error` only; the description is human text.
      expect(
        isPermanentRefreshFailure(axiosError(400, {
          error: 'invalid_grant',
          error_description: 'Refresh token expired',
        })),
      ).toBe(true);
    });
  });

  describe('recoverable (token MUST be retained)', () => {
    it('returns false for HTTP 400 with a non-recognised error code', () => {
      // 400 is not enough — many Auth0 paths return 400 for malformed
      // requests. The `error` field identifies the failure mode.
      expect(
        isPermanentRefreshFailure(axiosError(400, { error: 'invalid_request' })),
      ).toBe(false);
    });

    it('returns false for HTTP 400 with no error field at all', () => {
      expect(
        isPermanentRefreshFailure(axiosError(400, { detail: 'something else' })),
      ).toBe(false);
    });

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

    it('returns false for HTTP 429 (rate limit)', () => {
      expect(
        isPermanentRefreshFailure(axiosError(429, { error: 'rate_limited' })),
      ).toBe(false);
    });

    it('returns false for HTTP 401/403 (handled by forceRefresh, not deletion)', () => {
      // The 401/403 path is for the data endpoint, not the refresh endpoint.
      // If the refresh endpoint ever returns 401/403, treat it as a token
      // we may retry, not as a deletion signal.
      expect(isPermanentRefreshFailure(axiosError(401, null))).toBe(false);
      expect(isPermanentRefreshFailure(axiosError(403, null))).toBe(false);
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

    it('returns false for an error-like object with response but no data', () => {
      expect(isPermanentRefreshFailure({ response: { status: 400 } })).toBe(false);
    });
  });
});
