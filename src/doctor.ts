import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { loadLoginData, decodeTokenPayload } from './carelink/token.js';
import { DISCOVERY_APP_VERSION, buildDiscoveryUrl } from './discovery.js';
import { siblingDataFile } from './data-paths.js';
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

export async function checkCareLink(probe: Probe, isUS: boolean): Promise<CheckResult> {
  const name = 'CareLink reachable';
  const host = isUS ? 'clcloud.minimed.com' : 'clcloud.minimed.eu';
  // Built from the same constant login uses. This used to be a hardcoded
  // `.../discover/android/3.6` literal (issue #145): moving DISCOVERY_APP_VERSION
  // changed what login probed and left doctor checking a URL the bridge no
  // longer used, so doctor could report a green reachability check for a pin
  // that login had already abandoned.
  const url = buildDiscoveryUrl(isUS);
  try {
    const { status } = await probe(url);
    if (status === 200) {
      return { name, status: 'ok', detail: `Discovery endpoint reachable (${isUS ? 'US' : 'EU'} region, pin ${DISCOVERY_APP_VERSION}).` };
    }
    return { name, status: 'fail', detail: `Discovery endpoint returned HTTP ${status} (expected 200) for pin ${DISCOVERY_APP_VERSION}.` };
  } catch (e) {
    return { name, status: 'fail', detail: `Could not reach ${host}: ${(e as Error).message}` };
  }
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

  const results: CheckResult[] = [
    checkConfig(env),
    checkLoginData(loadLoginData(loginDataPath)),
    await checkCareLink(probe, isUS),
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
const isMainModule = process.argv[1] &&
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
