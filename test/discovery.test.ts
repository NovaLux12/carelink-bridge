import { describe, it, expect } from 'vitest';
import {
  CUMULUS_V13_PATH_SUFFIX,
  DISCOVERY_APP_VERSION,
  PINNED_DISCOVERY_CERT_FINGERPRINT,
  VERIFIED_AUTH0_V13_FAMILY,
  VERIFIED_DISCOVERY_CERT_COUNT,
  buildDiscoveryUrl,
  checkDiscoveryCertificates,
  fingerprintCertificates,
} from '../src/discovery.js';

/**
 * Discovery pinning is a load-bearing operational guard (see
 * https://github.com/NovaLux12/carelink-api-research/blob/main/findings-log/medtronic-carelink-2026-07-21/01-endpoint-matrix.md for the
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

// ---------------------------------------------------------------------------
// Issue #75 — the verified Auth0 + cumulus-v13 family
// ---------------------------------------------------------------------------

describe('VERIFIED_AUTH0_V13_FAMILY', () => {
  it('is exactly android/3.6, 3.7, 3.8', () => {
    expect([...VERIFIED_AUTH0_V13_FAMILY]).toEqual(['android/3.6', 'android/3.7', 'android/3.8']);
  });

  it('contains the pinned DISCOVERY_APP_VERSION', () => {
    // A pin outside the verified family would fail the #75 cumulus gate at
    // runtime; catch it here, at edit time, instead.
    expect(VERIFIED_AUTH0_V13_FAMILY).toContain(DISCOVERY_APP_VERSION);
  });

  it('excludes the known-bad versions, each for its own reason', () => {
    // 3.5 — selects Auth0 but sits on cumulus v11 (the original #75 trap).
    expect(VERIFIED_AUTH0_V13_FAMILY).not.toContain('android/3.5');
    // 3.4 / 3.3 / 3.2 — cumulus v11, legacy OAuth, no Auth0 selector.
    expect(VERIFIED_AUTH0_V13_FAMILY).not.toContain('android/3.4');
    // 4.0 / 5.0 / 6.0 / 10.0 — cumulus v2, no Auth0 selector.
    expect(VERIFIED_AUTH0_V13_FAMILY).not.toContain('android/4.0');
  });
});

describe('CUMULUS_V13_PATH_SUFFIX', () => {
  it('is the suffix the live baseUrlCumulus values end with', () => {
    expect(CUMULUS_V13_PATH_SUFFIX).toBe('/connect/carepartner/v13');
    expect('https://clcloud.minimed.eu/connect/carepartner/v13'.endsWith(CUMULUS_V13_PATH_SUFFIX)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #77 — the pinned certificates[] tripwire
// ---------------------------------------------------------------------------

/**
 * Fixture shaped like the real discovery document (live probe 2026-10-09:
 * top-level keys `config`, `supportedCountries`, `CP`, `certificates`). The
 * certificate bytes are synthetic and identical per entry, which mirrors the
 * real thing — live, all 8 entries carry the *same* certificate pinned for
 * 8 different hostnames. Embedding the real 8 x ~1220-char blobs would bloat
 * the suite for no test value; the host set below is the real one.
 */
const PINNED_HOSTS = [
  'carelink.minimed.com',
  'carelink.minimed.eu',
  'clcloud.minimed.com',
  'clcloud.minimed.eu',
  'carelink-trials.minimed.com',
  'clcloud-trials.minimed.com',
  'www.medtronic.com',
  'carelink-content.medtronic.com',
];

const SYNTHETIC_CERT = 'MIIDSyntheticBase64CertForTestsNotARealCertificate';

function makeCertificates(count = VERIFIED_DISCOVERY_CERT_COUNT, cert = SYNTHETIC_CERT): Array<{ host: string; cert: string }> {
  return PINNED_HOSTS.slice(0, count).map(host => ({ host, cert }));
}

/** The `[host, cert]` pair form `fingerprintCertificates` consumes. */
function pairs(certs: Array<{ host: string; cert: string }>): Array<[string, string]> {
  return certs.map(c => [c.host, c.cert]);
}

