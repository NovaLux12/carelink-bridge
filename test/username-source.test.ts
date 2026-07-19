import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The BLE data POST must carry the username CareLink reports from /users/me,
 * not the raw CARELINK_USERNAME env value — operators commonly enter their
 * email there while their CareLink username differs. Both reference
 * implementations (nightscout-connect, carelink-python-client) source the
 * username from the server/token, never from user config.
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
  saveLoginData: vi.fn(),
  isTokenExpired: vi.fn(() => false),
  refreshToken: vi.fn(),
}));

import { CareLinkClient } from '../src/carelink/client.js';

const bleData = {
  deviceFamily: 'BLE_MINIMED',
  lastMedicalDeviceDataUpdateServerTime: 1,
  sgs: [],
};

describe('BLE body username source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'real-username', id: 'patient-id' } };
      }
      if (url.includes('/monitor/data')) {
        return { status: 200, data: bleData };
      }
      if (url.includes('/countries/settings')) {
        return { status: 200, data: { blePereodicDataEndpoint: 'https://clcloud.example/connect/carepartner/v6/display/message' } };
      }
      throw new Error('unexpected url: ' + url);
    });
    axiosInstance.post.mockResolvedValue({ status: 200, data: bleData });
  });

  it('should use the /users/me username in the BLE POST, not the env value', async () => {
    const client = new CareLinkClient({ username: 'you@example.com', password: 'p' });
    const data = await client.fetch();

    expect(data).toEqual(bleData);
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
    const [, body] = axiosInstance.post.mock.calls[0];
    expect(body.username).toBe('real-username');
    expect(body.username).not.toBe('you@example.com');
  });

  it('should fall back to the configured username if /users/me omits one', async () => {
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT' } };
      }
      if (url.includes('/monitor/data')) {
        return { status: 200, data: bleData };
      }
      if (url.includes('/countries/settings')) {
        return { status: 200, data: { blePereodicDataEndpoint: 'https://clcloud.example/connect/carepartner/v6/display/message' } };
      }
      throw new Error('unexpected url: ' + url);
    });

    const client = new CareLinkClient({ username: 'configured-user', password: 'p' });
    await client.fetch();

    const [, body] = axiosInstance.post.mock.calls[0];
    expect(body.username).toBe('configured-user');
  });
});
