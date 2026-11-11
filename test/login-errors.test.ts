import { describe, it, expect } from 'vitest';
import {
  NoAuth0SSOConfigurationError,
  UnexpectedUserInfoError,
  assertUserInfoShape,
  selectAuth0ConfigUrl,
  type DiscoveryCpEntry,
} from '../src/login-errors.js';

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

  /**
   * Area AO (2026-11-11) — the `?? 'Auth0SSOConfiguration'` right operand is
   * dead on every recorded cell: across 67 `CP[]` entries on three hosts, the
   * selector and the Auth0 key appear together or not at all, and where both
   * are present the selector holds the literal `Auth0SSOConfiguration`.
   *
   * The decision recorded here is **(a) defensive, keep it, with the limit
   * stated** — not (b) masking a misconfiguration. The test below proves the
   * reason it cannot be masking one: an off-track entry with no selector is
   * rejected by the TRACK gate, before the fallback is ever consulted. So the
   * fallback can only ever act on an entry that is already on cumulus v13.
   */
  it('the ?? default cannot mask a misconfiguration: the track gate runs first (AO §4)', () => {
    // The exact android/3.9/4.x shape: no selector, no Auth0 key, cumulus v2.
    const offTrack: DiscoveryCpEntry = {
      SSOConfiguration: 'https://carelink.minimed.com/configs/v1/sso_cp_us_v6.json',
      baseUrlCumulus: V2,
    };
    try {
      selectAuth0ConfigUrl(offTrack, context);
      expect.unreachable('expected a throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      // It threw — but from the TRACK gate, whose message names the cumulus
      // value, not from the URL-resolution path. That ordering is what makes
      // the fallback unreachable-but-harmless rather than a rescue hatch.
      expect(err.message).toContain(V2);
      expect(err.message).not.toContain('Discovery returned no Auth0 SSO config URL');
    }
  });

  it('the ?? default resolves the Auth0 key on a v13 entry with no selector (unproven shape, handled safely)', () => {
    // This shape has NEVER been observed (AO measured 0 of 67 entries like it),
    // so this is not a claim of vendor support — it pins the defensive
    // behaviour we deliberately keep: on a v13 entry that omits the selector,
    // the documented key name is still read rather than throwing over a field
    // the entry may simply have stopped publishing.
    const entry: DiscoveryCpEntry = {
      Auth0SSOConfiguration: 'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
      baseUrlCumulus: V13,
    };
    expect(selectAuth0ConfigUrl(entry, context)).toBe(
      'https://carelink.minimed.com/configs/v1/carepartner_auth0_us_sso_config_v1.json',
    );
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

// ---------------------------------------------------------------------------
// Area AO — the failure must be LEGIBLE: three unresolved shapes, three names
// ---------------------------------------------------------------------------
//
// Before this, all three arrived as the same free-form "no Auth0 SSO config URL
// resolved" string, so an operator looking at a 3.9 cell (no key at all) was
// sent hunting a selector field the document had never carried. The shape now
// says which of the three it is, and the error stays the NAMED class throughout:
// a vague error on a real, measured failure mode is the bug this covers.
describe('selectAuth0ConfigUrl — unresolved-shape legibility (area AO)', () => {
  const context = { region: 'us', appVersion: 'android/3.6' };

  it('names "no selector and no key" for the 3.9/3.10 shape and throws the NAMED error', () => {
    // VERIFIED shape of android/3.9 and 3.10 (AO §3): CP entries carry
    // SSOConfiguration + baseUrl*, never Auth0SSOConfiguration or
    // UseSSOConfiguration. Held on v13 here so the LEGIBILITY of the URL
    // failure is what is under test, not the track gate.
    const entry: DiscoveryCpEntry = {
      SSOConfiguration: 'https://carelink.minimed.com/configs/v1/sso_cp_us_v6.json',
      baseUrlCumulus: V13,
    };
    expect(() => selectAuth0ConfigUrl(entry, context)).toThrow(NoAuth0SSOConfigurationError);
    try {
      selectAuth0ConfigUrl(entry, context);
      expect.unreachable('expected a throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      expect(err.name).toBe('NoAuth0SSOConfigurationError');
      expect(err.message).toContain('no UseSSOConfiguration selector');
      // Names the version band the operator is on, and does not misdescribe
      // the failure as a bad selector value.
      expect(err.message).toContain('android/3.9, 3.10 and every 4.x tail');
      expect(err.message).toContain('android/3.6, android/3.7, android/3.8');
    }
  });

  it('names a dangling selector when UseSSOConfiguration points at an absent key', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'NonexistentSSOConfiguration',
      baseUrlCumulus: V13,
    };
    try {
      selectAuth0ConfigUrl(entry, context);
      expect.unreachable('expected a throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      expect(err.name).toBe('NoAuth0SSOConfigurationError');
      expect(err.message).toContain('names a key this entry does not carry');
      expect(err.message).toContain('NonexistentSSOConfiguration');
    }
  });

  it('distinguishes an empty-string value from an absent key', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      Auth0SSOConfiguration: '',
      baseUrlCumulus: V13,
    };
    try {
      selectAuth0ConfigUrl(entry, context);
      expect.unreachable('expected a throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      expect(err.message).toContain('whose value is an empty string');
    }
  });

  it('distinguishes a non-string value from an absent key', () => {
    const entry: DiscoveryCpEntry = {
      UseSSOConfiguration: 'Auth0SSOConfiguration',
      // A numeric or object value where a URL string belongs.
      Auth0SSOConfiguration: 42 as unknown as string,
      baseUrlCumulus: V13,
    };
    try {
      selectAuth0ConfigUrl(entry, context);
      expect.unreachable('expected a throw');
    } catch (e) {
      const err = e as NoAuth0SSOConfigurationError;
      expect(err.message).toContain('not a string (got number)');
    }
  });
});

// ---------------------------------------------------------------------------
// Area AO — /patient/users/me shape guard (identity namespace legibility)
// ---------------------------------------------------------------------------
describe('assertUserInfoShape — the /patient/users/me failure mode', () => {
  const ctx = { url: 'https://carelink.minimed.eu/patient/users/me', region: 'carelink.minimed.eu' };

  it('passes a normal user record through untouched, including username and role', () => {
    const user = { username: 'jlee', role: 'PATIENT', id: 'abc' };
    expect(assertUserInfoShape(user, ctx)).toBe(user);
  });

  it('accepts a record that has a role but no username (field leniency is deliberate)', () => {
    // A missing username falls back to CARELINK_USERNAME (test/username-source
    // .test.ts) and a missing role is tolerated by the legacy routing. Tightening
    // these into throws would turn a tolerated difference into an outage.
    expect(() => assertUserInfoShape({ role: 'PATIENT' }, ctx)).not.toThrow();
    expect(() => assertUserInfoShape({}, ctx)).not.toThrow();
  });

  it('accepts a record that carries an unrelated error field alongside its role', () => {
    // The envelope test must not widen into "any object with an `error` key".
    expect(() => assertUserInfoShape({ role: 'PATIENT', error: 'stale-field' }, ctx)).not.toThrow();
  });

  it('throws for a 200 carrying the vendor error envelope (no role)', () => {
    // VERIFIED wire shape of the vendor's own rejection: `{"error":{"type":"…"}}`.
    // Arriving with a 200 this is a failure wearing a success status, and the
    // status line cannot tell you.
    expect(() => assertUserInfoShape({ error: { type: 'InvalidToken' } }, ctx)).toThrow(
      UnexpectedUserInfoError,
    );
    expect(() => assertUserInfoShape({ error: { type: 'InvalidToken' } }, ctx)).toThrow(
      /error\.type="InvalidToken"/,
    );
  });

  it.each([
    ['an HTML body', '<html>gateway</html>', /a string/],
    ['an array', [{ username: 'u' }], /an array of 1 element/],
    ['null', null, /with null/],
    ['a bare number', 42, /a number/],
    ['a boolean', true, /a boolean/],
  ])('throws UnexpectedUserInfoError for %s', (_label, body, pattern) => {
    expect(() => assertUserInfoShape(body, ctx)).toThrow(UnexpectedUserInfoError);
    expect(() => assertUserInfoShape(body, ctx)).toThrow(pattern);
  });

  it('the error is NAMED and greppable, and names the endpoint it read', () => {
    try {
      assertUserInfoShape('<html>', ctx);
      expect.unreachable('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnexpectedUserInfoError);
      const err = e as UnexpectedUserInfoError;
      expect(err.name).toBe('UnexpectedUserInfoError');
      expect(err.message).toContain('https://carelink.minimed.eu/patient/users/me');
      expect(err.message).toContain('carepartner/v2');
      // Must not be conflated with the discovery-pin marker.
      expect(err.name).not.toBe('NoAuth0SSOConfigurationError');
    }
  });

  it('never echoes body content into the message (the body may carry the username)', () => {
    try {
      assertUserInfoShape(['secret-user@example.com'], ctx);
      expect.unreachable('expected a throw');
    } catch (e) {
      const err = e as UnexpectedUserInfoError;
      expect(err.message).not.toContain('secret-user@example.com');
    }
  });
});
