import { describe, it, expect } from 'vitest';
import { NoAuth0SSOConfigurationError, selectAuth0ConfigUrl, type DiscoveryCpEntry } from '../src/login-errors.js';

/**
 * Fixtures below mirror the real discovery documents probed live on
 * 2026-10-09 (see the matrix in src/discovery.ts). Every entry carries
 * `baseUrlCumulus: 'https://clcloud.minimed.<eu|com>/connect/carepartner/v13'`
 * because that is what the live documents do, and because issue #75 made it
 * the load-bearing field: the URL alone no longer proves the entry is on the
 * right track.
 */

/** The verified happy path — android/3.6 / 3.7 / 3.8, cumulus v13. */
const V13 = 'https://clcloud.minimed.com/connect/carepartner/v13';
/** android/3.5 — Auth0 selector present, but cumulus v11 (the #75 trap). */
const V11 = 'https://clcloud.minimed.com/connect/carepartner/v11';
/** android/1.0 / 3.x / 3.9 / 4.0–4.8 / 5.0 / 6.0 / 10.0 — cumulus v2. */
const V2 = 'https://clcloud.minimed.com/connect/carepartner/v2';

describe('selectAuth0ConfigUrl', () => {
  const context = { region: 'us', appVersion: 'android/3.6' };

  it('returns the Auth0SSOConfiguration URL when the entry exposes it (v3.6/3.7 track)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration:
        'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
      baseUrlCumulus: V13,
    };
    expect(selectAuth0ConfigUrl(entry, context)).toBe(
      'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
    );
  });

  it('honours the explicit UseSSOConfiguration selector when set (v3.7 sometimes uses Layer7SSOConfiguration)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Layer7SSOConfiguration',
      Layer7SSOConfiguration:
        'https://carelink.minimed.com/configs/v1/oauth20_sso_carepartner_us_v6.json',
      baseUrlCumulus: V13,
    };
    expect(selectAuth0ConfigUrl(entry, context)).toBe(
      'https://carelink.minimed.com/configs/v1/oauth20_sso_carepartner_us_v6.json',
    );
  });

  it('throws NoAuth0SSOConfigurationError when neither key is present (legacy v3.4 / v4.0 track)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      // Auth0SSOConfiguration absent — this is the legacy/no-Auth0 track.
      baseUrlCumulus: V13,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(
      NoAuth0SSOConfigurationError,
    );
  });

  it('throws when UseSSOConfiguration points at an absent key', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'NonexistentSSOConfiguration',
      baseUrlCumulus: V13,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(
      NoAuth0SSOConfigurationError,
    );
  });

  it('the thrown error carries .name and .message carrying the diagnostic context', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      baseUrlCumulus: V13,
    };
    try {
      selectAuth0ConfigUrl(entry, context);
      // Should not reach here.
      expect.unreachable('expected the helper to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NoAuth0SSOConfigurationError);
      const err = e as NoAuth0SSOConfigurationError;
      expect(err.name).toBe('NoAuth0SSOConfigurationError');
      expect(err.message).toContain('region "us"');
      expect(err.message).toContain('DISCOVERY_APP_VERSION ("android/3.6")');
      expect(err.message).toContain('UseSSOConfiguration=Auth0SSOConfiguration');
    }
  });

  it('treats empty-string SSO URL values as missing', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: '',
      baseUrlCumulus: V13,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(
      NoAuth0SSOConfigurationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #75 — the cumulus-track gate (formerly one version wide)
// ---------------------------------------------------------------------------

describe('selectAuth0ConfigUrl — cumulus-track gate (issue #75)', () => {
  const context = { region: 'us', appVersion: 'android/3.6' };

  it('accepts every verified v13 spelling, on both hosts, untouched', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: 'https://carelink.minimed.eu/configs/v1/carepartner_auth0_ous_sso_config_v1.json',
      baseUrlCumulus: 'https://clcloud.minimed.eu/connect/carepartner/v13',
    };
    expect(selectAuth0ConfigUrl(entry, { region: 'eu', appVersion: 'android/3.7' })).toBe(
      'https://carelink.minimed.eu/configs/v1/carepartner_auth0_ous_sso_config_v1.json',
    );
  });

  // The android/3.5 shape — the one entry the old guard failed to reject.
  it('throws when the entry carries an Auth0 URL but sits on cumulus v11 (android/3.5 shape)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
      baseUrlCumulus: V11,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(NoAuth0SSOConfigurationError);
  });

  it('throws when the selector is absent and the entry is on cumulus v2 (android/4.0 shape)', () => {
    // UseSSOConfiguration absent — this is the no-Auth0 track.
    const entry: DiscoveryCpEntry = {
      SSOConfiguration: 'https://carelink.minimed.com/configs/v1/eu_sso_cp_eu_v6.json',
      baseUrlCumulus: V2,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(NoAuth0SSOConfigurationError);
  });

  it('throws for cumulus v6 (android/3.1) and for a non-v13 suffix on the v13 prefix (v130)', () => {
    for (const cumulus of [
      'https://clcloud.minimed.com/connect/carepartner/v6',
      // A near-miss must not slip through on a prefix match.
      'https://clcloud.minimed.com/connect/carepartner/v130',
      // A trailing slash is a different string; no normalisation (fail-closed).
      'https://clcloud.minimed.com/connect/carepartner/v13/',
      // Relative/path-only value: not the URL shape we verified.
      '/connect/carepartner/v11',
    ]) {
      const entry: DiscoveryCpEntry = {
        UseSSOConfiguration: 'Auth0SSOConfiguration',
        Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
        baseUrlCumulus: cumulus,
      };
      expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(NoAuth0SSOConfigurationError);
    }
  });

  // FAIL-CLOSED branch: baseUrlCumulus missing entirely (unknown future shape).
  it('fails closed when baseUrlCumulus is absent, even with a valid Auth0 URL (documented #75 decision)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
      // baseUrlCumulus deliberately absent — see the fail-closed rationale in
      // src/login-errors.ts (assertSupportedCumulusTrack).
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(NoAuth0SSOConfigurationError);
  });

  it('fails closed when baseUrlCumulus is present but not a string', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
      // Not a string at runtime — that is the point of the case. Cast is
      // deliberate: `baseUrlCumulus` is typed `string | undefined` on
      // DiscoveryCpEntry, so a bare 13 is a type error. The project's
      // tsconfig excludes `test/`, so `npx tsc --noEmit` (and CI) cannot see
      // it — which is exactly how an unchecked type error gets in here.
      baseUrlCumulus: 13 as unknown as string,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(NoAuth0SSOConfigurationError);
  });

  it('the cumulus-track error names the pin, the cumulus value seen, and the verified fallback family', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
      baseUrlCumulus: V11,
    };
    try {
      selectAuth0ConfigUrl(entry, { region: 'eu', appVersion: 'android/3.5' });
      expect.unreachable('expected the cumulus-track gate to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NoAuth0SSOConfigurationError);
      const err = e as NoAuth0SSOConfigurationError;
      expect(err.name).toBe('NoAuth0SSOConfigurationError');
      // the pinned app version
      expect(err.message).toContain('android/3.5');
      // the journald-grep spelling both throws share (F1a): the exact
      // DISCOVERY_APP_VERSION ("<version>") form, not just the bare version
      expect(err.message).toContain('DISCOVERY_APP_VERSION ("android/3.5")');
      // the cumulus value seen
      expect(err.message).toContain(V11);
      // the verified fallback family, and the required track
      expect(err.message).toContain('android/3.6, android/3.7, android/3.8');
      expect(err.message).toContain('/connect/carepartner/v13');
      // and the region/selector context, grep-able like the original message
      expect(err.message).toContain('region "eu"');
      expect(err.message).toContain('UseSSOConfiguration=Auth0SSOConfiguration');
    }
  });

  it('the absent-cumulus error says the field is missing rather than naming a wrong value', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
    };
    try {
      selectAuth0ConfigUrl(entry, context);
      expect.unreachable('expected the cumulus-track gate to throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      expect(err).toBeInstanceOf(NoAuth0SSOConfigurationError);
      expect(err.message).toContain('absent');
      expect(err.message).toContain('baseUrlCumulus');
    }
  });

  it('the gate runs before URL resolution, so a wrong track wins over a resolvable URL', () => {
    // Both guards would fire here (no resolvable key AND a v2 track). The
    // cumulus message is the useful one, so it must be the one thrown.
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'NonexistentSSOConfiguration',
      baseUrlCumulus: V2,
    };
    try {
      selectAuth0ConfigUrl(entry, context);
      expect.unreachable('expected the cumulus-track gate to throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      expect(err).toBeInstanceOf(NoAuth0SSOConfigurationError);
      expect(err.message).toContain(V2);
      expect(err.message).not.toContain('Discovery returned no Auth0 SSO config URL');
    }
  });
});
