import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The identity endpoint's unexpected-shape failure mode, end to end.
 *
 * Area AO / research `docs/02` §4 leave the identity *namespace* open: the
 * official app reads `/api/carepartner/v2/{users/me,links/patients}` while this
 * bridge reads `/patient/users/me`, both 401 unauthenticated, so which one a
 * given token can read is account-gated and unverified. Implementing
 * carepartner/v2 on that evidence would be guessing, so it is NOT implemented.
 *
 * What is testable without credentials is that the failure is LEGIBLE. Measured
 * before the guard landed (scratch probe, since deleted): a 200 from
 * `/patient/users/me` carrying an HTML page, `[]`, `null`, `42`, or
 * `{"error":{"type":"InvalidToken"}}` produced an empty role, fell through the
 * legacy chain and returned `{}` as SUCCESS — indistinguishable downstream from
 * an account with no data. That is the "silent zero-data upload" class this
 * bridge has already been bitten by elsewhere.
 *
 * These tests exercise the real fetch path (`client.fetch()`), not the helper in
 * isolation, because a helper that is never called is not a guard. The
 * helper-level contract is in test/login-errors.test.ts.
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
import { UnexpectedUserInfoError } from '../src/login-errors.js';

/** Route every call to a stub; `/users/me` returns whatever `userBody` is. */
function stub(userBody: unknown): void {
  axiosInstance.get.mockImplementation(async (url: string) => {
    if (url.includes('/patient/users/me')) return { status: 200, data: userBody };
    if (url.includes('/patient/monitor/data')) return { status: 200, data: {} };
    if (url.includes('/patient/connect/data')) return { status: 200, data: {} };
    if (url.includes('/discover/')) return { status: 200, data: { CP: [] } };
    if (url.includes('/countries/settings')) return { status: 200, data: {} };
    throw new Error('unexpected url: ' + url);
  });
  axiosInstance.post.mockResolvedValue({ status: 200, data: {} });
}

function euClient(): CareLinkClient {
  return new CareLinkClient({ username: 'u', password: 'p', server: 'EU' });
}

describe('/patient/users/me unexpected shape fails loudly (area AO)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['an HTML error page', '<html><body>gateway</body></html>'],
    ['a JSON array', [{ username: 'u', role: 'PATIENT' }]],
    ['null', null],
    ['a bare number', 42],
    ['a JSON error envelope', { error: { type: 'InvalidToken' } }],
  ])('throws the NAMED error rather than returning an empty payload for %s', async (_label, body) => {
    stub(body);

    // The pre-guard behaviour is what this asserts against: every one of these
    // bodies used to resolve to `{}` with no error at all.
    await expect(euClient().fetch()).rejects.toBeInstanceOf(UnexpectedUserInfoError);
  });

  it('the surfaced error names the endpoint and stays greppable after retries', async () => {
    stub('<html>login</html>');

    try {
      await euClient().fetch();
      expect.unreachable('expected the fetch to fail');
    } catch (e) {
      expect(e).toBeInstanceOf(UnexpectedUserInfoError);
      const err = e as UnexpectedUserInfoError;
      expect(err.name).toBe('UnexpectedUserInfoError');
      expect(err.message).toContain('/patient/users/me');
    }
  });

  it('an ordinary user record still goes through untouched', async () => {
    // The guard must not become a new way to fail on a working account. This
    // account has a device family the legacy path recognises, so the fetch
    // returns the connect payload verbatim.
    axiosInstance.get.mockImplementation(async (url: string) => {
      if (url.includes('/patient/users/me')) {
        return { status: 200, data: { role: 'PATIENT', username: 'real-user', id: 'pid' } };
      }
      if (url.includes('/patient/monitor/data')) {
        return { status: 200, data: { medicalDeviceFamily: 'PARADIGM' } };
      }
      if (url.includes('/patient/connect/data')) {
        return {
          status: 200,
          data: { lastSG: { sg: 120, kind: 'SG' }, sgs: [], medicalDeviceFamily: 'PARADIGM' },
        };
      }
      throw new Error('unexpected url: ' + url);
    });

    const data = await euClient().fetch();
    expect(data).toMatchObject({ medicalDeviceFamily: 'PARADIGM' });
  });

  it('a record missing username and role is still accepted (leniency is deliberate)', async () => {
    // Field-level tolerance is pinned in test/username-source.test.ts: a missing
    // username falls back to CARELINK_USERNAME. Only a body that is not an
    // object at all is a hard failure.
    stub({});
    await expect(euClient().fetch()).resolves.toBeDefined();
  });
});
