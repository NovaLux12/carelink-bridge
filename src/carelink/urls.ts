const DEFAULT_SERVER_EU = 'carelink.minimed.eu';
const DEFAULT_SERVER_US = 'carelink.minimed.com';

/**
 * Urls built from a single configured host.
 *
 * Metadata URLs (me / monitorData / countrySettings / linkedPatients) are
 * carelink-host-only and stay single-host. `connectDataCandidates` is
 * plural because the legacy data endpoint is served by both frontends —
 * see the host-split note on dataHostCandidates() before "simplifying"
 * either of these back.
 */
export interface CareLinkUrls {
  me: string;
  countrySettings: string;
  connectData: (timestamp: number) => string;
  /**
   * Every host that serves the legacy data endpoint, configured host first.
   * Added for issue #74 — the `connectData` field above still returns only
   * the configured host, kept as the single-host spelling, pinned equal to connectDataCandidates()[0] by test/urls.test.ts.
   */
  connectDataCandidates: (timestamp: number) => string[];
  monitorData: string;
  linkedPatients: string;
}

export function resolveServerName(
  server?: string,
  serverName?: string,
): string {
  // Trim and lowercase an operator-supplied hostname. Two reasons, both found
  // by review: MMCONNECT_SERVERNAME is operator-entered, and an untrimmed value
  // used to produce a URL with literal spaces in the host
  // ("https://  CareLink.MiniMed.EU /patient/…"). Left unnormalised here it also
  // diverged from dataHostCandidates(), which trims and lowercases — so the
  // metadata half of a fetch addressed the host by a different spelling than
  // the data half, and the documented "connectData === connectDataCandidates()[0]"
  // invariant failed for exactly the input the docs name. DNS is case-insensitive
  // and sibling detection matches lowercase, so this only ever fixes input.
  const normaliseHost = (h: string) => h.trim().toLowerCase();
  if (serverName && serverName.trim()) return normaliseHost(serverName);
  if (server?.trim().toUpperCase() === 'EU') return DEFAULT_SERVER_EU;
  if (server?.trim().toUpperCase() === 'US') return DEFAULT_SERVER_US;
  const trimmed = (server ?? '').trim();
  return trimmed ? normaliseHost(trimmed) : DEFAULT_SERVER_EU;
}

/**
 * CareLink runs two frontends on the same minimed domain pair:
 *
 *   carelink.minimed.eu  /  carelink.minimed.com   (the "carelink" host)
 *   clcloud.minimed.eu   /  clcloud.minimed.com    (the "cloud" host)
 *
 * Which host answers which path was probed unauthenticated on 2026-10-08
 * (issue #74) — 401 means "path exists, no token", 403 means "host does not
 * serve this path at all":
 *
 *   path                                        carelink.*   clcloud.*
 *   /patient/users/me                                401         403
 *   /patient/monitor/data                           401         403
 *   /patient/countries/settings                     200         403
 *   /patient/m2m/links/patients                     401         403
 *   /patient/connect/data?msgType=last24hours       401         401
 *   /patient/m2m/connect/data/gc/patients/{u}       401         401
 *
 * So the **metadata** endpoints (users/me, monitor/data,
 * countries/settings, m2m/links/patients) exist ONLY on the carelink host,
 * while the **data** endpoints (connect/data,
 * m2m/connect/data/gc/patients/*) are served by BOTH. The bridge is
 * therefore correct to keep building metadata URLs against the carelink
 * host, and must try BOTH hosts for data URLs.
 *
 * If the `m2m/connect/data/gc/patients/*` path is ever added to this bridge
 * (it is not fetched here today — only its metadata sibling
 * `m2m/links/patients` is), it belongs in the DATA family and must go
 * through dataHostCandidates() too, not through buildUrls()' single host.
 *
 * INFERRED, NOT VERIFIED: the claim that the carelink host *stops serving
 * working data* for non-US accounts comes from the community reference
 * client (xDrip+ CareLinkFollow, which moved `patient/connect/data` and
 * `patient/m2m/connect/data/gc/patients/*` to its `cloudServer()`
 * unconditionally, on the grounds that "the old cloud data endpoint no
 * longer works outside the US"). Both hosts return 401 unauthenticated, so
 * which one returns real data for an EU account is UNVERIFIED — nobody with
 * EU credentials has confirmed it. That is exactly why this is a fallback
 * and not a switch: we try the configured host first and only spend a
 * request on the sibling when the first host fails or comes back empty.
 */
function siblingDataHost(serverName: string | undefined): string | undefined {
  const match = /^(carelink|clcloud)\.(minimed\.(?:eu|com))$/.exec(
    (serverName ?? '').trim().toLowerCase(),
  );
  if (!match) return undefined;
  return `${match[1] === 'carelink' ? 'clcloud' : 'carelink'}.${match[2]}`;
}

/**
 * Hosts that serve the CareLink data endpoints, configured host first, then
 * its sibling — so the legacy fallback can try both (issue #74).
 *
 * `serverName` is a bare hostname, the same precondition buildUrls() already
 * assumes (see resolveServerName()). An unrecognised host (an operator
 * pointing MMCONNECT_SERVERNAME at their own reverse proxy, say) yields no
 * sibling and the list is just the configured host — which preserves the
 * pre-#74 behaviour exactly.
 */
export function dataHostCandidates(serverName: string): string[] {
  const configured = (serverName ?? '').trim().toLowerCase();
  const sibling = siblingDataHost(configured);
  if (!sibling || sibling === configured) return [configured];
  return [configured, sibling];
}

function connectDataUrl(serverName: string, timestamp: number): string {
  return `https://${serverName}/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=${timestamp}`;
}

export function buildUrls(
  serverName: string,
  countryCode: string,
  lang: string,
): CareLinkUrls {
  // Normalise here too, not only in resolveServerName(). `connectData` and
  // `connectDataCandidates()` are built from the same argument within this one
  // function, so if the argument can be untrusted they can disagree — which is
  // exactly what happened (NG9): an operator-supplied MMCONNECT_SERVERNAME with
  // surrounding whitespace produced a connectData URL with literal spaces in
  // the host while connectDataCandidates()[0] trimmed and lowercased it.
  const host = serverName.trim().toLowerCase();
  return {
    me: `https://${host}/patient/users/me`,
    countrySettings: `https://${host}/patient/countries/settings?countryCode=${countryCode}&language=${lang}`,
    connectData: (timestamp: number) => connectDataUrl(host, timestamp),
    connectDataCandidates: (timestamp: number) =>
      dataHostCandidates(serverName).map((host) => connectDataUrl(host, timestamp)),
    monitorData: `https://${host}/patient/monitor/data`,
    linkedPatients: `https://${host}/patient/m2m/links/patients`,
  };
}
