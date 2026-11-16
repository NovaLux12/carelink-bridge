import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { loadLoginData, decodeTokenPayload } from './carelink/token.js';
import {
  DISCOVERY_APP_VERSION,
  buildDiscoveryUrl,
  CUMULUS_V13_PATH_SUFFIX,
  VERIFIED_AUTH0_V13_FAMILY,
} from './discovery.js';
import { siblingDataFile, isBundledBuild } from './data-paths.js';
import type { LoginData } from './types/carelink.js';

/**
 * `npm run doctor` — a pre-flight check you can run the moment the pump pairs.
 * It validates local config and confirms CareLink and Nightscout are reachable
 * and that the Nightscout secret is right, without polling pump data. One
 * request each to two hosts (CareLink discovery is unauthenticated; Nightscout
 * is your own server), so it's safe to run repeatedly while debugging.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export type Probe = (
  url: string,
  headers?: Record<string, string>,
) => Promise<{ status: number; data: unknown }>;

const REQUIRED_VARS = ['CARELINK_USERNAME', 'CARELINK_PASSWORD', 'API_SECRET', 'NS'] as const;

export function checkConfig(env: NodeJS.ProcessEnv): CheckResult {
  const missing = REQUIRED_VARS.filter(v => !env[v] && !env[v.toLowerCase()]);
  if (missing.length > 0) {
    return {
      name: 'Config (.env)',
      status: 'fail',
      detail: `Missing required setting(s): ${missing.join(', ')}. See .env.example.`,
    };
  }
  return { name: 'Config (.env)', status: 'ok', detail: `All ${REQUIRED_VARS.length} required settings present.` };
}

export function checkLoginData(loginData: LoginData | null, now = Date.now()): CheckResult {
  const name = 'CareLink login (logindata.json)';
  if (!loginData) {
    return { name, status: 'warn', detail: 'Not found or incomplete — run "npm run login" to authenticate.' };
  }

  const payload = decodeTokenPayload(loginData.access_token);
  if (!payload || typeof payload.exp !== 'number') {
    return { name, status: 'warn', detail: 'Token present but its claims could not be decoded — a re-login may be needed.' };
  }

  const details = (payload.token_details ?? {}) as Record<string, unknown>;
  const who = typeof details.preferred_username === 'string' ? details.preferred_username : undefined;
  const country = typeof details.country === 'string' ? details.country : undefined;
  const minsLeft = Math.round((payload.exp * 1000 - now) / 60000);

  const idParts = [who && `user ${who}`, country && `country ${country}`].filter(Boolean).join(', ');
  const idSuffix = idParts ? ` (${idParts})` : '';

  if (minsLeft <= 0) {
    return { name, status: 'warn', detail: `Access token expired ${-minsLeft} min ago${idSuffix} — will refresh on next fetch, or re-login if that fails.` };
  }
  return { name, status: 'ok', detail: `Token valid, ~${minsLeft} min until refresh${idSuffix}.` };
}

/**
 * Fetch the discovery document, returning both the reachability verdict and the
 * body (for the region cross-check).
 *
 * One probe rather than two: the region check needs the same document the
 * reachability check already fetched, and re-requesting it would double the
 * requests this pre-flight makes to Medtronic — which the research repo's
 * probing budget treats as a real cost.
 */
export async function probeDiscovery(
  probe: Probe,
  isUS: boolean,
): Promise<{ result: CheckResult; document: unknown }> {
  const name = 'CareLink reachable';
  const host = isUS ? 'clcloud.minimed.com' : 'clcloud.minimed.eu';
  // Built from the same constant login uses. This used to be a hardcoded
  // `.../discover/android/3.6` literal (issue #145): moving DISCOVERY_APP_VERSION
  // changed what login probed and left doctor checking a URL the bridge no
  // longer used, so doctor could report a green reachability check for a pin
  // that login had already abandoned.
  const url = buildDiscoveryUrl(isUS);
  try {
    const { status, data } = await probe(url);
    if (status === 200) {
      return {
        result: { name, status: 'ok', detail: `Discovery endpoint reachable (${isUS ? 'US' : 'EU'} region, pin ${DISCOVERY_APP_VERSION}).` },
        document: data,
      };
    }
    return {
      result: { name, status: 'fail', detail: `Discovery endpoint returned HTTP ${status} (expected 200) for pin ${DISCOVERY_APP_VERSION}.` },
      document: undefined,
    };
  } catch (e) {
    return {
      result: { name, status: 'fail', detail: `Could not reach ${host}: ${(e as Error).message}` },
      document: undefined,
    };
  }
}

