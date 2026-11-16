import { describe, it, expect, vi } from 'vitest';
import {
  checkConfig,
  checkLoginData,
  checkCareLink,
  checkNightscout,
  checkRegion,
  checkCumulusTrack,
  countryRegions,
  formatResults,
  type Probe,
} from '../src/doctor.js';
import { DISCOVERY_APP_VERSION, buildDiscoveryUrl } from '../src/discovery.js';
import type { LoginData } from '../src/types/carelink.js';

function tokenWithExp(expSeconds: number, details?: Record<string, unknown>): string {
  const payload = { exp: expSeconds, token_details: details };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `header.${b64}.sig`;
}

const NOW = 1_700_000_000_000;

describe('checkConfig()', () => {
  it('passes when all required vars are present', () => {
    const r = checkConfig({ CARELINK_USERNAME: 'u', CARELINK_PASSWORD: 'p', API_SECRET: 's', NS: 'https://ns' });
    expect(r.status).toBe('ok');
  });

  it('fails and names each missing var', () => {
    const r = checkConfig({ CARELINK_USERNAME: 'u' });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('CARELINK_PASSWORD');
    expect(r.detail).toContain('API_SECRET');
    expect(r.detail).toContain('NS');
    expect(r.detail).not.toContain('CARELINK_USERNAME');
  });
});

describe('checkLoginData()', () => {
  it('warns when logindata is absent', () => {
    expect(checkLoginData(null).status).toBe('warn');
  });

  it('reports a valid token with time remaining and identity', () => {
    const login = { access_token: tokenWithExp(NOW / 1000 + 3600, { preferred_username: 'demo-user', country: 'GB' }) } as LoginData;
    const r = checkLoginData(login, NOW);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('60 min');
    expect(r.detail).toContain('demo-user');
    expect(r.detail).toContain('GB');
  });

  it('warns when the token is already expired', () => {
    const login = { access_token: tokenWithExp(NOW / 1000 - 600) } as LoginData;
    const r = checkLoginData(login, NOW);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('expired');
  });

  it('warns when the token payload is malformed', () => {
    const login = { access_token: 'not-a-jwt' } as LoginData;
    expect(checkLoginData(login, NOW).status).toBe('warn');
  });
});

describe('checkCareLink()', () => {
  it('passes on a 200 from the discovery endpoint', async () => {
    const probe: Probe = vi.fn(async () => ({ status: 200, data: {} }));
    const r = await checkCareLink(probe, false);
    expect(r.status).toBe('ok');
    expect(probe).toHaveBeenCalledWith(expect.stringContaining('clcloud.minimed.eu'));
  });

  it('uses the US host when isUS is true', async () => {
    const probe: Probe = vi.fn(async () => ({ status: 200, data: {} }));
    await checkCareLink(probe, true);
    expect(probe).toHaveBeenCalledWith(expect.stringContaining('clcloud.minimed.com'));
  });

  it('fails on a network error', async () => {
    const probe: Probe = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const r = await checkCareLink(probe, false);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('ENOTFOUND');
  });

  // Regression for issue #145: the URL used to be a hardcoded
  // `.../discover/android/3.6` literal, so moving DISCOVERY_APP_VERSION changed
  // what login probed and left doctor checking an abandoned pin. Asserting the
  // probe URL against buildDiscoveryUrl() makes that drift a test failure.
  it('probes the same discovery URL login builds, not a hardcoded pin', async () => {
    const probe: Probe = vi.fn(async () => ({ status: 200, data: {} }));
    await checkCareLink(probe, false);
    expect((probe as any).mock.calls[0][0]).toBe(buildDiscoveryUrl(false));

    await checkCareLink(probe, true);
    expect((probe as any).mock.calls[1][0]).toBe(buildDiscoveryUrl(true));
  });

  it('names the pin it probed, so a moved pin is visible in the output', async () => {
    const probe: Probe = vi.fn(async () => ({ status: 200, data: {} }));
    const r = await checkCareLink(probe, false);
    expect(r.detail).toContain(DISCOVERY_APP_VERSION);
  });
});

