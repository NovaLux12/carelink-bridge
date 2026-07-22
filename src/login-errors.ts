/**
 * Named error class for the "discovery returned no Auth0 SSO URL" path.
 *
 * Distinguishes the Auth0 cut-over / discovery-version-pin failure from a
 * plain network error so on-call can grep journald for the named marker
 * rather than parsing a free-form message string. The accompanying message
 * carries the actionable guidance ("point DISCOVERY_APP_VERSION at a config
 * known to return Auth0SSOConfiguration").
 *
 * Source: research/medtronic-carelink-2026-07-21/README.md line 26 and
 * 04-operational-history.md 2026-01-02 (legacy `mdtlogin-ocl.medtronic.com`
 * RST, all four community clients lost connectivity on the same day).
 */

export class NoAuth0SSOConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAuth0SSOConfigurationError';
    Object.setPrototypeOf(this, NoAuth0SSOConfigurationError.prototype);
  }
}

/**
 * Shape of a single CP entry from the discovery JSON, restricted to the
 * fields this helper reads. Defined locally so this module doesn't depend
 * on src/types/carelink.js (which keeps the policy module importable in
 * isolation for tests).
 */
export interface DiscoveryCpEntry {
  UseSSOConfiguration?: string;
  Auth0SSOConfiguration?: string;
  Layer7SSOConfiguration?: string;
  [key: string]: unknown;
}

/**
 * Returns the SSO config URL declared by the discovery entry, or throws
 * `NoAuth0SSOConfigurationError` when neither the explicit selector nor
 * the default key resolves to a non-empty string. The helper owns the
 * throw so the production call site in login.ts is a single line and the
 * behavioural contract (instanceof + name) is provable directly.
 *
 * `context` carries the values the operator needs to diagnose the failure
 * (region, UseSSOConfiguration value, pinned app version). The defaults
 * match the discovery-response shape documented in
 * 01-endpoint-matrix.md.
 */
export function selectAuth0ConfigUrl(
  cpEntry: DiscoveryCpEntry,
  context: { region: string; appVersion: string } = { region: 'unknown', appVersion: 'unknown' },
): string {
  const explicitKey = cpEntry.UseSSOConfiguration;
  const key = explicitKey ?? 'Auth0SSOConfiguration';
  const candidate = cpEntry[key];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  throw new NoAuth0SSOConfigurationError(
    `Discovery returned no Auth0 SSO config URL for region "${context.region}" ` +
    `(UseSSOConfiguration=${explicitKey ?? 'absent'}). This usually means ` +
    `DISCOVERY_APP_VERSION ("${context.appVersion}") points at a config track without Auth0 — ` +
    `keep it on a version known to return Auth0SSOConfiguration.`,
  );
}
