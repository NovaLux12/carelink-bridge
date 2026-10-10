import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Behavioural regression tests for the issue #3 failure mode: a legacy
 * carepartner endpoint answers HTTP 200 with data frozen at the day the pump
 * was paired, so accepting the first 200 ends the search before the newer
 * endpoints the app itself uses are ever tried.
 *
 * The reported symptom was "[Fetch] Success!" every interval with nothing
 * reaching Nightscout, and a payload ~33 days old.
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
  loadLoginData: vi.fn(() => null),
  writeLoginDataAtomic: vi.fn(),
  isTokenExpired: vi.fn(() => false),
  refreshToken: vi.fn(),
}));

import { CareLinkClient } from '../src/carelink/client.js';

const NOW = 1_760_000_000_000;
const minutesAgo = (m: number) => NOW - m * 60 * 1000;

const CONFIG_URL = 'https://clcloud.minimed.eu/connect/carepartner/v6/display/message';

/** A payload frozen 33 days back — the shape issue #3 actually returned. */
const stalePayload = () => ({
  currentServerTime: NOW,
  lastMedicalDeviceDataUpdateServerTime: minutesAgo(47510.42),
  sgs: [{ sg: 100, dateTime: minutesAgo(47510) }],
});

const freshPayload = () => ({
  currentServerTime: NOW,
  lastMedicalDeviceDataUpdateServerTime: minutesAgo(2),
  sgs: [{ sg: 123, dateTime: minutesAgo(2) }],
});

function makeClient(): CareLinkClient {
  return new CareLinkClient({ username: 'someone@example.invalid', password: 'x' });
}

/** Reach the private care-partner path the way getConnectData() does. */
function fetchAsCarepartner(client: CareLinkClient) {
  return (client as unknown as { fetchAsCarepartner(role: string): Promise<unknown> })
    .fetchAsCarepartner('CARE_PARTNER');
}

function wireMetadata() {
  axiosInstance.get.mockImplementation(async (url: string) => {
    if (url.includes('links/patients')) {
      return { status: 200, data: [{ username: 'patient-1' }] };
    }
    if (url.includes('monitor/data')) {
      // Non-BLE family so the probe falls through to the fallback list.
      return { status: 200, data: { deviceFamily: 'GUARDIAN' } };
    }
    if (url.includes('countries/settings')) {
      return { status: 200, data: { blePereodicDataEndpoint: CONFIG_URL } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function versionsTried(): string[] {
  return axiosInstance.post.mock.calls.map((c: unknown[]) => {
    const url = String(c[0]);
    return url.match(/\/v(\d+)\//)?.[1] ?? url;
  });
}

describe('carepartner endpoint fallback with a stale 200', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['USE_PROXY'] = 'false';
    wireMetadata();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not stop at a stale 200 — keeps looking and returns the current payload', async () => {
    axiosInstance.post.mockImplementation(async (url: string) => {
      if (url.includes('/v13/')) return { status: 200, data: freshPayload() };
      return { status: 200, data: stalePayload() };
    });

    const result = (await fetchAsCarepartner(makeClient())) as ReturnType<typeof freshPayload>;

    expect(result).toEqual(freshPayload());
    // v6 answered 200 first but was rejected on freshness, so the newer
    // endpoint the app uses was actually reached.
    expect(versionsTried()).toContain('13');
  });

  it('still short-circuits on the first 200 when the data is current', async () => {
    axiosInstance.post.mockResolvedValue({ status: 200, data: freshPayload() });

    const result = await fetchAsCarepartner(makeClient());

    expect(result).toEqual(freshPayload());
    // No needless extra traffic for a working setup.
    expect(versionsTried()).toEqual(['6']);
  });

  it('returns the newest stale payload rather than throwing when nothing is current', async () => {
    axiosInstance.post.mockImplementation(async (url: string) => {
      if (url.includes('/v11/')) {
        return {
          status: 200,
          data: {
            currentServerTime: NOW,
            lastMedicalDeviceDataUpdateServerTime: minutesAgo(120),
            sgs: [],
          },
        };
      }
      return { status: 200, data: stalePayload() };
    });

    const result = (await fetchAsCarepartner(makeClient())) as {
      lastMedicalDeviceDataUpdateServerTime: number;
    };

    // 120 min old beats the 47510 min old one — this is the floor that makes
    // the change strictly non-regressing against the old first-200-wins code.
    expect(result.lastMedicalDeviceDataUpdateServerTime).toBe(minutesAgo(120));
  });

  it('still throws when no endpoint answers 200', async () => {
    axiosInstance.post.mockRejectedValue(Object.assign(new Error('boom'), {
      response: { status: 500 },
    }));

    await expect(fetchAsCarepartner(makeClient())).rejects.toThrow(
      'All carepartner data endpoints failed',
    );
  });

  it('treats a 200 with an undatable body as usable, not stale', async () => {
    axiosInstance.post.mockResolvedValue({ status: 200, data: { sgs: [], lastSG: null } });

    const result = await fetchAsCarepartner(makeClient());

    expect(result).toEqual({ sgs: [], lastSG: null });
    expect(versionsTried()).toEqual(['6']);
  });
});