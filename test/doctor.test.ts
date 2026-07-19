import { describe, it, expect, vi } from 'vitest';
import {
  checkConfig,
  checkLoginData,
  checkCareLink,
  checkNightscout,
  formatResults,
  type Probe,
} from '../src/doctor.js';
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
    const login = { access_token: tokenWithExp(NOW / 1000 + 3600, { preferred_username: 'jack', country: 'GB' }) } as LoginData;
    const r = checkLoginData(login, NOW);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('60 min');
    expect(r.detail).toContain('jack');
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
