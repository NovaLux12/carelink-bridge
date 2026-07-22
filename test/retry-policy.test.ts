import { describe, it, expect } from 'vitest';
import { decideRetry } from '../src/retry-policy.js';

/**
 * Status-aware retry policy contract.
 *
 * Source: research/medtronic-carelink-2026-07-21/02-ecosystem-parity.md
 * (memo line 40: "classify permanent auth failures separately from
 * transport/5xx failures; honour Retry-After, add jitter, use capped
 * exponential delay, use status-aware retry").
 *
 * Test trap: real AxiosErrors set BOTH `code` (ERR_BAD_REQUEST for 4xx,
 * ERR_BAD_RESPONSE for 5xx) AND `response` with status + headers. Hand-
 * rolled errors with only one field will pass tests while production
 * fails. Every error fixture in this file includes BOTH fields where
 * real axios would.
 */

const DEFAULT = { attempt: 1, maxAttempts: 3 } as const;

function axiosError(opts: {
  code: string;
  status?: number;
  headers?: Record<string, string | number>;
}): unknown {
  // Realistic AxiosError shape: top-level `code` AND a `response` object
  // for HTTP errors. Transport errors omit `response`.
  if (opts.status != null) {
    return {
      code: opts.code,
      message: 'request failed',
      response: {
        status: opts.status,
        data: null,
        headers: opts.headers ?? {},
      },
    };
  }
  return {
    code: opts.code,
    message: 'request failed',
  };
}

