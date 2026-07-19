import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { loadLoginData, decodeTokenPayload } from './carelink/token.js';
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
  const url = `https://${host}/connect/carepartner/v13/discover/android/3.6`;
  try {
    const { status } = await probe(url);
    if (status === 200) {
      return { name, status: 'ok', detail: `Discovery endpoint reachable (${isUS ? 'US' : 'EU'} region).` };
    }
    return { name, status: 'fail', detail: `Discovery endpoint returned HTTP ${status} (expected 200).` };
  } catch (e) {
    return { name, status: 'fail', detail: `Could not reach ${host}: ${(e as Error).message}` };
  }
}

export async function checkNightscout(probe: Probe, baseUrl: string | undefined, secret: string | undefined): Promise<CheckResult[]> {
  const reachName = 'Nightscout reachable';
  const authName = 'Nightscout API secret';

  if (!baseUrl) {
    return [{ name: reachName, status: 'fail', detail: 'No NS URL configured.' }];
  }
  const base = baseUrl.replace(/\/+$/, '');

  let reachOk = false;
  const results: CheckResult[] = [];
  try {
    const { status } = await probe(`${base}/api/v1/status.json`);
    reachOk = status === 200;
    results.push(
      reachOk
        ? { name: reachName, status: 'ok', detail: `${base} responded 200.` }
        : { name: reachName, status: 'fail', detail: `${base}/api/v1/status.json returned HTTP ${status}.` },
    );
  } catch (e) {
    results.push({ name: reachName, status: 'fail', detail: `Could not reach ${base}: ${(e as Error).message}` });
    return results;
  }

  if (!reachOk || !secret) {
    return results;
  }

  // /api/v1/verifyauth reports whether the api-secret is accepted, without writing.
  try {
    const hashed = crypto.createHash('sha1').update(secret).digest('hex');
    const { status, data } = await probe(`${base}/api/v1/verifyauth`, { 'api-secret': hashed });
    const message = (data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : '').toUpperCase();
    if (status === 200 && message.includes('OK')) {
      results.push({ name: authName, status: 'ok', detail: 'API_SECRET accepted by Nightscout.' });
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

if (isMainModule) {
  const dotenv = await import('dotenv');
  dotenv.config();

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const loginDataPath = path.join(__dirname, '..', 'logindata.json');

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
    process.exit(1);
  }
  console.log(warned > 0 ? `Ready, with ${warned} warning(s) to note.` : 'All checks passed — ready to run "npm start".');
}
