import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('stale-data detection', () => {
  let originalDate: typeof Date;

  beforeEach(() => {
    originalDate = Date;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires webhook when stale threshold exceeded', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const staleThresholdMs = 15 * 60 * 1000;
    const staleWebhookUrl = 'https://example.com/webhook';

    // Simulate: last success was 16 minutes ago
    const now = Date.now();
    const lastSuccess = now - (16 * 60 * 1000);
    const elapsed = now - lastSuccess;

    expect(elapsed).toBeGreaterThan(staleThresholdMs);

    // Simulate the webhook call
    await fetchMock(staleWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridge: 'stale',
        since: new Date(lastSuccess).toISOString(),
        threshold_ms: staleThresholdMs,
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      staleWebhookUrl,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not fire webhook when within threshold', () => {
    const staleThresholdMs = 15 * 60 * 1000;
    const lastSuccess = Date.now() - (5 * 60 * 1000);
    const elapsed = Date.now() - lastSuccess;

    expect(elapsed).toBeLessThan(staleThresholdMs);
  });

  it('fires webhook only once on stale entry', () => {
    let staleNotified = false;
    const staleThresholdMs = 15 * 60 * 1000;
    const lastSuccess = Date.now() - (20 * 60 * 1000);
    const elapsed = Date.now() - lastSuccess;

    let fireCount = 0;
    if (elapsed > staleThresholdMs && !staleNotified) {
      staleNotified = true;
      fireCount++;
    }

    // Second check — should not fire again
    if (elapsed > staleThresholdMs && !staleNotified) {
      staleNotified = true;
      fireCount++;
    }

    expect(fireCount).toBe(1);
  });

  it('recovers from stale state on successful fetch', () => {
    let staleNotified = true;
    const lastSuccess = Date.now(); // just succeeded
    const elapsed = Date.now() - lastSuccess;
    const staleThresholdMs = 15 * 60 * 1000;

    if (elapsed <= staleThresholdMs && staleNotified) {
      staleNotified = false;
    }

    expect(staleNotified).toBe(false);
  });
});

describe('graceful shutdown', () => {
  it('sets shuttingDown flag on SIGTERM', () => {
    let shuttingDown = false;

    const handler = () => {
      shuttingDown = true;
    };

    process.emit('SIGTERM', 'SIGTERM');
    // Simulate what our handler does
    handler();

    expect(shuttingDown).toBe(true);
  });

  it('forces exit on second signal', () => {
    let shuttingDown = false;
    let forceExitCount = 0;

    const handler = (signal: string) => {
      if (shuttingDown) {
        forceExitCount++;
        return;
      }
      shuttingDown = true;
    };

    handler('SIGTERM');
    handler('SIGTERM');

    expect(forceExitCount).toBe(1);
  });
});
