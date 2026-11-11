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
 * Membership is a claim about which routes exist, and each version below is
 * pinned to the observation that justifies it:
 *
 *  - **v12 was added** after area B probed it live (2026-10-12): `GET
 *    v12/display/message` is `401 UnauthorizedException` + `x-ca-err: 990` on
 *    all three cumulus hosts, and `OPTIONS` returns 200 + CORS — a route that
 *    exists and is token-gated, not a 403 no-route. The live GET set is
 *    `{11, 12, 13}`, so a list of `[13, 11, 6]` was missing a live version
 *    [source: docs/03 §6; findings-log/2026-10-12-area-b-v12-routing/FINDINGS.md].
 *  - **v5 stays out**: 403 at the router's no-route body, so it can only cost a
 *    request. This test exists to keep it out if someone "restores" the old
 *    `[13, 11, 6, 5]` list from history.
 *  - **v6 stays in**: `GET` is 403 but `OPTIONS` is 200 + CORS on all three
 *    hosts, i.e. POST-only. This bridge POSTs, so v6 is a real target.
 */
describe('buildEndpointCandidates()', () => {
  it('puts v13 first even when the config hands out the legacy v6 URL', () => {
    expect(
      buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v6/display/message'),
    ).toEqual([
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v12/display/message',
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

  it('includes the live but token-gated v12 route (area B, 2026-10-12)', () => {
    // The regression this guards: `[13, 11, 6]` omitted a live version. v12
    // answers 401 (route exists, token-gated) on all three hosts, so it is a
    // viable candidate; it sits second because nothing establishes it serves
    // data for any account.
    const candidates = buildEndpointCandidates(
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
    );
    expect(candidates).toContain(
      'https://clcloud.minimed.eu/connect/carepartner/v12/display/message',
    );
    expect(candidates.indexOf('https://clcloud.minimed.eu/connect/carepartner/v12/display/message'))
      .toBeLessThan(
        candidates.indexOf('https://clcloud.minimed.eu/connect/carepartner/v11/display/message'),
      );
  });

  it('keeps the POST-only v6 route (403 on GET, 200 on OPTIONS)', () => {
    // Dropping v6 because "GET is 403" would be the classic method-blind
    // reading: the route is registered without a GET method, and the bridge
    // POSTs. v6 must stay, last.
    const candidates = buildEndpointCandidates(
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
    );
    expect(candidates[candidates.length - 1]).toBe(
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
    );
  });

  it('is idempotent when the config already hands out the newest version', () => {
    expect(
      buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v13/display/message'),
    ).toEqual([
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v12/display/message',
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
    expect(candidates).toHaveLength(4);
    expect(candidates).not.toContain(
      'https://clcloud.minimed.eu/connect/carepartner/v14/display/message',
    );
  });

  it('does not include the fallback cumulus v2 route the discovery doc advertises', () => {
    // A v2 URL is what an unkeyed discovery tail hands out. Substituting a v2
    // segment would swap the whole API generation, not the route version, so
    // v2 must never enter the candidate list even when the config names it.
    const candidates = buildEndpointCandidates(
      'https://clcloud.minimed.eu/connect/carepartner/v2/display/message',
    );
    expect(candidates.some((u) => /\/v2\//.test(u))).toBe(false);
  });

  it('returns an unversioned URL as the only candidate', () => {
    expect(buildEndpointCandidates('https://example.com/display/message')).toEqual([
      'https://example.com/display/message',
    ]);
  });
});
