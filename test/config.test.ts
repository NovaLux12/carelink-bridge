import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * src/config.ts had zero direct coverage (#89). It turns operator env vars
 * into runtime behaviour, including safety-relevant defaults — and the
 * CARELINK_QUIET coercion table below, which is undocumented anywhere else.
 */
const SAVED = { ...process.env };

const REQUIRED = {
  CARELINK_USERNAME: 'user@example.com',
  CARELINK_PASSWORD: 's3cret',
  API_SECRET: 'nightscout-secret',
};

function cleanEnv() {
  for (const k of Object.keys(process.env)) {
    // Must cover every spelling loadConfig() actually reads, not just the
    // documented uppercase ones: readEnv() also looks up
    // CUSTOMCONNSTR_<key> and the LOWERCASE key (`process.env[key.toLowerCase()]`
    // in src/config.ts), and the country/language vars are MMCONNECT_*.
    // An ambient MMCONNECT_COUNTRYCODE leaked in and broke two of the
    // safety-default assertions below.
    if (
      /^(CARELINK_|MMCONNECT_|API_SECRET$|NS$|WEBSITE_HOSTNAME|LOG_FORMAT$|STALE_|CUSTOMCONNSTR_)/i.test(
        k,
      )
    ) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, REQUIRED);
}

beforeEach(cleanEnv);
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

describe('loadConfig() required vars', () => {
  it.each(['CARELINK_USERNAME', 'CARELINK_PASSWORD', 'API_SECRET'])(
    'throws when %s is missing',
    (key) => {
      delete process.env[key];
      expect(() => loadConfig()).toThrow(key);
    },
  );
});

describe('loadConfig() safety-relevant defaults', () => {
  it('resolves documented defaults with a bare-minimum env', () => {
    const c = loadConfig();
    expect(c.interval).toBe(300 * 1000);
    expect(c.sgvLimit).toBe(24);
    expect(c.staleThresholdMs).toBe(15 * 60 * 1000);
    expect(c.circuitThreshold).toBe(5);
    expect(c.circuitCooldownMs).toBe(60 * 1000);
    expect(c.countryCode).toBe('gb');
    expect(c.language).toBe('en');
    expect(c.logFormat).toBe('pretty');
    expect(c.metricsPort).toBe(0);
  });

  it('accepts json LOG_FORMAT and falls back to pretty for anything else', () => {
    process.env['LOG_FORMAT'] = 'json';
    expect(loadConfig().logFormat).toBe('json');
    process.env['LOG_FORMAT'] = 'xml';
    expect(loadConfig().logFormat).toBe('pretty');
  });
});

describe('CARELINK_QUIET truthiness (#89)', () => {
  // Pinned current behaviour, not endorsed behaviour: readEnv() coerces only
  // the literal strings 'true'/'false'/'null', and readEnvBool() falls back
  // to Boolean(val) for anything else. So '0' and 'no' mean quiet while an
  // empty value means NOT quiet. If this ever changes, update USER-GUIDE too.
  it.each([
    ['true', false],
    ['false', true],
    ['0', false],
    ['no', false],
    ['yes', false],
    // '' is falsy, so the `||` chain in readEnv() skips it and it behaves
    // as unset (quiet) — verified, not assumed.
    ['', false],
  ] as Array<[string, boolean]>)('CARELINK_QUIET=%j -> verbose=%j', (val, verbose) => {
    process.env['CARELINK_QUIET'] = val;
    expect(loadConfig().verbose).toBe(verbose);
  });

  it('defaults to quiet when unset', () => {
    delete process.env['CARELINK_QUIET'];
    expect(loadConfig().verbose).toBe(false);
  });
});

describe('CUSTOMCONNSTR_ fallback', () => {
  it('reads Azure-style connection-string vars', () => {
    delete process.env['CARELINK_USERNAME'];
    process.env['CUSTOMCONNSTR_CARELINK_USERNAME'] = 'azure-user';
    expect(loadConfig().username).toBe('azure-user');
  });
});
