/**
 * Prometheus metrics — zero dependencies, stdlib only.
 *
 * v0.4.0 observability slice (issue #10). In-memory counters/gauges with
 * a hand-rolled exposition renderer. Served over HTTP by
 * src/observe-server.ts (/metrics + /healthz, opt-in via
 * CARELINK_METRICS_PORT); renderPrometheus() is also usable standalone.
 *
 * All labels are low-cardinality (result, endpoint) — never usernames,
 * tokens, or per-record values — so the exposition cannot leak PII.
 *
 * Usage:
 *   import * as metrics from './metrics.js';
 *   metrics.incFetch('success');
 *   metrics.setLastSuccess(Date.now());
 *   metrics.setNewestReading(reading.date);
 *   console.log(metrics.renderPrometheus());
 */

export type FetchResult = 'success' | 'failure';
export type UploadEndpoint = 'entries' | 'devicestatus' | 'treatments';

/**
 * Closed set of upload-failure reasons. Typed (not free-form) so the
 * `reason` label stays low-cardinality: an error string would mint a new
 * series per message and eventually blow up the scrape.
 *
 * `discarded` is its own reason rather than folding into `unknown`: a
 * Nightscout that answers 200 and stores nothing is the silent-failure case
 * src/nightscout/upload.ts throws specifically to surface, and it should be
 * alertable without pattern-matching the log.
 */
export type UploadFailureReason = 'network' | 'http_4xx' | 'http_5xx' | 'discarded' | 'unknown';

export const UPLOAD_ENDPOINTS: readonly UploadEndpoint[] = ['entries', 'devicestatus', 'treatments'];
export const UPLOAD_FAILURE_REASONS: readonly UploadFailureReason[] = [
  'network',
  'http_4xx',
  'http_5xx',
  'discarded',
  'unknown',
];

let fetchesSuccess = 0;
let fetchesFailure = 0;
let uploadsEntries = 0;
let uploadsDevicestatus = 0;
let uploadsTreatments = 0;
let tokenRefreshSuccess = 0;
let tokenRefreshFailure = 0;
let lastSuccessTimestampMs: number | null = null;
let circuitOpen = false;
/** Newest reading timestamp the fetch loop has handed over — drives carelink_data_age_seconds. */
let newestReadingTimestampMs: number | null = null;
let stale = false;

const uploadFailures = new Map<string, number>();

function uploadFailureKey(endpoint: UploadEndpoint, reason: UploadFailureReason): string {
  return `${endpoint}\u0000${reason}`;
}

const fetchDurationsMs: number[] = [];
const MAX_DURATIONS = 100;

export function incFetch(result: FetchResult): void {
  if (result === 'success') fetchesSuccess++;
  else fetchesFailure++;
}

export function incUpload(endpoint: UploadEndpoint, count = 1): void {
  // Explicit per-endpoint counting. The previous shape defaulted anything that
  // was not `entries` into the devicestatus counter, which silently inflated
  // devicestatus once treatments became a third upload target.
  if (endpoint === 'entries') uploadsEntries += count;
  else if (endpoint === 'treatments') uploadsTreatments += count;
  else uploadsDevicestatus += count;
}

export function incTokenRefresh(result: FetchResult): void {
  if (result === 'success') tokenRefreshSuccess++;
  else tokenRefreshFailure++;
}

/**
 * Count a failed Nightscout upload. `endpoint` and `reason` are both closed
 * sets so the series count stays bounded at
 * UPLOAD_ENDPOINTS.length × UPLOAD_FAILURE_REASONS.length.
 */
export function incUploadFailure(endpoint: UploadEndpoint, reason: UploadFailureReason): void {
  const key = uploadFailureKey(endpoint, reason);
  uploadFailures.set(key, (uploadFailures.get(key) ?? 0) + 1);
}

