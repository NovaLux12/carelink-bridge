import { describe, it, expect } from 'vitest';
import {
  resolveServerName,
  buildUrls,
  dataHostCandidates,
} from '../src/carelink/urls.js';

/**
 * URL construction. Everything asserted here about the pre-existing shape
 * (me / countrySettings / connectData / monitorData / linkedPatients) is a
 * regression net: the metadata URLs must stay carelink-host-only, because
 * that host is the only one that serves those paths.
 *
 * https://github.com/NovaLux12/carelink-bridge/issues/74 added the plural
 * `connectDataCandidates`, the one URL family served by both hosts.
 */

describe('resolveServerName()', () => {
  it('should map region names to the carelink hosts', () => {
    expect(resolveServerName('EU')).toBe('carelink.minimed.eu');
    expect(resolveServerName('US')).toBe('carelink.minimed.com');
  });

  it('should prefer an explicit server name', () => {
    expect(resolveServerName('EU', 'clcloud.minimed.eu')).toBe('clcloud.minimed.eu');
  });

  it('should default to the EU carelink host', () => {
    expect(resolveServerName(undefined)).toBe('carelink.minimed.eu');
    expect(resolveServerName()).toBe('carelink.minimed.eu');
  });
});

describe('buildUrls()', () => {
  const urls = buildUrls('carelink.minimed.eu', 'gb', 'en');

  it('should build the metadata endpoints against the configured host', () => {
    expect(urls.me).toBe('https://carelink.minimed.eu/patient/users/me');
    expect(urls.countrySettings).toBe(
      'https://carelink.minimed.eu/patient/countries/settings?countryCode=gb&language=en',
    );
    expect(urls.monitorData).toBe('https://carelink.minimed.eu/patient/monitor/data');
    // m2m/links/patients is metadata — carelink host only (403 on clcloud).
    expect(urls.linkedPatients).toBe('https://carelink.minimed.eu/patient/m2m/links/patients');
  });

  it('should keep connectData single-host and identical to the first candidate', () => {
    const timestamp = 1445091119507;
    // connectData is retained as the single-host spelling. It is NOT what the
    // working path calls — the working path uses connectDataCandidates()[0] —
    // so this pins back-compat of the field, not the live code path.
    expect(urls.connectData(timestamp)).toBe(
      'https://carelink.minimed.eu/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=1445091119507',
    );
    expect(urls.connectDataCandidates(timestamp)[0]).toBe(urls.connectData(timestamp));
  });

  it('should offer both data hosts for the EU server', () => {
    expect(dataHostCandidates('carelink.minimed.eu')).toEqual([
      'carelink.minimed.eu',
      'clcloud.minimed.eu',
    ]);
  });

  it('should offer both data hosts for the US server', () => {
    expect(dataHostCandidates('carelink.minimed.com')).toEqual([
      'carelink.minimed.com',
      'clcloud.minimed.com',
    ]);
  });

  it('should normalise case and surrounding whitespace', () => {
    expect(dataHostCandidates('  CareLink.MiniMed.EU ')).toEqual([
      'carelink.minimed.eu',
      'clcloud.minimed.eu',
    ]);
  });

  /**
   * The sibling host is a hardcoded pair, not a guess: an operator pointing
   * MMCONNECT_SERVERNAME at their own reverse proxy (or a future Medtronic
   * region) has no counterpart to fall back to, and inventing one would
   * send data to a host nobody has probed. Single candidate = pre-#74
   * behaviour, byte for byte.
   */
  it('should not invent a sibling host for an unrecognised server name', () => {
    // Only the recognised carelink/clcloud pair gets a sibling; anything else
    // — including a custom MMCONNECT_SERVERNAME — keeps a single candidate so
    // pre-#74 behaviour is preserved byte for byte.
    expect(dataHostCandidates('carelink.example.invalid')).toEqual(['carelink.example.invalid']);
    expect(dataHostCandidates('')).toEqual(['']);
    expect(dataHostCandidates('localhost')).toEqual(['localhost']);
  });

  it('should still offer both hosts when clcloud is the configured host', () => {
    const clcloud = buildUrls('clcloud.minimed.eu', 'gb', 'en');
    expect(clcloud.connectDataCandidates(1)).toEqual([
      'https://clcloud.minimed.eu/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=1',
      'https://carelink.minimed.eu/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=1',
    ]);
    // Metadata still follows the configured host, whichever it is.
    expect(clcloud.me).toBe('https://clcloud.minimed.eu/patient/users/me');
  });

  /**
   * NG9 — resolveServerName must normalise the same way dataHostCandidates
   * does. Before this, `MMCONNECT_SERVERNAME="  CareLink.MiniMed.EU "` produced
   * a connectData URL with literal spaces in the host, while
   * connectDataCandidates() trimmed and lowercased it — so the two halves of
   * the same fetch disagreed, and the "connectData === candidates[0]" invariant
   * the source comment claims was false for exactly this input.
   */
  it('normalises the configured server name the same way the data host does', () => {
    // F2 (R6) — resolveServerName is the operator-facing entry point and must be
    // pinned directly. The assertions below exercise buildUrls(), which is a
    // guard, but reverting resolveServerName alone used to leave 239/239 green.
    expect(resolveServerName(undefined, '  CareLink.MiniMed.EU ')).toBe('carelink.minimed.eu');
    expect(resolveServerName(undefined, 'CARELINK.MINIMED.EU')).toBe('carelink.minimed.eu');
    expect(resolveServerName(undefined, 'carelink.minimed.eu')).toBe('carelink.minimed.eu');
    expect(resolveServerName(undefined, '   ')).toBe('carelink.minimed.eu');
    expect(resolveServerName(undefined, undefined)).toBe('carelink.minimed.eu');
    expect(resolveServerName('eu', undefined)).toBe('carelink.minimed.eu');
    expect(resolveServerName('us', undefined)).toBe('carelink.minimed.com');
    expect(resolveServerName(undefined, 'my.proxy.example')).toBe('my.proxy.example');
    // A port and a path prefix must survive normalisation intact.
    expect(resolveServerName(undefined, ' CareLink.MiniMed.EU:8443 ')).toBe('carelink.minimed.eu:8443');

    const t = 1;
    const messy = ['  CareLink.MiniMed.EU ', 'CareLink.MiniMed.EU', 'CARELINK.MINIMED.EU'];
    for (const serverName of messy) {
      const urls = buildUrls(serverName, 'gb', 'en');
      expect(urls.connectData(t)).toBe(urls.connectDataCandidates(t)[0]);
      expect(urls.me).toBe('https://carelink.minimed.eu/patient/users/me');
      // No literal whitespace may survive into any URL.
      for (const u of [urls.me, urls.monitorData, urls.connectData(t)]) {
        expect(u).not.toMatch(/\s/);
      }
    }
  });
});