describe('checkNightscout()', () => {
  it('checks reachability then verifies the secret', async () => {
    const probe: Probe = vi.fn(async (url) => {
      if (url.includes('status.json')) return { status: 200, data: {} };
      if (url.includes('verifyauth')) return { status: 200, data: { message: 'OK' } };
      throw new Error('unexpected ' + url);
    });
    const results = await checkNightscout(probe, 'https://ns.example.com/', 'sekret');
    expect(results.map(r => r.status)).toEqual(['ok', 'ok']);
    // trailing slash normalized
    expect((probe as any).mock.calls[0][0]).toBe('https://ns.example.com/api/v1/status.json');
    // secret sent hashed, not in the clear
    const authHeaders = (probe as any).mock.calls[1][1];
    expect(authHeaders['api-secret']).toMatch(/^[0-9a-f]{40}$/);
    expect(authHeaders['api-secret']).not.toBe('sekret');
  });

  it('flags a rejected secret as a failure', async () => {
    const probe: Probe = vi.fn(async (url) => {
      if (url.includes('status.json')) return { status: 200, data: {} };
      return { status: 401, data: { message: 'UNAUTHORIZED' } };
    });
    const results = await checkNightscout(probe, 'https://ns.example.com', 'wrong');
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('fail');
    expect(results[1].detail).toContain('rejected');
  });

  it('stops at reachability when Nightscout is unreachable', async () => {
    const probe: Probe = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const results = await checkNightscout(probe, 'https://ns.example.com', 'sekret');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
  });

  // -------------------------------------------------------------------------
  // Regression: a SECURED Nightscout was reported as unreachable.
  //
  // Nightscout's standard `AUTH_DEFAULT_ROLES=denied` makes an unauthenticated
  // `/api/v1/status.json` return 401. The old code probed without the secret,
  // treated 401 as "unreachable", and returned early — so a healthy, correctly
  // secured server produced a ✗ on reachability and the API-secret check never
  // ran at all. Measured against Nightscout 15.0.9 on 2026-11-15.
  //
  // Every test here fails against the pre-fix implementation.
  // -------------------------------------------------------------------------

  it('sends the hashed secret on the reachability probe', async () => {
    const probe: Probe = vi.fn(async () => ({ status: 200, data: {} }));
    await checkNightscout(probe, 'https://ns.example.com', 'sekret');
    const reachHeaders = (probe as any).mock.calls[0][1];
    expect(reachHeaders?.['api-secret']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports reachable, not unreachable, when status.json 401s with a secret present', async () => {
    const probe: Probe = vi.fn(async (url: string) => {
      if (url.includes('status.json')) return { status: 401, data: {} };
      return { status: 200, data: { message: { canRead: true, message: 'OK' } } };
    });
    const results = await checkNightscout(probe, 'https://ns.example.com', 'sekret');
    expect(results[0].name).toBe('Nightscout reachable');
    expect(results[0].status).toBe('ok');
    // ...and it goes on to the auth check rather than short-circuiting.
    expect(results).toHaveLength(2);
    expect(results[1].name).toBe('Nightscout API secret');
  });

  it('still fails reachability on a 5xx', async () => {
    const probe: Probe = vi.fn(async () => ({ status: 502, data: {} }));
    const results = await checkNightscout(probe, 'https://ns.example.com', 'sekret');
    expect(results[0].status).toBe('fail');
    expect(results).toHaveLength(1);
  });

  it('does not claim reachability from a 401 when no secret is configured', async () => {
    // With nothing to authenticate with, a 401 is indistinguishable from a
    // wrong URL pointing at some other protected service. Fail closed.
    const probe: Probe = vi.fn(async () => ({ status: 401, data: {} }));
    const results = await checkNightscout(probe, 'https://ns.example.com', undefined);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
  });

  it('reads the NESTED message shape Nightscout 15 returns from verifyauth', async () => {
    // Current Nightscout: {status:200, message:{canRead,…,message:"OK",…}}.
    // String() on that object gives "[object Object]", which never contains
    // "OK" — so a correct secret was reported as rejected.
    const probe: Probe = vi.fn(async (url: string) => {
      if (url.includes('status.json')) return { status: 200, data: {} };
      return {
        status: 200,
        data: { status: 200, message: { canRead: true, canWrite: true, isAdmin: true, message: 'OK', rolefound: 'NOTFOUND', permissions: 'ROLE' } },
      };
    });
    const results = await checkNightscout(probe, 'https://ns.example.com', 'sekret');
    expect(results[1].status).toBe('ok');
  });

  it('still reads the FLAT message shape older Nightscout versions return', async () => {
    const probe: Probe = vi.fn(async (url: string) => {
      if (url.includes('status.json')) return { status: 200, data: {} };
      return { status: 200, data: { status: 200, message: 'OK' } };
    });
    const results = await checkNightscout(probe, 'https://ns.example.com', 'sekret');
    expect(results[1].status).toBe('ok');
  });

  it('names a 401 from verifyauth as a rejected secret', async () => {
    const probe: Probe = vi.fn(async (url: string) => {
      if (url.includes('status.json')) return { status: 200, data: {} };
      return { status: 401, data: { status: 401, message: 'Unauthorized' } };
    });
    const results = await checkNightscout(probe, 'https://ns.example.com', 'wrong');
    expect(results[1].status).toBe('fail');
    expect(results[1].detail).toContain('API_SECRET rejected');
  });
});

describe('formatResults()', () => {
  it('renders a symbol per status and aligns names', () => {
    const out = formatResults([
      { name: 'A', status: 'ok', detail: 'fine' },
      { name: 'Longer name', status: 'fail', detail: 'broke' },
    ]);
    expect(out).toContain('✓');
    expect(out).toContain('✗');
    expect(out).toContain('fine');
  });
});

// ---------------------------------------------------------------------------
// Region cross-check (issue #145's honest half).
//
// The discovery document's `supportedCountries` maps each country to the region
// that serves it — 109 entries, unauthenticated, live-measured 2026-11-16. So
// doctor CAN answer "is MMCONNECT_SERVER wrong for my country?" without a token,
// which the issue assumed needed one. It still cannot answer for a specific
// ACCOUNT (that needs /patient/users/me, which is 401 unauthenticated) and the
// code says so rather than implying more.
// ---------------------------------------------------------------------------

/** The live document shape: a LIST of single-key objects. */
const discoveryDoc = {
  supportedCountries: [
    { US: { region: 'US', isoCode: 'US', iso3Code: 'USA', flag: '🇺🇸' } },
    { GB: { region: 'EU', isoCode: 'GB', iso3Code: 'GBR', flag: '🇬🇧' } },
    { AU: { region: 'EU', isoCode: 'AU', iso3Code: 'AUS', flag: '🇦🇺' } },
    { DE: { region: 'EU', isoCode: 'DE', iso3Code: 'DEU', flag: '🇩🇪' } },
  ],
};

describe('countryRegions()', () => {
  it('flattens the list-of-single-key-objects shape', () => {
    const m = countryRegions(discoveryDoc);
    expect(m.get('GB')).toBe('EU');
    expect(m.get('US')).toBe('US');
    expect(m.size).toBe(4);
  });

  it('returns an empty map rather than throwing on an unexpected shape', () => {
    // A changed document shape is worth a warning, not a crashed pre-flight.
    for (const bad of [undefined, null, {}, { supportedCountries: 'nope' }, { supportedCountries: [null, 3] }]) {
      expect(countryRegions(bad).size).toBe(0);
    }
  });

  it('upper-cases the country code so lowercase config still matches', () => {
    expect(countryRegions(discoveryDoc).get('GB')).toBe('EU');
  });
});

describe('checkRegion()', () => {
  it('passes when the country maps to the configured region', () => {
    const r = checkRegion(discoveryDoc, { MMCONNECT_SERVER: 'EU', MMCONNECT_COUNTRYCODE: 'gb' });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('GB');
    expect(r.detail).toContain('EU');
  });

  it('FAILS when a GB account is pointed at the US host', () => {
    // This is the misconfiguration the check exists for: the US host answers
    // 200 for discovery, so no existing row would flag it, and the account then
    // 401s in a way that reads like bad credentials.
    const r = checkRegion(discoveryDoc, { MMCONNECT_SERVER: 'US', MMCONNECT_COUNTRYCODE: 'GB' });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('GB is served by the EU region');
    expect(r.detail).toContain('MMCONNECT_SERVER=EU');
  });

  it('defaults the country to gb, matching the client', () => {
    const r = checkRegion(discoveryDoc, { MMCONNECT_SERVER: 'US' });
    expect(r.status).toBe('fail');
  });

  it('defers to MMCONNECT_SERVERNAME, which names a host directly', () => {
    const r = checkRegion(discoveryDoc, { MMCONNECT_SERVERNAME: 'carelink.example.test' });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('MMCONNECT_SERVERNAME');
  });

  it('warns, not fails, when the document carried no usable country list', () => {
    const r = checkRegion({}, { MMCONNECT_SERVER: 'EU' });
    expect(r.status).toBe('warn');
  });

  it('warns, not fails, for a country absent from supportedCountries', () => {
    const r = checkRegion(discoveryDoc, { MMCONNECT_SERVER: 'EU', MMCONNECT_COUNTRYCODE: 'ZZ' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('ZZ');
  });
});

// ---------------------------------------------------------------------------
// Cumulus track (issue #145's "report the track actually seen").
//
// The gate only fires during login. Doctor reporting it means an off-track pin
// is visible BEFORE anyone attempts a login — and the #75 failure mode is
// precisely "login succeeds, then the data call fails with no named error".
// ---------------------------------------------------------------------------

const docWithTrack = (cumulus: string | undefined) => ({
  CP: [
    { region: 'US', baseUrlCumulus: 'https://clcloud.minimed.com/connect/carepartner/v13' },
    cumulus === undefined ? { region: 'EU' } : { region: 'EU', baseUrlCumulus: cumulus },
  ],
});

describe('checkCumulusTrack()', () => {
  it('passes on the v13 track', () => {
    const r = checkCumulusTrack(docWithTrack('https://clcloud.minimed.eu/connect/carepartner/v13'), 'EU');
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('v13');
  });

  it('FAILS on the v11 track — the android/3.5 trap from #75', () => {
    // 3.5 selects Auth0SSOConfiguration, so every key-presence check passes;
    // only the track reveals it. This is the row that makes that visible early.
    const r = checkCumulusTrack(docWithTrack('https://clcloud.minimed.eu/connect/carepartner/v11'), 'EU');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('v11');
    expect(r.detail).toContain('no named error');
  });

  it('FAILS when the region declares no baseUrlCumulus at all', () => {
    const r = checkCumulusTrack(docWithTrack(undefined), 'EU');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('no baseUrlCumulus');
  });

  it('reads the region it was asked about, not the first entry', () => {
    const r = checkCumulusTrack(docWithTrack('https://clcloud.minimed.eu/connect/carepartner/v13'), 'US');
    expect(r.detail).toContain('clcloud.minimed.com');
  });

  it('warns when the region has no CP entry', () => {
    const r = checkCumulusTrack(docWithTrack('https://clcloud.minimed.eu/connect/carepartner/v13'), 'CLINICAL');
    expect(r.status).toBe('warn');
  });

  it('warns, not throws, when CP[] is missing or malformed', () => {
    for (const bad of [{}, null, undefined, { CP: 'nope' }]) {
      expect(checkCumulusTrack(bad, 'EU').status).toBe('warn');
    }
  });
});
