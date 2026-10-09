import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Legacy `patient/connect/data` host fallback (issue #74).
 *
 * Both CareLink frontends serve that path; the bridge only ever tried the
 * carelink host. These tests pin the three properties of the fallback:
 *
 *   1. the configured host is still tried FIRST, and a success there costs
 *      exactly one request (no behaviour change for accounts that work),
 *   2. both hosts are attempted when the configured host yields nothing,
 *   3. an empty body is not success — a 200 with `{}` in it must not end
 *      the loop, because that is what a host which no longer serves the
 *      endpoint answers with.
 *
 * Host selection itself (which hosts, in which order, and the metadata /
 * data split) is covered in test/urls.test.ts.
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
import type { CareLinkData } from '../src/types/carelink.js';

/** A monitor payload with no BLE family and too few keys to be data. */
const nonBleMonitor = { deviceFamily: 'PARADIGM' };

/** Connect payload with real data in it. */
const blePayload = { sgs: [], lastSG: { sg: 120, kind: 'SG' } };

const connectPayload = {
  lastSG: { sg: 120, datetime: 'Oct 20, 2015 11:09:00', version: 1, timeChange: false, kind: 'SG' },
  sgs: [],
  medicalDeviceFamily: 'PARADIGM',
};

/** A host which no longer serves the endpoint answers 200 with nothing. */
const emptyOk = () => ({ status: 200, data: {} });

/** A host that serves the path but rejects the call: axios error shape. */
const http500 = () =>
  Object.assign(new Error('Request failed with status code 500'), {
    code: 'ERR_BAD_RESPONSE',
    response: { status: 500, headers: {} },
  });

const http502 = () =>
  Object.assign(new Error('Request failed with status code 502'), {
    code: 'ERR_BAD_RESPONSE',
    response: { status: 502, headers: {} },
  });

/**
 * A permanent 4xx. Used where the test asserts the error surfaced to the
 * caller rather than stepped over: decideRetry() fails fast on 404, so the
 * retry loop does not sleep between attempts (same trick as
 * test/client-circuit.test.ts) and the test stays fast without timers.
 */
const http404 = () =>
  Object.assign(new Error('Request failed with status code 404'), {
    code: 'ERR_BAD_REQUEST',
    response: { status: 404, headers: {} },
  });


function euClient(): CareLinkClient {
  return new CareLinkClient({ username: 'u', password: 'p', server: 'EU' });
}

/** Every connect/data URL requested so far, in order. */
function connectCalls(): string[] {
  return axiosInstance.get.mock.calls
    .map(([url]) => url as string)
    .filter((url) => url.includes('/patient/connect/data'));
}

/**
 * Routes /users/me, /monitor/data and connect/data per `connect` — a map of
 * hostname → response factory. A factory that throws fails just like a
 * real transport/HTTP error; an unmapped host fails the test instead of
 * silently passing.
 */
function stubConnect(
  connect: Record<string, () => unknown>,
  monitor: () => unknown = () => ({ status: 200, data: { ...nonBleMonitor } }),
): void {
  axiosInstance.get.mockImplementation(async (url: string) => {
    if (url.includes('/users/me')) {
      return { status: 200, data: { role: 'PATIENT', username: 'u', id: 'patient-id' } };
    }
    if (url.includes('/monitor/data')) {
      return monitor();
    }
    if (url.includes('/patient/connect/data')) {
      const host = new URL(url).hostname;
      const handler = connect[host];
      if (!handler) throw new Error('unexpected data host: ' + host);
      const response = handler();
      // A factory that *returns* an Error models an HTTP/transport failure:
      // re-throw it so the mock rejects the way axios would.
      if (response instanceof Error) throw response;
      return response;
    }
    throw new Error('unexpected url: ' + url);
  });
}

describe('fetchAsPatient() legacy connect/data host fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tries the configured carelink host first and stops when it has data', async () => {
    stubConnect({
      'carelink.minimed.eu': () => ({ status: 200, data: connectPayload }),
      'clcloud.minimed.eu': () => emptyOk(),
    });

    const data = await euClient().fetch();

    expect(data).toEqual(connectPayload);
    // Exactly one request, to the configured host — the sibling host must
    // not be touched on the path that already works.
    expect(connectCalls()).toEqual([
      expect.stringContaining('https://carelink.minimed.eu/patient/connect/data?'),
    ]);
  });

  it('tries the clcloud host when the carelink host returns an empty 200 body', async () => {
    stubConnect({
      'carelink.minimed.eu': emptyOk,
      'clcloud.minimed.eu': () => ({ status: 200, data: connectPayload }),
    });

    const data = await euClient().fetch();

    expect(data).toEqual(connectPayload);
    expect(connectCalls()).toEqual([
      expect.stringContaining('https://carelink.minimed.eu/patient/connect/data?'),
      expect.stringContaining('https://clcloud.minimed.eu/patient/connect/data?'),
    ]);
  });

  it('tries the clcloud host when the carelink host errors out', async () => {
    stubConnect({
      'carelink.minimed.eu': () => http500(),
      'clcloud.minimed.eu': () => ({ status: 200, data: connectPayload }),
    });

    const data = await euClient().fetch();

    expect(data).toEqual(connectPayload);
    expect(connectCalls()).toHaveLength(2);
  });

  it('does not treat a 200 with an empty body as data', async () => {
    // Both hosts answer 200 + {}. The lookup must not short-circuit on the
    // first one, and the result is the pre-#74 behaviour: the empty payload
    // the configured host returned, not an invented error.
    stubConnect({
      'carelink.minimed.eu': emptyOk,
      'clcloud.minimed.eu': emptyOk,
    });

    const data = await euClient().fetch();

    expect(data).toEqual({});
    expect(connectCalls()).toHaveLength(2);
  });

  it('does not treat a 200 with an empty string body as data', async () => {
    stubConnect({
      'carelink.minimed.eu': () => ({ status: 200, data: '' }),
      'clcloud.minimed.eu': () => ({ status: 200, data: connectPayload }),
    });

    await expect(euClient().fetch()).resolves.toEqual(connectPayload);
    expect(connectCalls()).toHaveLength(2);
  });

  it('does not treat a 200 with a non-empty string body as data', async () => {
    // A candidate answering 200 with an HTML/plain-text body (or a JSON
    // scalar) is not CareLink data: hasPayload() only accepts a non-empty
    // object. With the old `data.length > 0` string branch this returned
    // the string as data and the sibling was never tried.
    stubConnect({
      'carelink.minimed.eu': () => ({ status: 200, data: '<html><body>gateway</body></html>' }),
      'clcloud.minimed.eu': () => ({ status: 200, data: connectPayload }),
    });

    await expect(euClient().fetch()).resolves.toEqual(connectPayload);
    expect(connectCalls()).toHaveLength(2);
  });

  it('surfaces the configured host error when every host fails', async () => {
    // fetch()'s retry policy must still see the configured host's error —
    // silently succeeding (or swallowing) would break the circuit-breaker
    // and 401-refresh paths that hang off it.
    stubConnect({
      'carelink.minimed.eu': () => http404(),
      'clcloud.minimed.eu': () => http502(),
    });

    const client = euClient();
    // NF2: the configured host's error is the one that propagates. Giving the
    // two hosts DIFFERENT statuses makes `firstError ??= e` observable —
    // with both at 404 the test passes either way, so the precedence the
    // ARCHITECTURE doc states as a rule was undefended.
    await expect(client.fetch()).rejects.toMatchObject({ response: { status: 404 } });
    // Both hosts were tried before giving up, and the failure still reached
    // the circuit breaker — a swallowed or replaced error would silently
    // break the 401-refresh and circuit-breaker paths that hang off it.
    expect(connectCalls()).toHaveLength(2);
    expect(client.getConsecutiveFailures()).toBe(1);
  });

  it('does not accept a non-200 answer as connect data (NF3)', async () => {
    // NF3: the loop requires status === 200. The response interceptor passes
    // any <400 through as a response, and maxRedirects is 0, so without this
    // gate a redirect carrying a body would be returned as CareLinkData.
    stubConnect({
      'carelink.minimed.eu': () => ({ status: 302, data: { location: '/next' } }),
      'clcloud.minimed.eu': () => ({ status: 200, data: connectPayload }),
    });

    await expect(euClient().fetch()).resolves.toEqual(connectPayload);
  });

  it('makes no extra request when the monitor endpoint already has the data', async () => {
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'u', id: 'patient-id' } };
      }
      if (url.includes('/monitor/data')) {
        return { status: 200, data: connectPayload };
      }
      throw new Error('unexpected url: ' + url);
    });

    // 4 keys > 1, no BLE family: the monitor response is returned verbatim
    // and neither data host is contacted.
    await expect(euClient().fetch()).resolves.toEqual(connectPayload);
    expect(connectCalls()).toEqual([]);
  });
});

