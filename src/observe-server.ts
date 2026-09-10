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
 * /healthz  → 200 JSON { status, lastSuccessTimestamp, consecutiveFailures, circuitOpen }
 * /metrics  → 200 text/plain Prometheus exposition via metrics.renderPrometheus()
 * anything else → 404
 *
 * All labels are low-cardinality; nothing user-identifying is served.
 */

import http from 'node:http';
import * as logger from './logger.js';
import { renderPrometheus } from './metrics.js';

export interface HealthStatus {
  lastSuccessTimestamp: number | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
}

export interface ObserveServerOptions {
  /** TCP port to bind. Use 0 in tests for an ephemeral port. */
  port: number;
  /** Bind host. Defaults to loopback — never expose to LAN/Internet. */
  host?: string;
  getStatus: () => HealthStatus;
}

export const LOOPBACK_HOST = '127.0.0.1';

export function startObserveServer(opts: ObserveServerOptions): http.Server {
  const host = opts.host ?? LOOPBACK_HOST;
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...opts.getStatus() }));
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
    logger.info('Observability server listening', { host, port: opts.port });
    console.log(`[Bridge] Observability: http://${host}:${opts.port}/healthz + /metrics`);
  });
  return server;
}
