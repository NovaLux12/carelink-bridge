import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression tests for #21: a 401/403 mid-token-lifetime must force a token
 * refresh on the next retry instead of re-sending the same dead token until
 * its exp claim passes. The realistic trigger is the CareLink phone app
 * logging into the same account and invalidating the bridge's session.
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
    access_token: 'stale-token',
    refresh_token: 'refresh',
    client_id: 'client',
    token_url: 'https://example.invalid/oauth/token',
  })),
  writeLoginDataAtomic: vi.fn(),
  isTokenExpired: vi.fn(() => false),
  refreshToken: vi.fn(async (loginData: { access_token: string }) => ({
    ...loginData,
    access_token: 'fresh-token',
  })),
}));

import { CareLinkClient } from '../src/carelink/client.js';
import { refreshToken, writeLoginDataAtomic } from '../src/carelink/token.js';

function http401(): Error {
  const err = new Error('Request failed with status code 401') as Error & {
    response: { status: number };
  };
  err.response = { status: 401 };
  return err;
}

const monitorData = {
  deviceFamily: 'PARADIGM',
  lastMedicalDeviceDataUpdateServerTime: 1,
  sgs: [],
};

describe('CareLinkClient.fetch() on 401 (#21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should force a token refresh after a 401 and succeed on retry', async () => {
    let meCalls = 0;
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        meCalls++;
        if (meCalls === 1) throw http401();
        return { status: 200, data: { role: 'PATIENT' } };
      }
      if (url.includes('/monitor/data')) {
        return { status: 200, data: monitorData };
      }
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({ username: 'u', password: 'p' });
    const fetchPromise = client.fetch();
    await vi.runAllTimersAsync();
    const data = await fetchPromise;

    expect(data).toEqual(monitorData);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(writeLoginDataAtomic).toHaveBeenCalledTimes(1);
    expect(axiosInstance.defaults.headers.common['Authorization']).toBe('Bearer fresh-token');
  });

  it('should not refresh on non-auth errors (e.g. network failures)', async () => {
    let meCalls = 0;
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        meCalls++;
        if (meCalls === 1) {
          const err = new Error('socket hang up') as Error & { code: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return { status: 200, data: { role: 'PATIENT' } };
      }
      if (url.includes('/monitor/data')) {
        return { status: 200, data: monitorData };
      }
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({ username: 'u', password: 'p' });
    const fetchPromise = client.fetch();
    await vi.runAllTimersAsync();
    const data = await fetchPromise;

    expect(data).toEqual(monitorData);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('should give up after exhausting retries on persistent 401', async () => {
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) throw http401();
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({ username: 'u', password: 'p' });
    const fetchPromise = client.fetch();
    fetchPromise.catch(() => {}); // avoid unhandled rejection while timers advance
    await vi.runAllTimersAsync();

    await expect(fetchPromise).rejects.toThrow('401');
    // Refresh was attempted for retries 2 and 3, but the API kept rejecting.
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it('should refresh again on a 401 immediately after a successful refresh+401', async () => {
    // Regression test for the forceRefresh-reset-on-successive-401 polish.
    //
    // Pre-fix bug: the loop unconditionally set `forceRefresh = false` at
    // the end of every iteration, even when authenticate had just
    // refreshed and the data call 401'd anyway. Sequence: iter 1 ->
    // /users/me 401 -> flag set. Iter 2 -> authenticate() refreshes
    // (returns true) -> getConnectData() 401 -> loop sets flag=true
    // already. So far so good. Iter 3: WITHOUT the fix, the unconditional
    // reset at end of iter 2 (after authenticate returned true) would
    // re-clear the flag, leading the next data-call 401 to retry a dead
    // token. With the fix, refreshToken is invoked again.
    //
    // Mock: every /users/me attempt returns 401. With maxRetry=3 the loop
    // runs three iterations; the fix must produce two refreshToken calls
    // (iter 2 + iter 3), not one.
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) throw http401();
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({ username: 'u', password: 'p' });
    const fetchPromise = client.fetch();
    fetchPromise.catch(() => {}); // avoid unhandled rejection while timers advance
    await vi.runAllTimersAsync();

    await expect(fetchPromise).rejects.toThrow('401');

    // Pre-fix: would be 1 (refresh on iter 2, flag cleared by unconditional
    // reset, iter 3 re-sent dead token).
    // Post-fix: refresh on iter 2 (returns true), refresh on iter 3 (flag
    // stayed set because authenticate returned true).
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });
});