/** A discovery document shaped like the live android/3.6 EU response. */
function makeDocument(certificates: unknown): { CP: unknown[]; certificates?: unknown; config: string } {
  return {
    CP: [
      {
        region: 'EU',
        UseSSOConfiguration: 'Auth0SSOConfiguration',
        Auth0SSOConfiguration: 'https://carelink.minimed.eu/configs/v1/carepartner_auth0_ous_sso_config_v1.json',
        Layer7SSOConfiguration: 'https://carelink.minimed.eu/configs/v1/oauth20_sso_carepartner_eu_v6.json',
        SSOConfiguration: 'https://carelink.minimed.eu/configs/v1/oauth20_sso_carepartner_eu_v6.json',
        baseUrlCumulus: 'https://clcloud.minimed.eu/connect/carepartner/v13',
      },
    ],
    certificates,
    config: 'android,3.6',
  };
}

describe('fingerprintCertificates', () => {
  it('is a stable 64-char sha256 hex digest', () => {
    const fp = fingerprintCertificates(pairs(makeCertificates()));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintCertificates(pairs(makeCertificates()))).toBe(fp);
  });

  it('is order-insensitive (document order must not cause a false alarm)', () => {
    const entries = pairs(makeCertificates());
    const reversed = [...entries].reverse();
    expect(fingerprintCertificates(reversed)).toBe(fingerprintCertificates(entries));
  });

  it('changes when a host is added or removed', () => {
    expect(fingerprintCertificates(pairs(makeCertificates(7)))).not.toBe(
      fingerprintCertificates(pairs(makeCertificates())),
    );
  });

  it('changes when the certificate bytes change', () => {
    expect(fingerprintCertificates(pairs(makeCertificates(8, 'DifferentCert')))).not.toBe(
      fingerprintCertificates(pairs(makeCertificates())),
    );
  });
});

describe('PINNED_DISCOVERY_CERT_FINGERPRINT', () => {
  it('is the sha256 recorded from the live probe (do not edit without re-probing)', () => {
    expect(PINNED_DISCOVERY_CERT_FINGERPRINT).toBe(
      '3f8b62b3c53942b3722209a8ff6450374caebe77cd33edb28bd2a3a2793dc5f1',
    );
  });
});

describe('checkDiscoveryCertificates — the cheap check (present / non-empty)', () => {
  it('reports present and non-empty for a full pin list, with no warning', () => {
    // Fixture cannot reuse the real pinned bytes, so it pins its own
    // fingerprint: this asserts the mechanism (match => no warning), not the
    // live value (asserted by the constant test above).
    const report = checkDiscoveryCertificates(makeDocument(makeCertificates()), {
      pinnedFingerprint: fingerprintCertificates(pairs(makeCertificates())),
    });
    expect(report.present).toBe(true);
    expect(report.count).toBe(VERIFIED_DISCOVERY_CERT_COUNT);
    expect(report.fingerprintMatches).toBe(true);
    expect(report.warning).toBeUndefined();
    expect(report.hosts).toEqual(PINNED_HOSTS);
  });

  it('treats a missing certificates key as not present, and warns', () => {
    const report = checkDiscoveryCertificates({});
    expect(report.present).toBe(false);
    expect(report.count).toBe(0);
    expect(report.fingerprint).toBeNull();
    expect(report.fingerprintMatches).toBeNull();
    expect(report.warning).toContain('no usable certificates[] pin list');
  });

  it('treats an empty array as not present, and warns', () => {
    const report = checkDiscoveryCertificates(makeDocument([]));
    expect(report.present).toBe(false);
    expect(report.warning).toContain('no usable certificates[] pin list');
  });

  it('treats a non-array certificates value as not present, and warns', () => {
    const report = checkDiscoveryCertificates(makeDocument('not-an-array'));
    expect(report.present).toBe(false);
    expect(report.warning).toContain('no usable certificates[] pin list');
  });

  it('skips malformed entries that carry no host/cert pair', () => {
    const report = checkDiscoveryCertificates(
      { certificates: [{ host: 'clcloud.minimed.eu' }, { cert: SYNTHETIC_CERT }, null, 42, 'x'] },
    );
    expect(report.present).toBe(false);
    expect(report.count).toBe(0);
    expect(report.hosts).toEqual([]);
    expect(report.warning).toContain('no usable certificates[] pin list');
  });

  it('tolerates a null / undefined document', () => {
    expect(checkDiscoveryCertificates(null).present).toBe(false);
    expect(checkDiscoveryCertificates(undefined).present).toBe(false);
    expect(checkDiscoveryCertificates(null).warning).toBeDefined();
  });
});