/**
 * Report the cumulus track the discovery document declares for this region.
 *
 * The gate itself lives in `login-errors.ts` (`assertSupportedCumulusTrack`) and
 * only fires during login. Doctor's job is to *say what it saw* before anyone
 * attempts a login, because "login works, then the data call fails with no named
 * error" is the #75 failure mode — an off-track pin that passes every
 * key-presence check.
 *
 * Deliberately reports rather than gates: a non-v13 track is a `fail` here
 * because the bridge cannot use it, but the message names the observed URL so
 * the fix is obvious. An entry with no `baseUrlCumulus` at all is also a `fail`
 * for the same reason — the data plane is unknown, and guessing it is what
 * issue #75 exists to prevent.
 */
export function checkCumulusTrack(document: unknown, region: string): CheckResult {
  const name = 'CareLink cumulus track';
  const cp = (document as { CP?: unknown } | null)?.CP;
  if (!Array.isArray(cp)) {
    return { name, status: 'warn', detail: 'Discovery document carried no readable CP[] entries, so the track could not be read.' };
  }

  const entry = cp.find(
    (e): e is { region?: unknown; baseUrlCumulus?: unknown } =>
      !!e && typeof e === 'object' && String((e as { region?: unknown }).region).toUpperCase() === region.toUpperCase(),
  );
  if (!entry) {
    return { name, status: 'warn', detail: `Discovery document has no CP entry for region ${region}, so the track could not be read.` };
  }

  const cumulus = entry.baseUrlCumulus;
  if (typeof cumulus !== 'string') {
    return {
      name,
      status: 'fail',
      detail: `Region ${region} declares no baseUrlCumulus, so the data plane is unknown. ` +
        `This bridge requires "${CUMULUS_V13_PATH_SUFFIX}" (issue #75).`,
    };
  }

  if (cumulus.endsWith(CUMULUS_V13_PATH_SUFFIX)) {
    return { name, status: 'ok', detail: `Region ${region} declares ${cumulus} — the v13 track this bridge requires.` };
  }

  return {
    name,
    status: 'fail',
    detail: `Region ${region} declares ${cumulus}, which is NOT the "${CUMULUS_V13_PATH_SUFFIX}" track this bridge requires. ` +
      `Login would succeed and the data call would then fail with no named error — the #75 failure. ` +
      `Keep DISCOVERY_APP_VERSION on ${VERIFIED_AUTH0_V13_FAMILY.join(', ')}.`,
  };
}

/**
 * Flatten the discovery document's `supportedCountries` into `CODE -> region`.
 *
 * The live shape is a LIST of single-key objects:
 *   `[{ "US": { region: "US", isoCode, iso3Code, flag } }, { "IT": { region: "EU", … } }, …]`
 * 109 entries, regions `US` / `EU` / `CLINICAL`. Returns an empty map on any
 * other shape rather than throwing — a changed document shape is worth a
 * warning, not a crashed pre-flight.
 */
export function countryRegions(document: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = (document as { supportedCountries?: unknown } | null)?.supportedCountries;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [code, value] of Object.entries(entry as Record<string, unknown>)) {
      const region = (value as { region?: unknown } | null)?.region;
      if (typeof region === 'string') out.set(code.toUpperCase(), region);
    }
  }
  return out;
}

/**
 * Does the configured region agree with the country the account is in?
 *
 * This is the honest half of "is my region wrong?" that issue #145 asks for. It
 * does NOT read the account (that needs a token — `/patient/users/me` is 401
 * unauthenticated), so it cannot answer for a specific account. What it CAN do
 * without a token is catch the configuration that is wrong for *any* account in
 * the operator's country: `supportedCountries` maps every country to the region
 * that serves it, and nothing in the bridge currently checks that against
 * `MMCONNECT_SERVER`.
 *
 * `MMCONNECT_COUNTRYCODE` is optional and defaults to `gb` in the client, so the
 * check is a warn — silence here would be wrong (a US account pointed at the EU
 * host gets 401s that read like invalid credentials), but failing hard would
 * break the common case where the operator simply never set the country and the
 * default happens to be right.
 */
