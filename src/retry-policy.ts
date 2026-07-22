/**
 * Status-aware retry policy for CareLink fetch attempts.
 *
 * Source: research/medtronic-carelink-2026-07-21/02-ecosystem-parity.md
 * (memo line 40: "classify permanent auth failures separately from
 * transport/5xx failures; honour Retry-After, add jitter, use capped
 * exponential delay, use status-aware retry").
 *
 * Behaviors (load-bearing for safety):
 *   - Permanent 4xx (other than 401/403, which the auth path handles):
 *     fail fast. Retrying a 404 or 403 just hammers a host that has
 *     nothing to give us.
 *   - 429 Too Many Requests: honour the `Retry-After` header value
 *     (seconds or HTTP-date) up to a ceiling. The server is the
 *     authority on how long to wait.
 *   - 5xx: retry with capped exponential backoff + jitter.
 *   - Transport errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, etc.) with
 *     NO response attached: retry with capped exponential backoff + jitter.
 *
 * Capping the exponential delay prevents a 3-attempt loop from
 * extending into a multi-minute outage window. The default cap of
 * 30s matches the kind of timeouts the public memo references.
 *
 * IMPORTANT: inspection order. Axios sets BOTH `code`
 * (ERR_BAD_REQUEST for 4xx, ERR_BAD_RESPONSE for 5xx) AND `response`
 * on HTTP errors. A code-only check that runs before response
 * inspection would misclassify every 4xx/5xx as "transport" and never
 * reach the Retry-After / 5xx / permanent-status logic. The fix is to
 * inspect `e.response` first; only when it is absent do we look at
 * `e.code` to recognise genuine transport errors.
 */

// Default cap for the exponential-with-jitter delay. Anything longer
// than this gets clamped. Picked to keep the bridge responsive even on
// a 3-attempt retry loop.
const DEFAULT_MAX_DELAY_MS = 30_000;
// Default initial delay. The fetch loop currently does 2s, 4s, 8s;
// we keep 2s as the base so an existing operator's experience matches.
const DEFAULT_BASE_DELAY_MS = 2_000;

const PERMANENT_STATUS: ReadonlySet<number> = new Set([400, 404, 410, 422]);

export type RetryDecision =
  | { kind: 'fail-fast'; reason: 'permanent-status' | 'unknown-error' }
  | { kind: 'retry'; delayMs: number; reason: 'server-5xx' | 'transport' | 'rate-limited' };

export interface DecideRetryOptions {
  /** 1-based; the FIRST attempt is `1`. */
  attempt: number;
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Decides whether a fetch attempt should retry, fail fast, or honour a
 * server-set delay. Inspects the error and any optional response headers
 * to derive the delay.
 *
 * The caller is responsible for the loop counter; this helper only
 * classifies the current attempt.
 */
export function decideRetry(
  error: unknown,
  options: DecideRetryOptions,
): RetryDecision {
  const baseMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const capMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  // Last attempt — never retry, regardless of classification. The caller
  // throws the final error.
  if (options.attempt >= options.maxAttempts) {
    return { kind: 'fail-fast', reason: 'unknown-error' };
  }

  if (!error || typeof error !== 'object') {
    return { kind: 'fail-fast', reason: 'unknown-error' };
  }

  const e = error as {
    response?: { status?: unknown; headers?: unknown };
    code?: unknown;
  };

  // Inspect `e.response` FIRST. Axios sets BOTH `code` and `response` on
  // HTTP errors, so a code-only check would misclassify every 4xx/5xx
  // as transport and never reach the status-aware logic below.
  const response = e.response;
  if (response && typeof response === 'object') {
    const status = response.status;
    if (typeof status !== 'number') {
      return { kind: 'fail-fast', reason: 'unknown-error' };
    }

    // 401/403 is handled by the auth path (forceRefresh on next
    // attempt), not the retry policy. A bare 401 here means the auth
    // path already failed to refresh and we should propagate.
    if (status === 401 || status === 403) {
      return { kind: 'fail-fast', reason: 'permanent-status' };
    }

    // 429 Rate-limited. The server is the authority on how long to wait.
    if (status === 429) {
      const retryAfter = readRetryAfter(response.headers);
      if (retryAfter != null) {
        // Cap server-set delay at maxDelayMs so a misconfigured server
        // can't lock the bridge out for hours.
        return {
          kind: 'retry',
          delayMs: Math.min(retryAfter, capMs),
          reason: 'rate-limited',
        };
      }
      // No Retry-After — fall back to capped exponential + jitter.
      return {
        kind: 'retry',
        delayMs: jitteredBackoff(options.attempt, baseMs, capMs),
        reason: 'rate-limited',
      };
    }

    if (PERMANENT_STATUS.has(status)) {
      return { kind: 'fail-fast', reason: 'permanent-status' };
    }

    if (status >= 500) {
      return {
        kind: 'retry',
        delayMs: jitteredBackoff(options.attempt, baseMs, capMs),
        reason: 'server-5xx',
      };
    }

    // 1xx/2xx/3xx are not failure statuses; treat as unknown.
    return { kind: 'fail-fast', reason: 'unknown-error' };
  }

  // No HTTP response → real transport failure (ECONNRESET, ETIMEDOUT,
  // ENOTFOUND). Axios sets `code` for these and the response is absent.
  if (e.code && typeof e.code === 'string' && e.code.startsWith('E')) {
    return {
      kind: 'retry',
      delayMs: jitteredBackoff(options.attempt, baseMs, capMs),
      reason: 'transport',
    };
  }

  // No response, no transport code — likely a local exception thrown by
  // our own code path. Fail fast.
  return { kind: 'fail-fast', reason: 'unknown-error' };
}

/**
 * Full-jitter exponential backoff. The actual sleep is drawn uniformly
 * from [0, min(cap, base * 2^attempt)] so multiple bridge instances
 * herding on a shared host don't all retry in lockstep.
 *
 * Source: AWS architecture blog "Exponential Backoff And Jitter" (full
 * jitter variant) — applicable here because Medtronic's CareLink is a
 * single shared backend, and herd effects would amplify any 5xx.
 */
function jitteredBackoff(attempt: number, baseMs: number, capMs: number): number {
  const expCap = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * expCap);
}

/**
 * Reads a `Retry-After` header value. Per RFC 7231 §7.1.3, the value is
 * either an integer number of seconds OR an HTTP-date. Returns the
 * delay in milliseconds, or `null` when the header is missing,
 * malformed, or in the past.
 */
function readRetryAfter(headers: unknown): number | null {
  if (!headers || typeof headers !== 'object') return null;

  // Axios normalises headers to a plain object keyed by lowercase name.
  const h = headers as Record<string, unknown>;
  const raw = h['retry-after'] ?? h['Retry-After'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  // Numeric seconds.
  if (typeof raw === 'number' || /^\d+$/.test(String(raw).trim())) {
    const seconds = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }

  // HTTP-date.
  const dateMs = Date.parse(String(raw));
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : null;
}
