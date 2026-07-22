/**
 * Discovery endpoint pin.
 *
 * The discovery app-version string is load-bearing, not cosmetic. Medtronic's
 * discovery endpoint returns a *different* config per version, and only some
 * versions carry the Auth0 SSO config the login flow needs:
 *   android/3.4 -> cumulus v11, no Auth0 (legacy OAuth)
 *   android/3.6, 3.7 -> cumulus v13, Auth0 (what the current app + this code use)
 *   android/4.0 -> cumulus v2, careLink v1, no Auth0
 * Bumping this to a "newer"-looking number will silently drop onto a config
 * with no Auth0 SSO URL and break login. Keep it at a version verified to
 * return Auth0SSOConfiguration. (Verified against live discovery 2026-07-19.)
 *
 * Source: research/medtronic-carelink-2026-07-21/01-endpoint-matrix.md
 * (table at the top of the file).
 */
export const DISCOVERY_APP_VERSION = 'android/3.6';

/**
 * Build the discovery URL for the chosen region. The host and base path are
 * fixed; only the version string is the load-bearing variable.
 *
 * US -> clcloud.minimed.com (Auth0 tenant: carelink-login.minimed.com)
 * EU -> clcloud.minimed.eu (Auth0 tenant: carelink-login.minimed.eu)
 */
export function buildDiscoveryUrl(isUS: boolean): string {
  const host = isUS ? 'clcloud.minimed.com' : 'clcloud.minimed.eu';
  return `https://${host}/connect/carepartner/v13/discover/${DISCOVERY_APP_VERSION}`;
}
