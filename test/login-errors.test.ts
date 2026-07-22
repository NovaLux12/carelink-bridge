import { describe, it, expect } from 'vitest';
import { NoAuth0SSOConfigurationError, selectAuth0ConfigUrl, type DiscoveryCpEntry } from '../src/login-errors.js';



describe('selectAuth0ConfigUrl', () => {
  const context = { region: 'us', appVersion: 'android/3.6' };

  it('returns the Auth0SSOConfiguration URL when the entry exposes it (v3.6/3.7 track)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration:
        'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
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
    };
    expect(selectAuth0ConfigUrl(entry, context)).toBe(
      'https://carelink.minimed.com/configs/v1/oauth20_sso_carepartner_us_v6.json',
    );
  });

  it('throws NoAuth0SSOConfigurationError when neither key is present (legacy v3.4 / v4.0 track)', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      // Auth0SSOConfiguration absent — this is the legacy/no-Auth0 track.
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(
      NoAuth0SSOConfigurationError,
    );
  });

  it('throws when UseSSOConfiguration points at an absent key', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'NonexistentSSOConfiguration',
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(
      NoAuth0SSOConfigurationError,
    );
  });

  it('the thrown error carries .name and .message carrying the diagnostic context', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
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
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(
      NoAuth0SSOConfigurationError,
    );
  });
});