/**
 * Classify a thrown upload error into one of UPLOAD_FAILURE_REASONS.
 *
 * Lives here (not in main.ts) so the mapping is unit-testable and the caller's
 * catch block stays a single line. Recognises both shapes src/nightscout/
 * upload.ts produces: an axios error carrying `response.status`, and its own
 * thrown Errors whose messages embed the status or the silent-discard verdict.
 */
export function classifyUploadFailure(err: unknown): UploadFailureReason {
  const e = err as { response?: { status?: unknown }; code?: unknown; message?: unknown } | null;
  const status = typeof e?.response?.status === 'number' ? e.response.status : undefined;
  if (status !== undefined) {
    if (status >= 500) return 'http_5xx';
    if (status >= 400) return 'http_4xx';
  }
  const message = typeof e?.message === 'string' ? e.message : '';
  const httpMatch = /HTTP (\d{3})/.exec(message);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code >= 500) return 'http_5xx';
    if (code >= 400) return 'http_4xx';
  }
  if (/stored 0 of|silently discarded|non-array body/.test(message)) return 'discarded';
  // Transport failures carry a libuv/axios code (ECONNREFUSED, ETIMEDOUT, …)
  // and have no HTTP response at all.
  if (typeof e?.code === 'string' && /^(E[A-Z]+|ERR_)/.test(e.code)) return 'network';
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|socket hang up|timeout/i.test(message)) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Record the timestamp of the newest reading the bridge has seen. Callers pass
 * the reading's own timestamp (not Date.now()), so the gauge measures how old
 * the *data* is, not how recently we polled.
 */
export function setNewestReading(readingTimestampMs: number): void {
  newestReadingTimestampMs = readingTimestampMs;
}

/** 1 when the bridge considers itself stale, 0 otherwise. */
export function setStale(isStale: boolean): void {
  stale = isStale;
}

export function setLastSuccess(tsMs: number): void {
  lastSuccessTimestampMs = tsMs;
}

/** Updated by main.ts from client.isCircuitOpen() — feeds carelink_circuit_open. */
export function setCircuitOpen(open: boolean): void {
  circuitOpen = open;
}

export function observeFetchDuration(ms: number): void {
  fetchDurationsMs.push(ms);
  if (fetchDurationsMs.length > MAX_DURATIONS) fetchDurationsMs.shift();
}

export function getSnapshot() {
  return {
    fetchesSuccess,
    fetchesFailure,
    uploadsEntries,
    uploadsDevicestatus,
    uploadsTreatments,
    tokenRefreshSuccess,
    tokenRefreshFailure,
    uploadFailures: new Map(uploadFailures),
    lastSuccessTimestampMs,
    newestReadingTimestampMs,
    stale,
    circuitOpen,
    fetchDurationsMs: [...fetchDurationsMs],
  };
}

export function reset(): void {
  fetchesSuccess = 0;
  fetchesFailure = 0;
  uploadsEntries = 0;
  uploadsDevicestatus = 0;
  uploadsTreatments = 0;
  tokenRefreshSuccess = 0;
  tokenRefreshFailure = 0;
  uploadFailures.clear();
  lastSuccessTimestampMs = null;
  newestReadingTimestampMs = null;
  stale = false;
  circuitOpen = false;
  fetchDurationsMs.length = 0;
}

/**
 * Age of the newest reading in seconds, or null when nothing has been seen
 * yet. Null (not 0) because "no data ever" and "data from this instant" are
 * opposite conditions that a numeric gauge cannot distinguish.
 */