export function checkRegion(document: unknown, env: NodeJS.ProcessEnv): CheckResult {
  const name = 'CareLink region';
  const configuredIsUS = (env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
  const configuredRegion = configuredIsUS ? 'US' : 'EU';

  // `MMCONNECT_SERVERNAME` overrides the host entirely, which makes the
  // EU/US question moot — the operator has named a host directly.
  if (env['MMCONNECT_SERVERNAME']?.trim()) {
    return {
      name,
      status: 'ok',
      detail: `Host set explicitly via MMCONNECT_SERVERNAME (${env['MMCONNECT_SERVERNAME'].trim()}); the EU/US switch does not apply.`,
    };
  }

  const code = (env['MMCONNECT_COUNTRYCODE'] || 'gb').trim().toUpperCase();
  const regions = countryRegions(document);
  if (regions.size === 0) {
    return {
      name,
      status: 'warn',
      detail: 'Discovery document carried no readable supportedCountries, so the region could not be cross-checked.',
    };
  }

  const expected = regions.get(code);
  if (!expected) {
    return {
      name,
      status: 'warn',
      detail: `Country "${code}" is not in the discovery document's 109 supportedCountries — region not cross-checked.`,
    };
  }

  if (expected === configuredRegion) {
    return { name, status: 'ok', detail: `${code} is served by the ${expected} region, matching MMCONNECT_SERVER.` };
  }
  return {
    name,
    status: 'fail',
    detail: `${code} is served by the ${expected} region but MMCONNECT_SERVER selects ${configuredRegion}. ` +
      `Set MMCONNECT_SERVER=${expected === 'US' ? 'US' : 'EU'} (or unset it for the EU default), or set ` +
      `MMCONNECT_COUNTRYCODE if you are not in ${code}.`,
  };
}

/**
 * Read the `message` field of a `/api/v1/verifyauth` body, upper-cased.
 *
 * Nightscout answers `{status:200, message:{canRead,canWrite,isAdmin,message:"OK",…}}`
 * on current versions — a NESTED object — but older versions answered
 * `{status:200, message:"OK"}`. Both shapes are live, so this flattens either.
 * Getting this wrong is how a working secret gets reported as rejected: the
 * old `String(message)` on the nested object yields "[object Object]", which
 * contains no "OK".
 */
function verifyAuthMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const outer = data as { message?: unknown };
  const inner =
    outer.message && typeof outer.message === 'object'
      ? (outer.message as { message?: unknown }).message
      : outer.message;
  return typeof inner === 'string' ? inner.toUpperCase() : '';
}

export async function checkNightscout(probe: Probe, baseUrl: string | undefined, secret: string | undefined): Promise<CheckResult[]> {
  const reachName = 'Nightscout reachable';
  const authName = 'Nightscout API secret';

  if (!baseUrl) {
    return [{ name: reachName, status: 'fail', detail: 'No NS URL configured.' }];
  }
  const base = baseUrl.replace(/\/+$/, '');
  const hashed = secret ? crypto.createHash('sha1').update(secret).digest('hex') : undefined;

  // ⚠ `/api/v1/status.json` is NOT public on a default-install Nightscout.
  // With `AUTH_DEFAULT_ROLES` at its standard `denied`, an unauthenticated
  // status.json returns **401** — measured against Nightscout 15.0.9,
  // 2026-11-15. Probing it without the secret therefore reports a perfectly
  // healthy, correctly-secured server as "unreachable", and — because the old
  // code returned early on `!reachOk` — it never went on to check the secret
  // that would have proved the server was fine. A false ✗ on the single check
  // most likely to be read before a first start.
  //
  // So the reachability probe carries the secret when one is configured. A 401
  // WITH a secret present is no longer a reachability failure — the host
  // answered, which is what reachability means — it is an auth failure, and
  // verifyauth below is what names it.
  let reachStatus: number | undefined;
  const results: CheckResult[] = [];
  try {
    const { status } = await probe(
      `${base}/api/v1/status.json`,
      hashed ? { 'api-secret': hashed } : undefined,
    );
    reachStatus = status;
  } catch (e) {
    results.push({ name: reachName, status: 'fail', detail: `Could not reach ${base}: ${(e as Error).message}` });
    return results;
  }

  if (reachStatus === 200) {
    results.push({ name: reachName, status: 'ok', detail: `${base} responded 200.` });
  } else if ((reachStatus === 401 || reachStatus === 403) && hashed) {
    // The server answered and refused us: reachable, and the reason is auth.
    // Report reachability as OK and let the secret check carry the failure, so
    // one root cause produces one ✗ rather than two.
    results.push({
      name: reachName,
      status: 'ok',
      detail: `${base} answered HTTP ${reachStatus} — reachable, but it rejected the API secret (see the next check).`,
    });
  } else {
    results.push({
      name: reachName,
      status: 'fail',
      detail: `${base}/api/v1/status.json returned HTTP ${reachStatus}.`,
    });
    return results;
  }

  if (!secret) {
    return results;
  }

  // /api/v1/verifyauth reports whether the api-secret is accepted, without writing.
  try {
    const { status, data } = await probe(`${base}/api/v1/verifyauth`, { 'api-secret': hashed! });
    const message = verifyAuthMessage(data);
    if (status === 200 && message.includes('OK')) {
      results.push({ name: authName, status: 'ok', detail: 'API_SECRET accepted by Nightscout.' });
    } else if (status === 401 || status === 403) {
      results.push({ name: authName, status: 'fail', detail: `API_SECRET rejected (HTTP ${status}). Check it matches your Nightscout site.` });
    } else {
      results.push({ name: authName, status: 'fail', detail: `API_SECRET rejected (verifyauth said "${message || 'HTTP ' + status}"). Check it matches your Nightscout site.` });
    }
  } catch (e) {
    results.push({ name: authName, status: 'warn', detail: `Could not verify API_SECRET: ${(e as Error).message}` });
  }
  return results;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  loginDataPath: string;
  probe: Probe;
}

