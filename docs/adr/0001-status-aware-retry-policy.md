# 0001 — Status-aware retry policy with jitter

## Status

Accepted (since v0.2.0, 2026-07-22).

## Context

The CareLink fetch loop encounters four distinct failure modes:

1. **Permanent 4xx (other than 401/403).** A 404 from the data endpoint
   means the URL is wrong. Retrying just hammers a host that has
   nothing to give us.
2. **429 Too Many Requests.** The server is rate-limiting us. The
   `Retry-After` header (RFC 7231 §7.1.3) is the authority on how long
   to wait — it can be either a number of seconds or an HTTP-date.
3. **5xx server errors.** The server is broken or under load. Retry
   with backoff.
4. **Transport errors** (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, etc.)
   with no HTTP response attached. The server may be reachable; the
   connection just failed. Retry with backoff.

The previous retry path (pre-v0.2.0) was a **fixed 2s / 4s / 8s** delay
sequence regardless of failure mode. It had three problems:

- It retried permanent 4xx errors. A 404 from a removed API version
  would loop until the next interval instead of failing fast.
- It did not honour `Retry-After`. A 429 with `Retry-After: 25` would
  retry after 2 seconds, get rate-limited again, retry after 4 seconds,
  get rate-limited again, retry after 8 seconds. Each retry is a
  guaranteed 429.
- It had no jitter. A CareLink outage that took down 10 instances
  simultaneously would have all 10 instances retry at the same wall-
  clock instant, thundering the recovery.

401/403 responses are short-circuited before the retry policy runs —
they go through the `forceRefresh` path in `src/carelink/client.ts`
(see the comment block on `authenticate()`), so token refresh happens
on the next iteration rather than retrying with a dead token.

## Decision

`decideRetry(error, options)` in `src/retry-policy.ts` classifies each
failed attempt:

- **Permanent 4xx (`400`, `404`, `410`, `422`) → fail fast.** No retry.
  Logged as the failure mode it is, not as "fetch failed."
- **429 → honour `Retry-After`.** Parse the header as either a delta-
  seconds or HTTP-date, clamp to a ceiling (default 30s), wait that
  long, retry. If the header is missing or unparseable, fall through to
  the 5xx path.
- **5xx → capped full-jitter exponential backoff.** Base 2s, cap 30s,
  `delay = random(0, min(cap, base * 2^attempt))`.
- **Transport error (no response attached) → same as 5xx.**

**Inspection order matters.** Axios sets BOTH `code`
(`ERR_BAD_REQUEST` for 4xx, `ERR_BAD_RESPONSE` for 5xx) AND `response`
on HTTP errors. A code-only check that runs before response inspection
misclassifies every 4xx/5xx as "transport" and never reaches the
`Retry-After` / 5xx / permanent-status logic. The implementation
inspects `error.response` first; only when it is absent do we look at
`error.code` to recognise genuine transport errors.

## Consequences

- **Easier:** Permanent failures surface immediately instead of
  consuming three retry slots. A 404 from a removed API version fails
  in 2s, not 26s.
- **Easier:** Rate-limit windows from Medtronic are respected
  automatically. No special-case code in the fetch loop.
- **Easier:** Coordinated retries from multiple bridge instances no
  longer herd onto the same wall-clock instant.
- **Harder:** Operators reading logs see a 2s / 4s / 8s pattern and
  expect it; the new pattern is "fail fast for 4xx, `Retry-After` for
  429, jittered for 5xx." Documentation has to explain the new shape.
- **Harder:** The `Retry-After` HTTP-date parser is small and
  conservative; non-standard formats (delta-seconds with extra
  whitespace, HTTP-date with two-digit years) may fall through to
  jittered backoff instead of waiting the requested duration. This is
  the right failure mode — wait shorter, not longer, on ambiguous
  signals.

## What reverses it

- If Medtronic's `Retry-After` header is ever found to lie (claiming
  a delay shorter than the actual rate-limit window), the policy
  should add a floor below which `Retry-After` is not honoured.
- If a real CareLink failure mode is misclassified by the permanent-
  status set, the set should be expanded rather than the policy
  reverted. The 4xx set is `[400, 404, 410, 422]`; other 4xx are
  treated as recoverable.
- If jitter is found to interact badly with a downstream load balancer
  (it shouldn't — uniform jitter is exactly what load balancers want),
  the jittered backoff is the part to revisit, not the fail-fast
  policy.

## Notes

- Source: `src/retry-policy.ts` (the file's own header comment records
  the four behaviours and the inspection-order trap).
- v0.2.0 CHANGELOG entry documents the wiring change.
- 401/403 path is intentionally outside this ADR. It is handled by
  `authenticate()` and the `forceRefresh` flag in
  `src/carelink/client.ts`; see the comment block on `authenticate()`
  for the successive-401 regression that drove the current shape.