describe('isBleDevice() call sites in the fetch paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Issue #73, call-site half: the model fields must reach the matcher, not
   * just the family fields. Medtronic's resolver prefers `deviceModel`, then
   * `sensorModel`, and a Generic pump family string carries no BLE token —
   * so before this, a Simplera / 780G identified only by model number fell
   * through to the legacy endpoint and came back empty.
   */
  it('routes to the BLE endpoint when deviceModel identifies a BLE device', async () => {
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'real-user', id: 'patient-id' } };
      }
      if (url.includes('/monitor/data')) {
        return {
          status: 200,
          data: { deviceFamily: 'PARADIGM', deviceModel: 'MMT-7841', sensorState: 'NORMAL' },
        };
      }
      if (url.includes('/countries/settings')) {
        return {
          status: 200,
          data: { blePereodicDataEndpoint: 'https://clcloud.example/connect/carepartner/v6/display/message' },
        };
      }
      throw new Error('unexpected url: ' + url);
    });
    const bleData = { deviceFamily: 'PARADIGM', deviceModel: 'MMT-7841', sgs: [] };
    axiosInstance.post.mockResolvedValue({ status: 200, data: bleData });

    await expect(euClient().fetch()).resolves.toEqual(bleData);
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
    expect(connectCalls()).toEqual([]);
  });

  it('routes a Minimed Flex payload to the BLE endpoint (#91)', async () => {
    // The exact upstream failure (domien-f/carelink-bridge#3): a Flex account
    // fetched "Success" with zero data because the family string matched
    // nothing. Family-only identification here — the hardest case, no model.
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'real-user', id: 'patient-id' } };
      }
      if (url.includes('/monitor/data')) {
        return {
          status: 200,
          data: { deviceFamily: 'Minimed Flex', sensorState: 'NORMAL' },
        };
      }
      if (url.includes('/countries/settings')) {
        return {
          status: 200,
          data: { blePereodicDataEndpoint: 'https://clcloud.example/connect/carepartner/v6/display/message' },
        };
      }
      throw new Error('unexpected url: ' + url);
    });
    const bleData = { deviceFamily: 'Minimed Flex', sgs: [] };
    axiosInstance.post.mockResolvedValue({ status: 200, data: bleData });

    await expect(euClient().fetch()).resolves.toEqual(bleData);
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
    // The legacy connect/data path must never be touched for a Flex device —
    // that is the route that returns {} and produces the silent zero-data fetch.
    expect(connectCalls()).toEqual([]);
  });

  it('routes to the BLE endpoint when only sensorModel is present', async () => {
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'real-user', id: 'patient-id' } };
      }
      if (url.includes('/monitor/data')) {
        return {
          status: 200,
          data: { deviceFamily: 'GUARDIAN', sensorModel: 'SKU-78959-01', sensorState: 'NORMAL' },
        };
      }
      if (url.includes('/countries/settings')) {
        return {
          status: 200,
          data: { blePereodicDataEndpoint: 'https://clcloud.example/connect/carepartner/v6/display/message' },
        };
      }
      throw new Error('unexpected url: ' + url);
    });
    axiosInstance.post.mockResolvedValue({ status: 200, data: { sgs: [] } });

    await euClient().fetch();
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-string model value instead of crashing', async () => {
    // A partial payload can carry a number or null where a string belongs;
    // that must not throw and must not look like a BLE device. (One key, so
    // the monitor branch falls through to the connect fallback.)
    stubConnect(
      {
        'carelink.minimed.eu': () => ({ status: 200, data: connectPayload }),
        'clcloud.minimed.eu': emptyOk,
      },
      () => ({ status: 200, data: { deviceModel: 12345 } }),
    );

    await expect(euClient().fetch()).resolves.toEqual(connectPayload);
    expect(axiosInstance.post).not.toHaveBeenCalled();
  });


  /**
   * F1 regression — found by the review agent, which correctly scored the
   * branch DO-NOT-MERGE for it.
   *
   * Pre-#74 behaviour: one candidate, whatever it returned was the answer,
   * so a throw propagated into fetch()'s retry/circuit-breaker.
   *
   * The bug: the first implementation returned an empty body from *any*
   * candidate, including a bodyless 200 from the SIBLING host. So when the
   * configured host threw and only the sibling answered `{}`, the throw was
   * discarded and `{}` was returned as data. Consequences on a CGM bridge:
   *   - fetch() records a circuit-breaker SUCCESS, so an outage stops counting
   *   - a 401 never reaches `forceRefresh`, so the token is not refreshed
   *   - the operator sees "no data" while CareLink was erroring
   * The configured host's error must win. Pre-#74 preserved exactly.
   */
  it('prefers the configured host error over an empty body from the sibling (F1)', async () => {
    stubConnect({
      'carelink.minimed.eu': () => http404(),
      'clcloud.minimed.eu': () => ({ status: 200, data: {} }),
    });

    await expect(euClient().fetch()).rejects.toMatchObject({ response: { status: 404 } });
    // Both hosts were tried, so this is not "sibling skipped". fetch() retries,
    // so count host coverage rather than a total.
    const hosts = new Set(connectCalls().map((u) => new URL(u).hostname));
    expect([...hosts].sort()).toEqual(['carelink.minimed.eu', 'clcloud.minimed.eu']);
  });

  it('still returns the configured host empty body when the sibling throws (pre-#74 preserved)', async () => {
    stubConnect({
      'carelink.minimed.eu': () => ({ status: 200, data: {} }),
      'clcloud.minimed.eu': () => http404(),
    });

    // Pre-#74 this returned `{}` (one candidate, whatever it gave). Must not
    // become an error just because a second host was introduced.
    await expect(euClient().fetch()).resolves.toEqual({});
    const hosts = new Set(connectCalls().map((u) => new URL(u).hostname));
    expect([...hosts].sort()).toEqual(['carelink.minimed.eu', 'clcloud.minimed.eu']);
  });

  /**
   * NGF2 — the carepartner path previously had ZERO test coverage: every
   * other test here mocks /users/me as role 'PATIENT'. This covers it, with
   * model-only device identification.
   *
   * Honest limitation: dropping the `model` argument at the carepartner call
   * site is NOT detectable from this test, because both the BLE branch and
   * the standard carepartner flow converge on the same countrySettings
   * fetch and an identical POST body. So this test proves the carepartner
   * path works end-to-end; it does not pin the model argument in isolation.
   * The model argument IS pinned by the two ble-detection tests that exercise
   * `isBleDevice` directly with models, and by the patient call-site tests.
   * Stated here so the next reviewer does not have to rediscover it.
   */
  it('routes a carepartner account via deviceModel to the BLE endpoint (NGF2)', async () => {
    stubConnect({
      'carelink.minimed.eu': () => ({ status: 200, data: { ...nonBleMonitor } }),
    });
    // Care-partner account, and the ONLY device identifier is the model.
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'CARE_PARTNER', username: 'u', id: 'cp-id' } };
      }
      if (url.includes('/monitor/data')) {
        // No family string at all — model-only identification.
        return { status: 200, data: { deviceModel: 'MMT-7841', medicalDeviceFamily: 'PARADIGM' } };
      }
      if (url.includes('/m2m/links/patients')) {
        return { status: 200, data: [{ username: 'patient-x' }] };
      }
      if (url.includes('/countries/settings')) {
        return { status: 200, data: { blePereodicDataEndpoint: 'https://clcloud.minimed.eu/connect/carepartner/v6/display/message' } };
      }
      if (url.includes('display/message')) {
        return { status: 200, data: blePayload };
      }
      throw new Error('unexpected url: ' + url);
    });
    axiosInstance.post.mockResolvedValue({ status: 200, data: blePayload });

    await expect(euClient().fetch()).resolves.toEqual(blePayload);
  });

  /**
   * NGF3 — the upstream PR #2 `medicalDeviceFamily` fallback. The existing
   * tests with "fallback" in their name perform the `||` inside the TEST BODY
   * and pass a pre-resolved string, so they can never detect a regression in
   * the production call site. This one supplies only `medicalDeviceFamily`
   * to the real fetch path and asserts the BLE endpoint is taken.
   */
  it('still detects BLE when only medicalDeviceFamily is set, at the call site (NGF3)', async () => {
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'u', id: 'patient-id' } };
      }
      if (url.includes('/monitor/data')) {
        // deviceFamily absent entirely — the upstream PR #2 bug condition.
        return { status: 200, data: { medicalDeviceFamily: 'BLE_MINIMED' } };
      }
      if (url.includes('/countries/settings')) {
        return { status: 200, data: { blePereodicDataEndpoint: 'https://clcloud.minimed.eu/connect/carepartner/v6/display/message' } };
      }
      if (url.includes('display/message')) {
        return { status: 200, data: blePayload };
      }
      throw new Error('unexpected url: ' + url);
    });
    axiosInstance.post.mockResolvedValue({ status: 200, data: blePayload });

    await expect(euClient().fetch()).resolves.toEqual(blePayload);
  });

  /*
   * NGF4 (partial) — deviceModel-vs-sensorModel precedence is NOT tested here:
   * the resolver `deviceIdentity()` is module-private, and isBleDevice() takes
   * only (family, model). Making it observable would mean widening the export
   * surface of client.ts purely for a test. Recorded rather than papered over;
   * the same limitation applies to family-precedence order. Add an export if
   * this ever matters.
   */

  /*
   * NGF4 — "the returned empty body is the configured host's, not a later
   * overwrite" is NOT testable, and deliberately not asserted. Any body
   * distinguishable enough to reveal which host produced it is also non-empty
   * enough for hasPayload() to accept and end the loop. So the two markers
   * cannot coexist in a single reachable state. Recorded rather than
   * disguised as coverage.
   */

});
