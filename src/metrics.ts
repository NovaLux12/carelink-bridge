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
 *   console.log(metrics.renderPrometheus());
 */

export type FetchResult = 'success' | 'failure';
export type UploadEndpoint = 'entries' | 'devicestatus';

let fetchesSuccess = 0;
let fetchesFailure = 0;
let uploadsEntries = 0;
let uploadsDevicestatus = 0;
let tokenRefreshSuccess = 0;
let tokenRefreshFailure = 0;
let lastSuccessTimestampMs: number | null = null;
let circuitOpen = false;

const fetchDurationsMs: number[] = [];
const MAX_DURATIONS = 100;

export function incFetch(result: FetchResult): void {
  if (result === 'success') fetchesSuccess++;
  else fetchesFailure++;
}

export function incUpload(endpoint: UploadEndpoint, count = 1): void {
  if (endpoint === 'entries') uploadsEntries += count;
  else uploadsDevicestatus += count;
}

export function incTokenRefresh(result: FetchResult): void {
  if (result === 'success') tokenRefreshSuccess++;
  else tokenRefreshFailure++;
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
    tokenRefreshSuccess,
    tokenRefreshFailure,
    lastSuccessTimestampMs,
    circuitOpen,
    fetchDurationsMs: [...fetchDurationsMs],
  };
}

export function reset(): void {
  fetchesSuccess = 0;
  fetchesFailure = 0;
  uploadsEntries = 0;
  uploadsDevicestatus = 0;
  tokenRefreshSuccess = 0;
  tokenRefreshFailure = 0;
  lastSuccessTimestampMs = null;
  circuitOpen = false;
  fetchDurationsMs.length = 0;
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
  lines.push('');

  lines.push('# HELP carelink_token_refreshes_total Total token refresh attempts');
  lines.push('# TYPE carelink_token_refreshes_total counter');
  lines.push(`carelink_token_refreshes_total{result="success"} ${tokenRefreshSuccess}`);
  lines.push(`carelink_token_refreshes_total{result="failure"} ${tokenRefreshFailure}`);
  lines.push('');

  lines.push('# HELP carelink_last_success_timestamp_seconds Unix timestamp of last successful fetch');
  lines.push('# TYPE carelink_last_success_timestamp_seconds gauge');
  lines.push(`carelink_last_success_timestamp_seconds ${tsSec}`);
  lines.push('');

  lines.push('# HELP carelink_circuit_open Whether the CareLink circuit breaker is open (1) or closed (0)');
  lines.push('# TYPE carelink_circuit_open gauge');
  lines.push(`carelink_circuit_open ${circuitOpen ? 1 : 0}`);
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