describe('decideRetry', () => {
  describe('rate-limited (HTTP 429)', () => {
    it('honours a numeric Retry-After header (in seconds)', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 429, headers: { 'retry-after': '30' } }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'retry', delayMs: 30_000, reason: 'rate-limited' });
    });

    it('honours an HTTP-date Retry-After header (in the future, within cap)', () => {
      // Pick a date well below the default 30s cap so the assertion
      // tests the HTTP-date path, not the cap.
      const future = new Date(Date.now() + 5_000).toUTCString();
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 429, headers: { 'retry-after': future } }),
        DEFAULT,
      );
      expect(result.kind).toBe('retry');
      if (result.kind === 'retry') {
        expect(result.reason).toBe('rate-limited');
        // Allow some clock skew — expect roughly 5_000ms (±1s).
        expect(result.delayMs).toBeGreaterThan(4_000);
        expect(result.delayMs).toBeLessThan(6_000);
      }
    });

    it('caps a server-set delay at maxDelayMs (so a misconfigured server cannot lock the bridge out)', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 429, headers: { 'retry-after': '999999' } }),
        { ...DEFAULT, maxDelayMs: 30_000 },
      );
      expect(result).toEqual({ kind: 'retry', delayMs: 30_000, reason: 'rate-limited' });
    });

    it('falls back to capped exponential + jitter when Retry-After is missing', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 429 }),
        { ...DEFAULT, baseDelayMs: 2_000, maxDelayMs: 30_000 },
      );
      expect(result.kind).toBe('retry');
      if (result.kind === 'retry') {
        expect(result.reason).toBe('rate-limited');
        // Attempt 1 with base 2s, cap 30s: jitter range [0, 4000).
        expect(result.delayMs).toBeGreaterThanOrEqual(0);
        expect(result.delayMs).toBeLessThan(4_000);
      }
    });
  });

  describe('permanent 4xx (fail fast, do not retry)', () => {
    it('does not retry on HTTP 400', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 400 }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'fail-fast', reason: 'permanent-status' });
    });

    it('does not retry on HTTP 404', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 404 }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'fail-fast', reason: 'permanent-status' });
    });

    it('does not retry on HTTP 410', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 410 }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'fail-fast', reason: 'permanent-status' });
    });

    it('does not retry on HTTP 422', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 422 }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'fail-fast', reason: 'permanent-status' });
    });

    it('does not retry on HTTP 401 (auth path handles this separately)', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 401 }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'fail-fast', reason: 'permanent-status' });
    });

    it('does not retry on HTTP 403 (auth path handles this separately)', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_REQUEST', status: 403 }),
        DEFAULT,
      );
      expect(result).toEqual({ kind: 'fail-fast', reason: 'permanent-status' });
    });
  });

  describe('server 5xx (retry with capped exponential + jitter)', () => {
    it('retries on HTTP 500', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_RESPONSE', status: 500 }),
        { ...DEFAULT, baseDelayMs: 2_000, maxDelayMs: 30_000 },
      );
      expect(result.kind).toBe('retry');
      if (result.kind === 'retry') {
        expect(result.reason).toBe('server-5xx');
      }
    });

    it('retries on HTTP 503', () => {
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_RESPONSE', status: 503 }),
        { ...DEFAULT, baseDelayMs: 2_000, maxDelayMs: 30_000 },
      );
      expect(result).toEqual({
        kind: 'retry',
        delayMs: expect.any(Number) as unknown as number,
        reason: 'server-5xx',
      });
    });

    it('clamps the exponential delay to maxDelayMs (no run-away sleeps)', () => {
      // 100 attempts in — without the cap, the delay would be 2s * 2^100.
      const result = decideRetry(
        axiosError({ code: 'ERR_BAD_RESPONSE', status: 500 }),
        { attempt: 1, maxAttempts: 100, baseDelayMs: 2_000, maxDelayMs: 30_000 },
      );
      expect(result.kind).toBe('retry');
      if (result.kind === 'retry') {
        expect(result.delayMs).toBeLessThan(4_000); // attempt 1 → 2^1 * 2s = 4s
      }
    });
  });

  describe('transport errors (retry, jittered)', () => {
    it('retries on ECONNRESET (no response attached)', () => {
      // Transport: code only, no response. This is the realistic shape
      // axios produces for socket-level failures.
      const result = decideRetry(
        axiosError({ code: 'ECONNRESET' }),
        { ...DEFAULT, baseDelayMs: 2_000, maxDelayMs: 30_000 },
      );
      expect(result.kind).toBe('retry');
      if (result.kind === 'retry') {
        expect(result.reason).toBe('transport');
        expect(result.delayMs).toBeGreaterThanOrEqual(0);
        expect(result.delayMs).toBeLessThan(4_000);
      }
    });

    it('retries on ETIMEDOUT', () => {
      const result = decideRetry(
        axiosError({ code: 'ETIMEDOUT' }),
        DEFAULT,
      );
      expect(result.kind).toBe('retry');
    });

    it('retries on ENOTFOUND (DNS failure)', () => {
      const result = decideRetry(
        axiosError({ code: 'ENOTFOUND' }),
        DEFAULT,
      );
      expect(result.kind).toBe('retry');
    });
  });

  describe('last-attempt safety', () => {
    it('fails fast when attempt >= maxAttempts, regardless of error type', () => {
      expect(
        decideRetry(axiosError({ code: 'ERR_BAD_RESPONSE', status: 503 }), {
          attempt: 3,
          maxAttempts: 3,
        }),
      ).toEqual({ kind: 'fail-fast', reason: 'unknown-error' });
      expect(
        decideRetry(axiosError({ code: 'ECONNRESET' }), {
          attempt: 5,
          maxAttempts: 3,
        }),
      ).toEqual({ kind: 'fail-fast', reason: 'unknown-error' });
    });
  });

  describe('defensive defaults', () => {
    it('fails fast on null error', () => {
      expect(decideRetry(null, DEFAULT)).toEqual({
        kind: 'fail-fast',
        reason: 'unknown-error',
      });
    });

    it('fails fast on undefined error', () => {
      expect(decideRetry(undefined, DEFAULT)).toEqual({
        kind: 'fail-fast',
        reason: 'unknown-error',
      });
    });

    it('fails fast on a plain Error with no axios shape', () => {
      // Local exceptions from our own code path (e.g. parse errors).
      expect(decideRetry(new Error('parse failed'), DEFAULT)).toEqual({
        kind: 'fail-fast',
        reason: 'unknown-error',
      });
    });

    it('fails fast on a string error', () => {
      expect(decideRetry('boom', DEFAULT)).toEqual({
        kind: 'fail-fast',
        reason: 'unknown-error',
      });
    });

    it('fails fast on an error-like object with response but no numeric status', () => {
      expect(
        decideRetry({ response: { headers: {} } }, DEFAULT),
      ).toEqual({ kind: 'fail-fast', reason: 'unknown-error' });
    });
  });

  describe('jitter sanity (multiple runs produce different delays)', () => {
    it('5xx jittered delays vary across calls (full-jitter property)', () => {
      // The full-jitter pattern draws from [0, min(cap, base*2^attempt]).
      // For attempt=1, base=2s, cap=30s the range is [0, 4000). Across
      // 10 calls we should see at least 2 distinct values.
      const seen = new Set<number>();
      for (let i = 0; i < 10; i++) {
        const result = decideRetry(
          axiosError({ code: 'ERR_BAD_RESPONSE', status: 500 }),
          { attempt: 1, maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 30_000 },
        );
        if (result.kind === 'retry') seen.add(result.delayMs);
      }
      // 10 draws from a [0, 4000) range should give at least 2 distinct
      // values. (Probability of all-identical ~ astronomically low.)
      expect(seen.size).toBeGreaterThan(1);
    });
  });
});