export function dataAgeSeconds(nowMs = Date.now()): number | null {
  if (newestReadingTimestampMs === null) return null;
  return Math.max(0, Math.floor((nowMs - newestReadingTimestampMs) / 1000));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  const tsSec = lastSuccessTimestampMs !== null ? Math.floor(lastSuccessTimestampMs / 1000) : 0;

  lines.push('# HELP carelink_fetches_total Total CareLink fetch attempts');
  lines.push('# TYPE carelink_fetches_total counter');
  lines.push(`carelink_fetches_total{result="success"} ${fetchesSuccess}`);
  lines.push(`carelink_fetches_total{result="failure"} ${fetchesFailure}`);
  lines.push('');

  lines.push('# HELP carelink_uploads_total Total Nightscout uploads');
  lines.push('# TYPE carelink_uploads_total counter');
  lines.push(`carelink_uploads_total{endpoint="entries"} ${uploadsEntries}`);
  lines.push(`carelink_uploads_total{endpoint="devicestatus"} ${uploadsDevicestatus}`);
  lines.push(`carelink_uploads_total{endpoint="treatments"} ${uploadsTreatments}`);
  lines.push('');

  lines.push('# HELP carelink_token_refreshes_total Total token refresh attempts');
  lines.push('# TYPE carelink_token_refreshes_total counter');
  lines.push(`carelink_token_refreshes_total{result="success"} ${tokenRefreshSuccess}`);
  lines.push(`carelink_token_refreshes_total{result="failure"} ${tokenRefreshFailure}`);
  lines.push('');

  // Emit every (endpoint, reason) pair the closed sets allow, including zeros.
  // A series that only appears after its first failure cannot be alerted on
  // with `absent()` / rate() — the panel goes quiet exactly when it matters.
  lines.push('# HELP carelink_upload_failures_total Failed Nightscout upload attempts');
  lines.push('# TYPE carelink_upload_failures_total counter');
  for (const endpoint of UPLOAD_ENDPOINTS) {
    for (const reason of UPLOAD_FAILURE_REASONS) {
      const count = uploadFailures.get(uploadFailureKey(endpoint, reason)) ?? 0;
      lines.push(`carelink_upload_failures_total{endpoint="${endpoint}",reason="${reason}"} ${count}`);
    }
  }
  lines.push('');

  lines.push('# HELP carelink_last_success_timestamp_seconds Unix timestamp of last successful fetch');
  lines.push('# TYPE carelink_last_success_timestamp_seconds gauge');
  lines.push(`carelink_last_success_timestamp_seconds ${tsSec}`);
  lines.push('');

  lines.push('# HELP carelink_circuit_open Whether the CareLink circuit breaker is open (1) or closed (0)');
  lines.push('# TYPE carelink_circuit_open gauge');
  lines.push(`carelink_circuit_open ${circuitOpen ? 1 : 0}`);
  lines.push('');

  // -1 means "no reading seen since start", which is a distinct condition from
  // a 0-second-old reading. The series is always present so a panel can alert
  // on `carelink_data_age_seconds < 0` (never received) or `> threshold` (stale).
  const ageSec = dataAgeSeconds();
  lines.push('# HELP carelink_data_age_seconds Age of the newest reading in seconds (-1 = none seen yet)');
  lines.push('# TYPE carelink_data_age_seconds gauge');
  lines.push(`carelink_data_age_seconds ${ageSec === null ? -1 : ageSec}`);
  lines.push('');

  lines.push('# HELP carelink_stale Whether the newest reading is past the stale threshold (1) or not (0)');
  lines.push('# TYPE carelink_stale gauge');
  lines.push(`carelink_stale ${stale ? 1 : 0}`);
  lines.push('');

  if (fetchDurationsMs.length > 0) {
    const sorted = [...fetchDurationsMs].sort((a, b) => a - b);
    lines.push('# HELP carelink_fetch_duration_ms Fetch duration in milliseconds');
    lines.push('# TYPE carelink_fetch_duration_ms summary');
    lines.push(`carelink_fetch_duration_ms{quantile="0.5"} ${quantile(sorted, 0.5)}`);
    lines.push(`carelink_fetch_duration_ms{quantile="0.9"} ${quantile(sorted, 0.9)}`);
    lines.push(`carelink_fetch_duration_ms{quantile="0.99"} ${quantile(sorted, 0.99)}`);
    lines.push(`carelink_fetch_duration_ms_sum ${sorted.reduce((a, b) => a + b, 0)}`);
    lines.push(`carelink_fetch_duration_ms_count ${sorted.length}`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}
