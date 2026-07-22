import { describe, it, expect } from 'vitest';
import { DISCOVERY_APP_VERSION, buildDiscoveryUrl } from '../src/discovery.js';

/**
 * Discovery pinning is a load-bearing operational guard (see
 * research/medtronic-carelink-2026-07-21/01-endpoint-matrix.md for the
 * per-version table). These tests assert the production URL template
 * directly so a future contributor who edits `buildDiscoveryUrl` or the
 * pinned version string cannot silently regress the bridge to a no-Auth0
 * track (3.4 / 4.0).
 */

describe('DISCOVERY_APP_VERSION', () => {
  it('is pinned to android/3.6 (the Auth0-carrying track)', () => {
    expect(DISCOVERY_APP_VERSION).toBe('android/3.6');
  });

  it('is not the no-Auth0 v3.4 / v4.0 tracks', () => {
    expect(DISCOVERY_APP_VERSION).not.toBe('android/3.4');
    expect(DISCOVERY_APP_VERSION).not.toBe('android/4.0');
  });
});

describe('buildDiscoveryUrl', () => {
  it('returns the US discovery URL with the pinned app version', () => {
    expect(buildDiscoveryUrl(true)).toBe(
      'https://clcloud.minimed.com/connect/carepartner/v13/discover/android/3.6',
    );
  });

  it('returns the EU discovery URL with the pinned app version', () => {
    expect(buildDiscoveryUrl(false)).toBe(
      'https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/3.6',
    );
  });

  it('uses the v13 base path (the only track the v3.6/3.7 Auth0 configs use)', () => {
    // Path-level pinning: even if a future change permutes the host, the
    // v13 path must stay — that's the cumulative-version the
    // Auth0SSOConfiguration config blocks hang off.
    expect(buildDiscoveryUrl(true)).toContain('/connect/carepartner/v13/');
    expect(buildDiscoveryUrl(false)).toContain('/connect/carepartner/v13/');
  });
});