describe('checkDiscoveryCertificates — the tripwire (warn, never throw)', () => {
  it('warns but does not throw when the certificate bytes are rotated', () => {
    const doc = makeDocument(makeCertificates(8, 'RotatedRootCert'));
    let report: ReturnType<typeof checkDiscoveryCertificates> | undefined;
    expect(() => { report = checkDiscoveryCertificates(doc); }).not.toThrow();
    expect(report).toBeDefined();
    expect(report!.present).toBe(true);
    expect(report!.count).toBe(VERIFIED_DISCOVERY_CERT_COUNT);
    expect(report!.fingerprintMatches).toBe(false);
    expect(report!.warning).toContain('changed since the recorded pin');
    expect(report!.warning).toContain(PINNED_DISCOVERY_CERT_FINGERPRINT);
  });

  it('warns when the pin list changes size', () => {
    const report = checkDiscoveryCertificates(makeDocument(makeCertificates(7)));
    expect(report.present).toBe(true);
    expect(report.count).toBe(7);
    expect(report.expectedCount).toBe(VERIFIED_DISCOVERY_CERT_COUNT);
    expect(report.fingerprintMatches).toBe(false);
    expect(report.warning).toContain('now 7 entries');
  });

  it('watches the host set as well as the cert bytes (live list is one cert for 8 hosts)', () => {
    // Same certificate, but pinned for a different host set — the fingerprint
    // must move, because the host set is the only thing that differs live.
    const rotatedHosts: Array<[string, string]> = [['replacement.example', SYNTHETIC_CERT]];
    expect(fingerprintCertificates(rotatedHosts)).not.toBe(
      fingerprintCertificates([['clcloud.minimed.eu', SYNTHETIC_CERT]]),
    );
  });

  it('warns when counting expectations differ even though the bytes match the pin', () => {
    const entries = pairs(makeCertificates());
    const report = checkDiscoveryCertificates(makeDocument(makeCertificates()), {
      expectedCount: 7,
      pinnedFingerprint: fingerprintCertificates(entries),
    });
    expect(report.fingerprintMatches).toBe(true);
    expect(report.warning).toContain('7 were expected');
  });

  it('skips change detection when pinnedFingerprint is explicitly null', () => {
    const entries = makeCertificates().map(e => [e.host, e.cert] as [string, string]);
    const report = checkDiscoveryCertificates(makeDocument(makeCertificates()), {
      pinnedFingerprint: null,
    });
    expect(report.present).toBe(true);
    expect(report.pinnedFingerprint).toBeNull();
    expect(report.fingerprintMatches).toBeNull();
    expect(report.warning).toContain('no change detection ran');
    // Fingerprint is still computed, so a caller can record it.
    expect(report.fingerprint).toBe(fingerprintCertificates(entries));
  });

  it('accepts the real pinned values as defaults (no option object)', () => {
    const report = checkDiscoveryCertificates(makeDocument(makeCertificates()));
    expect(report.expectedCount).toBe(VERIFIED_DISCOVERY_CERT_COUNT);
    expect(report.pinnedFingerprint).toBe(PINNED_DISCOVERY_CERT_FINGERPRINT);
  });

  /**
   * F1 (R6) — pin the canonical form by ABSOLUTE value.
   *
   * The "order-insensitive" test above only proves input order does not
   * matter, which is invariant under reversing the comparator too: reverse the
   * comparator and you reverse the canonical form, so the digest of the pinned
   * live list silently changes and checkDiscoveryCertificates warns forever on
   * every real document — with a green suite. Only an absolute value links the
   * constant to what the function actually produces.
   */
  it('canonical form is ascending by host then cert (F1)', () => {
    const pairs: Array<[string, string]> = [
      ['b.example', 'CERT_B'],
      ['a.example', 'CERT_A'],
      ['a.example', 'CERT_B'],
    ];
    // Ascending by host, then cert.
    expect(fingerprintCertificates(pairs)).toBe(
      'b61a54a9e298e4df5216693b4404c5f6dcd92adcbad2b0be04a4da012b761f01',
    );
    // Same pairs, reversed input — identical, because the canonical form sorts.
    expect(fingerprintCertificates([...pairs].reverse())).toBe(
      fingerprintCertificates(pairs),
    );
  });
});
