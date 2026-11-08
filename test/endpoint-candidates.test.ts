import { describe, it, expect } from 'vitest';
import { buildEndpointCandidates } from '../src/carelink/client.js';

/**
 * Ordering here is load-bearing, not cosmetic.
 *
 * `/patient/countries/settings` hands out `blePereodicDataEndpoint` at **v6**
 * for every country probed (GB/US/NL/DE/IE/AU/CA, 2026-11-08), two generations
 * behind the v13 the discovery document advertises. xDrip+ ignores that field
 * and hardcodes v13. A legacy backend answers 200 with the last records it
 * ever held, so a config-first order lets a stale 200 win the loop before the
 * correct backend is ever tried.
 *
 * v5 is gone: `/connect/carepartner/v5/display/message` has no route at all.
 */
describe('buildEndpointCandidates()', () => {
  it('puts v13 first even when the config hands out the legacy v6 URL', () => {
    expect(
      buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v6/display/message'),
    ).toEqual([
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v11/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
    ]);
  });

  it('does not include the dead v5 route', () => {
    const candidates = buildEndpointCandidates(
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
    );
    expect(candidates.some((u) => /\/v5\//.test(u))).toBe(false);
  });

  it('is idempotent when the config already hands out the newest version', () => {
    expect(
      buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v13/display/message'),
    ).toEqual([
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v11/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
    ]);
  });

  it('normalises an unknown config version down to the known set', () => {
    // An unknown "future" version is not trusted blindly: the known-newest
    // route leads, because the version axis inverts above 3.8 anyway (3.9+
    // discovery cells return the legacy v2 config with no Auth0).
    const candidates = buildEndpointCandidates(
      'https://clcloud.minimed.eu/connect/carepartner/v14/display/message',
    );
    expect(candidates[0]).toBe('https://clcloud.minimed.eu/connect/carepartner/v13/display/message');
    expect(candidates).toHaveLength(3);
    expect(candidates).not.toContain(
      'https://clcloud.minimed.eu/connect/carepartner/v14/display/message',
    );
  });

  it('returns an unversioned URL as the only candidate', () => {
    expect(buildEndpointCandidates('https://example.com/display/message')).toEqual([
      'https://example.com/display/message',
    ]);
  });
});
