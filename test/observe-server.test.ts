import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startObserveServer, evaluateHealth, httpStatusForVerdict } from '../src/observe-server.js';
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
  // A recent success timestamp, shared with the assertions below.
  const recent = Date.now() - 30_000;

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    metrics.reset();
  });

  async function start(): Promise<string> {
    metrics.incFetch('success');
    metrics.setCircuitOpen(false);
    // A *recent* success: the fixture used to be `1234` (epoch 1970), which only
    // ever read "ok" because /healthz could not fail. Under the issue #134
    // verdict that timestamp is genuinely 56 years stale, so a healthy fixture
    // has to be a healthy timestamp.
    const server = startObserveServer({
      port: 0,
      getStatus: () => ({
        lastSuccessTimestamp: recent,
        consecutiveFailures: 0,
        circuitOpen: false,
        staleThresholdMs: 15 * 60 * 1000,
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
    expect(body['lastSuccessTimestamp']).toBe(recent);
    expect(body['consecutiveFailures']).toBe(0);
    expect(body['circuitOpen']).toBe(false);
    expect(body['liveness']).toBe('up');
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

/**
 * Issue #134: /healthz must be able to fail.
 *
 * Before this, the handler returned 200 {"status":"ok"} unconditionally, so a
 * bridge that had stopped receiving data still reported healthy and the
 * Docker HEALTHCHECK — which only looks at `res.ok` — could never go red.
 * Every case below asserts the HTTP status as well as the body, because the
 * status is what monitors actually key on.
 */
describe('observe-server health verdicts', () => {
  const servers: Server[] = [];
  // Fixed clock so ages are exact and the tests cannot straddle a second
  // boundary and flake.
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const THRESHOLD_MS = 15 * 60 * 1000;

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    metrics.reset();
  });

  async function startWith(
    status: () => Parameters<typeof evaluateHealth>[0],
  ): Promise<{ base: string; get: (path: string) => Promise<Response> }> {
    const server = startObserveServer({ port: 0, getStatus: status, now: () => NOW });
    servers.push(server);
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;
    return { base, get: (p: string) => fetch(`${base}${p}`) };
  }

  it('reports ok / 200 when a recent fetch succeeded and the circuit is closed', async () => {
    const { get } = await startWith(() => ({
      lastSuccessTimestamp: NOW - 60_000,
      consecutiveFailures: 0,
      circuitOpen: false,
      staleThresholdMs: THRESHOLD_MS,
    }));
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['liveness']).toBe('up');
    expect(body['lastSuccessAgeSeconds']).toBe(60);
    expect(body['staleForSeconds']).toBeNull();
    expect(body['staleThresholdSeconds']).toBe(900);
  });

  it('reports stale / 503 with staleForSeconds when the last success is past the threshold', async () => {
    // Twelve hours since the last good fetch: exactly the case the issue calls out.
    const { get } = await startWith(() => ({
      lastSuccessTimestamp: NOW - 12 * 60 * 60 * 1000,
      consecutiveFailures: 0,
      circuitOpen: false,
      staleThresholdMs: THRESHOLD_MS,
    }));
    const res = await get('/healthz');
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('stale');
    // Process is up; the data is not. The two must be separable.
    expect(body['liveness']).toBe('up');
    expect(body['staleForSeconds']).toBe(12 * 60 * 60);
    expect(body['lastSuccessAgeSeconds']).toBe(12 * 60 * 60);
    expect(body['lastSuccessTimestamp']).toBe(NOW - 12 * 60 * 60 * 1000);
  });

  it('reports degraded / 503 when the circuit is open', async () => {
    const { get } = await startWith(() => ({
      lastSuccessTimestamp: NOW - 30_000,
      consecutiveFailures: 5,
      circuitOpen: true,
      staleThresholdMs: THRESHOLD_MS,
    }));
    const res = await get('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('degraded');
    expect(body['circuitOpen']).toBe(true);
    expect(body['consecutiveFailures']).toBe(5);
    expect(body['liveness']).toBe('up');
    // Not stale — the data is 30s old. "Can't fetch" is its own verdict.
    expect(body['staleForSeconds']).toBeNull();
  });

  it('reports degraded / 503 when no fetch has ever succeeded', async () => {
    const { get } = await startWith(() => ({
      lastSuccessTimestamp: null,
      consecutiveFailures: 0,
      circuitOpen: false,
      staleThresholdMs: THRESHOLD_MS,
    }));
    const res = await get('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('degraded');
    // null, not 0 — "never succeeded" must not look like "succeeded just now".
    expect(body['lastSuccessAgeSeconds']).toBeNull();
    expect(body['lastSuccessTimestamp']).toBeNull();
    expect(body['staleForSeconds']).toBeNull();
  });

  it('applies the 15-minute default threshold when the caller supplies none', async () => {
    // Omitting staleThresholdMs must NOT restore the pre-#134 behaviour where
    // 12-hour-old data read healthy. main.ts still omits it until the handoff
    // lands, so this is the path that actually runs in production today.
    const { get } = await startWith(() => ({
      lastSuccessTimestamp: NOW - 12 * 60 * 60 * 1000,
      consecutiveFailures: 0,
      circuitOpen: false,
    }));
    const res = await get('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('stale');
    expect(body['staleThresholdSeconds']).toBe(900);
    expect(body['staleForSeconds']).toBe(12 * 60 * 60);
  });

  it('keeps the existing caller shape working (three fields, no threshold)', async () => {
    const { get } = await startWith(() => ({
      lastSuccessTimestamp: NOW - 60_000,
      consecutiveFailures: 0,
      circuitOpen: false,
    }));
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['lastSuccessTimestamp']).toBe(NOW - 60_000);
    expect(body['consecutiveFailures']).toBe(0);
    expect(body['circuitOpen']).toBe(false);
  });

  it('tidies the verdict into a 503 rather than a hung or 500 response when the probe throws', async () => {
    const { get } = await startWith(() => {
      throw new Error('probe exploded');
    });
    const res = await get('/healthz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('degraded');
    expect(body['liveness']).toBe('up');
  });
});

describe('evaluateHealth (pure verdict logic)', () => {
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const THRESHOLD_MS = 15 * 60 * 1000;

  it('maps only ok to 200', () => {
    expect(httpStatusForVerdict('ok')).toBe(200);
    expect(httpStatusForVerdict('stale')).toBe(503);
    expect(httpStatusForVerdict('degraded')).toBe(503);
  });

  it('ranks circuit-open above stale', () => {
    const report = evaluateHealth(
      {
        lastSuccessTimestamp: NOW - 24 * 60 * 60 * 1000,
        consecutiveFailures: 9,
        circuitOpen: true,
        staleThresholdMs: THRESHOLD_MS,
      },
      NOW,
    );
    expect(report.status).toBe('degraded');
  });

  it('treats the threshold as a strict boundary', () => {
    const atThreshold = evaluateHealth(
      {
        lastSuccessTimestamp: NOW - THRESHOLD_MS,
        consecutiveFailures: 0,
        circuitOpen: false,
        staleThresholdMs: THRESHOLD_MS,
      },
      NOW,
    );
    expect(atThreshold.status).toBe('ok');

    const justPast = evaluateHealth(
      {
        lastSuccessTimestamp: NOW - THRESHOLD_MS - 1,
        consecutiveFailures: 0,
        circuitOpen: false,
        staleThresholdMs: THRESHOLD_MS,
      },
      NOW,
    );
    expect(justPast.status).toBe('stale');
  });

  it('does not report a negative age for a clock-skewed future timestamp', () => {
    const report = evaluateHealth(
      {
        lastSuccessTimestamp: NOW + 60_000,
        consecutiveFailures: 0,
        circuitOpen: false,
        staleThresholdMs: THRESHOLD_MS,
      },
      NOW,
    );
    expect(report.status).toBe('ok');
    expect(report.lastSuccessAgeSeconds).toBe(0);
  });
});
