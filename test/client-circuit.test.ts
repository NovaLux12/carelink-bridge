import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Client circuit-breaker integration (issue #9 item 3).
 *
 * Uses permanent-404 failures (fail-fast, no sleeps) so the test runs
 * without fake timers. Verifies: consecutive fetch() failures trip the
 * breaker, the next fetch() short-circuits without touching the network,
 * and a success resets the counter.
 */

const axiosInstance = {
  defaults: { headers: { common: {} as Record<string, string> } },
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
  get: vi.fn(),
  post: vi.fn(),
};

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => axiosInstance),
    post: vi.fn(),
  },
}));

vi.mock('../src/carelink/token.js', () => ({
  loadLoginData: vi.fn(() => ({
    access_token: 'token',
    refresh_token: 'refresh',
    client_id: 'client',
    token_url: 'https://example.invalid/oauth/token',
  })),
  writeLoginDataAtomic: vi.fn(),
  isTokenExpired: vi.fn(() => false),
  refreshToken: vi.fn(async (loginData: unknown) => loginData),
  decodeTokenPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
}));

import { CareLinkClient } from '../src/carelink/client.js';

function http404(): unknown {
  return {
    code: 'ERR_BAD_REQUEST',
    message: 'Request failed with status code 404',
    response: { status: 404, headers: {} },
  };
}

const monitorData = {
  deviceFamily: 'PARADIGM',
  lastMedicalDeviceDataUpdateServerTime: 1,
  sgs: [],
};

describe('CareLinkClient circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens after 5 consecutive failures and short-circuits the 6th', async () => {
    let meCalls = 0;
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        meCalls++;
        throw http404();
      }
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({
      username: 'u',
      password: 'p',
      circuitThreshold: 5,
      circuitCooldownMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(client.fetch()).rejects.toMatchObject({ response: { status: 404 } });
      expect(client.getConsecutiveFailures()).toBe(i + 1);
    }

    expect(client.isCircuitOpen()).toBe(true);

    // 6th fetch short-circuits: no new network call, circuit-open error.
    const callsBefore = meCalls;
    await expect(client.fetch()).rejects.toThrow(/Circuit breaker open/);
    expect(meCalls).toBe(callsBefore);
  });

  it('success resets the consecutive-failure counter', async () => {
    let shouldFail = true;
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        if (shouldFail) throw http404();
        return { status: 200, data: { role: 'PATIENT' } };
      }
      if (url.includes('/monitor/data')) {
        return { status: 200, data: monitorData };
      }
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({ username: 'u', password: 'p' });

    await expect(client.fetch()).rejects.toMatchObject({ response: { status: 404 } });
    await expect(client.fetch()).rejects.toMatchObject({ response: { status: 404 } });
    expect(client.getConsecutiveFailures()).toBe(2);

    shouldFail = false;
    await expect(client.fetch()).resolves.toEqual(monitorData);
    expect(client.getConsecutiveFailures()).toBe(0);
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('restores circuit state from persistent storage', async () => {
    axiosInstance.get.mockRejectedValue(http404());
    const client = new CareLinkClient({ username: 'u', password: 'p' });
    client.restoreCircuitState({ consecutiveFailures: 4, circuitOpenUntil: 0 });
    expect(client.getConsecutiveFailures()).toBe(4);
    await expect(client.fetch()).rejects.toMatchObject({ response: { status: 404 } });
    // 4 restored + 1 fresh failure = 5 → open.
    expect(client.isCircuitOpen()).toBe(true);
  });
});
