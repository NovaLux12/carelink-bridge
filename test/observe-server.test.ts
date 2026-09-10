import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startObserveServer } from '../src/observe-server.js';
import * as metrics from '../src/metrics.js';

/**
 * Observability server contract (issue #10 item 2).
 *
 * Opt-in loopback server: /healthz returns JSON status, /metrics returns
 * the Prometheus exposition including the circuit_open gauge, unknown
 * paths 404. Port 0 selects an ephemeral port for test isolation.
 */

describe('observe-server', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    metrics.reset();
  });

  async function start(): Promise<string> {
    metrics.incFetch('success');
    metrics.setCircuitOpen(false);
    const server = startObserveServer({
      port: 0,
      getStatus: () => ({
        lastSuccessTimestamp: 1234,
        consecutiveFailures: 0,
        circuitOpen: false,
      }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);
    return `http://127.0.0.1:${port}`;
  }

  it('serves /healthz JSON with circuit state', async () => {
    const base = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['lastSuccessTimestamp']).toBe(1234);
    expect(body['consecutiveFailures']).toBe(0);
    expect(body['circuitOpen']).toBe(false);
  });

  it('serves /metrics exposition with circuit_open gauge', async () => {
    const base = await start();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('carelink_fetches_total{result="success"} 1');
    expect(text).toContain('carelink_circuit_open 0');
  });

  it('reflects an open circuit in both endpoints', async () => {
    metrics.setCircuitOpen(true);
    const server = startObserveServer({
      port: 0,
      getStatus: () => ({
        lastSuccessTimestamp: null,
        consecutiveFailures: 5,
        circuitOpen: true,
      }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const hz = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(hz['circuitOpen']).toBe(true);
    expect(hz['consecutiveFailures']).toBe(5);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('carelink_circuit_open 1');
  });

  it('returns 404 for unknown paths', async () => {
    const base = await start();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
