/**
 * Opt-in loopback observability server — /healthz + /metrics.
 *
 * v0.4.0 observability slice (issue #10, item 2 remainder). Zero
 * dependencies (node:http stdlib only). Binds 127.0.0.1 by default so
 * enabling it does not widen the bridge's network posture: no inbound
 * Internet surface, and the systemd unit's RestrictAddressFamilies
 * (AF_INET/AF_INET6) already permits loopback.
 *
 * Disabled unless CARELINK_METRICS_PORT is set (> 0). A listen failure
 * (e.g. port taken) is logged, never fatal — the fetch loop continues
 * headless.
 *
 * /healthz  → 200 when healthy, 503 otherwise. JSON body:
 *             { status: 'ok'|'stale'|'degraded', liveness: 'up',
 *               lastSuccessTimestamp, consecutiveFailures, circuitOpen,
 *               lastSuccessAgeSeconds, staleForSeconds, staleThresholdSeconds }
 * /metrics  → 200 text/plain Prometheus exposition via metrics.renderPrometheus()
 * anything else → 404
 *
 * The verdict has to be able to go red. Before issue #134 this handler
 * returned 200 {"status":"ok"} unconditionally, so the Docker HEALTHCHECK and
 * any uptime monitor could only ever detect a dead *process*, never a bridge
 * that had silently stopped receiving data. Health is now computed from the
 * injected `getStatus()`: this module keeps no state and does not import
 * main.ts, so bridge state stays owned by the caller.
 *
 * All labels are low-cardinality; nothing user-identifying is served.
 */

import http from 'node:http';
import * as logger from './logger.js';
import { renderPrometheus } from './metrics.js';

/** Caller-supplied view of bridge state. Owned by main.ts, not by this module. */
export interface HealthStatus {
  lastSuccessTimestamp: number | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  /**
   * Age past which the data counts as stale. Optional so existing callers keep
   * compiling; when omitted, DEFAULT_STALE_THRESHOLD_MS applies. Callers should
   * pass their real configured threshold (config.staleThresholdMs) so a
   * CARELINK_STALE_THRESHOLD_MINUTES override is respected here too.
   */
  staleThresholdMs?: number;
}

/**
 * Fallback threshold when the caller supplies none — matches the
 * CARELINK_STALE_THRESHOLD_MINUTES default in src/config.ts (15 min) and sits
 * well above the 300s default fetch interval. The default exists so omitting
 * the field cannot silently restore the pre-#134 "stale data reads healthy"
 * behaviour.
 */
export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Verdict vocabulary:
 *  - `ok`       data is flowing, circuit closed
 *  - `stale`    a fetch succeeded once, but not within staleThresholdMs
 *  - `degraded` the bridge is not delivering data at all: circuit open, or no
 *               successful fetch since the process started
 */
export type HealthVerdict = 'ok' | 'stale' | 'degraded';

/**
 * `liveness` is deliberately separate from `status`: it only says the HTTP
 * process answered, so a supervisor can tell "container up, data dead"
 * (liveness up, status stale) from "container down" (no answer at all).
 */
export type Liveness = 'up';

export interface HealthReport {
  status: HealthVerdict;
  liveness: Liveness;
  lastSuccessTimestamp: number | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  /** Seconds since the last successful fetch, or null if none ever succeeded. */
  lastSuccessAgeSeconds: number | null;
  /** Age in seconds when the verdict is `stale`; null otherwise. */
  staleForSeconds: number | null;
  /** Threshold actually applied, in seconds (the caller's value or the default). */
  staleThresholdSeconds: number;
}

export interface ObserveServerOptions {
  /** TCP port to bind. Use 0 in tests for an ephemeral port. */
  port: number;
  /** Bind host. Defaults to loopback — never expose to LAN/Internet. */
  host?: string;
  getStatus: () => HealthStatus;
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export const LOOPBACK_HOST = '127.0.0.1';

/** HTTP status for a verdict. Only `ok` is 200 — a monitor keyed on `res.ok` must go red. */
export function httpStatusForVerdict(verdict: HealthVerdict): number {
  return verdict === 'ok' ? 200 : 503;
}

/**
 * Pure verdict computation, exported so it is testable without a socket.
 * Precedence: degraded > stale > ok — "not delivering at all" outranks
 * "delivering old data".
 */
export function evaluateHealth(status: HealthStatus, nowMs: number): HealthReport {
  const thresholdMs = status.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const ageMs =
    status.lastSuccessTimestamp === null ? null : Math.max(0, nowMs - status.lastSuccessTimestamp);

  let verdict: HealthVerdict;
  if (status.circuitOpen || ageMs === null) verdict = 'degraded';
  else if (ageMs > thresholdMs) verdict = 'stale';
  else verdict = 'ok';

  const ageSec = ageMs === null ? null : Math.floor(ageMs / 1000);

  return {
    status: verdict,
    liveness: 'up',
    lastSuccessTimestamp: status.lastSuccessTimestamp,
    consecutiveFailures: status.consecutiveFailures,
    circuitOpen: status.circuitOpen,
    lastSuccessAgeSeconds: ageSec,
    staleForSeconds: verdict === 'stale' ? ageSec : null,
    staleThresholdSeconds: Math.floor(thresholdMs / 1000),
  };
}

export function startObserveServer(opts: ObserveServerOptions): http.Server {
  const host = opts.host ?? LOOPBACK_HOST;
  const now = opts.now ?? (() => Date.now());
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request\n');
      return;
    }
    if (req.method === 'GET' && pathname === '/healthz') {
      let report: HealthReport;
      try {
        report = evaluateHealth(opts.getStatus(), now());
      } catch (err) {
        // A throwing probe is itself a fault. Report a verdict rather than a
        // bare 500 so a monitor still gets a body it can log.
        logger.error('healthz status probe failed', { error: (err as Error).message });
        report = {
          status: 'degraded',
          liveness: 'up',
          lastSuccessTimestamp: null,
          consecutiveFailures: 0,
          circuitOpen: false,
          lastSuccessAgeSeconds: null,
          staleForSeconds: null,
          staleThresholdSeconds: DEFAULT_STALE_THRESHOLD_MS / 1000,
        };
      }
      res.writeHead(httpStatusForVerdict(report.status), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(report));
      return;
    }
    if (req.method === 'GET' && pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(renderPrometheus());
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });
  server.on('error', (err) => {
    logger.error('Observability server error', { error: (err as Error).message, port: opts.port });
  });
  server.listen(opts.port, host, () => {
    logger.info('Observability server listening', { component: 'bridge', host, port: opts.port });
  });
  return server;
}