export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const { env, loginDataPath, probe } = deps;
  const isUS = (env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
  const nsUrl = env['NS'] || (env['WEBSITE_HOSTNAME'] ? 'https://' + env['WEBSITE_HOSTNAME'] : undefined);
  const secret = env['API_SECRET'] || env['api_secret'];

  // One discovery fetch feeds both the reachability row and the region row.
  const discovery = await probeDiscovery(probe, isUS);

  const results: CheckResult[] = [
    checkConfig(env),
    checkLoginData(loadLoginData(loginDataPath)),
    discovery.result,
    // Only meaningful when the document actually arrived; a failed reachability
    // check already says why, and a second ✗ for the same cause is noise.
    ...(discovery.document !== undefined
      ? [checkRegion(discovery.document, env), checkCumulusTrack(discovery.document, isUS ? 'US' : 'EU')]
      : []),
    ...(await checkNightscout(probe, nsUrl, secret)),
  ];
  return results;
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

export function formatResults(results: CheckResult[]): string {
  const width = Math.max(...results.map(r => r.name.length));
  return results
    .map(r => `  ${SYMBOL[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
/**
 * Should this module self-execute its CLI?
 *
 * ⚠ FALSE IN THE BUNDLE, always. A bundle is one file, so `import.meta.url`
 * equals `process.argv[1]` and this comparison is true for EVERY bundled CLI
 * module at once — which is why the bundle has an explicit dispatcher
 * (`src/bundle-main.ts`). Without the `!isBundledBuild()` term the guard fires
 * inside the bundle too, and doctor runs twice: once via the dispatcher, once
 * via this block. The only visible symptom was a doubled "injected env" line,
 * but the second run re-fetches discovery and re-runs every check.
 */
const isMainModule = !isBundledBuild() && process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
   path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url).replace(/\.ts$/, '.js')));

/**
 * Run the doctor CLI and return its exit code.
 *
 * Extracted from the `isMainModule` block so the single-file bundle can call it
 * too. `isMainModule` cannot work in a bundle: the bundle's `import.meta.url`
 * IS `process.argv[1]`, so every bundled CLI module would see `isMainModule`
 * true at once. That made `npm run bundle` produce an artefact with no doctor
 * in it at all — the same gap #146 fixed for Docker, reintroduced in a new
 * distribution path.
 *
 * Returns the exit code rather than calling `process.exit`, so the caller
 * decides (a subcommand dispatcher should not be killed by its own callee).
 */
export async function doctorCli(): Promise<number> {
  const loginDataPath = siblingDataFile(import.meta.url, 'logindata.json');

  const probe: Probe = async (url, headers) => {
    const resp = await axios.get(url, { headers, timeout: 15_000, validateStatus: () => true });
    return { status: resp.status, data: resp.data };
  };

  console.log('\ncarelink-bridge doctor\n');
  const results = await runDoctor({ env: process.env, loginDataPath, probe });
  console.log(formatResults(results));

  const failed = results.filter(r => r.status === 'fail').length;
  const warned = results.filter(r => r.status === 'warn').length;
  console.log('');
  if (failed > 0) {
    console.log(`${failed} check(s) failed. Fix the above before running "npm start".`);
    return 1;
  }
  console.log(warned > 0 ? `Ready, with ${warned} warning(s) to note.` : 'All checks passed — ready to run "npm start".');
  return 0;
}

if (isMainModule) {
  const dotenv = await import('dotenv');
  dotenv.config();
  process.exit(await doctorCli());
}
