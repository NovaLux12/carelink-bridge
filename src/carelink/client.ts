import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import * as logger from '../logger.js';
import { loadLoginData, writeLoginDataAtomic, isTokenExpired, refreshToken, decodeTokenPayload } from './token.js';
import { CircuitBreaker, DEFAULT_CIRCUIT_THRESHOLD, DEFAULT_CIRCUIT_COOLDOWN_MS } from '../circuit-breaker.js';
import { isPermanentRefreshFailure } from '../refresh-failure.js';
import { decideRetry } from '../retry-policy.js';
import { resolveServerName, buildUrls, type CareLinkUrls } from './urls.js';
import type { CareLinkData, CareLinkUserInfo, CareLinkPatientLink, CareLinkCountrySettings } from '../types/carelink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REQUESTS_PER_FETCH = 30;

export interface CareLinkClientOptions {
  username: string;
  password: string;
  server?: string;
  serverName?: string;
  countryCode?: string;
  lang?: string;
  patientId?: string;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
}

export class CareLinkClient {
  private axiosInstance: AxiosInstance;
  private urls: CareLinkUrls;
  private loginDataPath: string;
  private serverName: string;
  private options: CareLinkClientOptions;
  private requestCount = 0;
  private circuitBreaker: CircuitBreaker;
  private lastRefreshAt: number | null = null;
  private nextScheduledRefresh: number | null = null;

  constructor(options: CareLinkClientOptions) {
    this.options = options;

    const countryCode = options.countryCode || process.env['MMCONNECT_COUNTRYCODE'] || 'gb';
    const lang = options.lang || process.env['MMCONNECT_LANGCODE'] || 'en';

    this.serverName = resolveServerName(
      options.server || process.env['MMCONNECT_SERVER'],
      options.serverName || process.env['MMCONNECT_SERVERNAME'],
    );
    this.urls = buildUrls(this.serverName, countryCode, lang);
    this.loginDataPath = path.join(__dirname, '..', '..', 'logindata.json');
    this.circuitBreaker = new CircuitBreaker(
      options.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD,
      options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS,
    );

    // Set up axios
    this.axiosInstance = axios.create({
      maxRedirects: 0,
      timeout: 15_000,
    });

    // Response interceptor: treat 2xx/3xx as success
    this.axiosInstance.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status >= 200 && error.response?.status < 400) {
          return error.response;
        }
        return Promise.reject(error);
      },
    );

    // Request interceptor: count requests and set headers
    this.axiosInstance.interceptors.request.use(config => {
      this.requestCount++;
      if (this.requestCount > MAX_REQUESTS_PER_FETCH) {
        throw new Error('Request count exceeds the maximum in one fetch!');
      }

      config.headers['User-Agent'] = USER_AGENT;
      config.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
      config.headers['Accept-Language'] = 'en-US,en;q=0.9';
      config.headers['Accept-Encoding'] = 'gzip, deflate';
      config.headers['Connection'] = 'keep-alive';
      return config;
    });
  }

  /** Circuit-breaker + refresh introspection for main.ts persistence and tests. */
  isCircuitOpen(now = Date.now()): boolean {
    return this.circuitBreaker.isOpen(now);
  }

  getConsecutiveFailures(): number {
    return this.circuitBreaker.getConsecutiveFailures();
  }

  getCircuitOpenUntil(): number {
    return this.circuitBreaker.getOpenUntil();
  }

  getLastRefreshAt(): number | null {
    return this.lastRefreshAt;
  }

  getNextScheduledRefresh(): number | null {
    return this.nextScheduledRefresh;
  }

  restoreCircuitState(state: { consecutiveFailures?: number; circuitOpenUntil?: number }): void {
    this.circuitBreaker.restore(state);
  }

  setRefreshTracking(lastRefreshAt: number | null, nextScheduledRefresh: number | null): void {
    this.lastRefreshAt = lastRefreshAt;
    this.nextScheduledRefresh = nextScheduledRefresh;
  }

  private updateNextScheduledRefresh(accessToken: string): void {
    try {
      const payload = decodeTokenPayload(accessToken);
      const exp = payload?.['exp'];
      if (typeof exp === 'number') {
        // Proactive refresh target: exp minus the same 600s margin
        // isTokenExpired() uses, so the next refresh fires before failure.
        this.nextScheduledRefresh = exp * 1000 - 600 * 1000;
      }
    } catch {
      // Malformed token — leave nextScheduledRefresh as-is.
    }
  }

  // Returns `true` if this iteration actually performed a refresh, `false`
  // if it just loaded existing tokens. The fetch() loop uses the return
  // value to keep the `forceRefresh` flag set across successive 401s — a
  // 401 immediately after a successful refresh+401 must still trigger
  // another refresh.
  private async authenticate(forceRefresh = false): Promise<boolean> {
    let loginData = loadLoginData(this.loginDataPath);
    if (!loginData) {
      throw new Error(
        'No logindata.json found. Run "npm run login" first to authenticate with CareLink.',
      );
    }

    if (forceRefresh || isTokenExpired(loginData.access_token)) {
      try {
        loginData = await refreshToken(loginData);
        this.lastRefreshAt = Date.now();
        this.updateNextScheduledRefresh(loginData.access_token);
      } catch (e) {
        // Permanent auth failure (any 4xx from the refresh endpoint
        // without Retry-After — see src/refresh-failure.ts) means the
        // refresh token is dead and the operator must re-login. The
        // canonical case is HTTP 400 + invalid_grant / invalid_client,
        // but Auth0 has also been seen returning HTTP 401/403 with
        // empty bodies when the refresh token is revoked out-of-band
        // (issue #65). Any other error (transport, 5xx, 4xx with
        // Retry-After, local exception) is treated as recoverable: the
        // refresh token may still be valid, so retain the file and
        // rethrow for the retry loop to handle.
        if (isPermanentRefreshFailure(e)) {
          try { fs.unlinkSync(this.loginDataPath); } catch { /* ignore */ }
          logger.error('Deleted logindata.json — refresh token rejected. Run "npm run login" to re-authenticate.', { component: 'token' });
          throw new Error('Refresh token rejected. Run "npm run login" to log in again.');
        }
        // Recoverable — rethrow the original error verbatim so the retry
        // loop in fetch() can apply its own backoff policy.
        throw e;
      }
      try {
        writeLoginDataAtomic(this.loginDataPath, loginData);
      } catch (e) {
        // Local disk failure (EACCES, ENOSPC, ENOENT) — refresh succeeded
        // but the new tokens can't be persisted. NEVER delete the file
        // here: the prior tokens are still good and a retry of
        // writeLoginDataAtomic on the next fetch may succeed. Rethrow
        // so the operator sees the real error.
        throw e;
      }
      this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
      logger.info('Using token-based auth from logindata.json', { component: 'token' });
      return true;
    }

    this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
    this.updateNextScheduledRefresh(loginData.access_token);
    logger.info('Using token-based auth from logindata.json', { component: 'token' });
    return false;
  }

  // The username CareLink knows the account by. CARELINK_USERNAME in .env
  // may be an email while the actual CareLink username differs, and the
  // data endpoints expect the latter — so prefer what /users/me reports
  // (the same source nightscout-connect and carelink-python-client use).
  private currentUser?: CareLinkUserInfo;

  private accountUsername(): string {
    return this.currentUser?.username || this.options.username;
  }

  private async getConnectData(): Promise<CareLinkData> {
    const resp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
    this.currentUser = resp.data;
    const role = resp.data?.role?.toUpperCase() ?? '';
    logger.log('getConnectData - currentRole:', role);
    if (this.currentUser?.username && this.currentUser.username !== this.options.username) {
      logger.log(
        'CareLink reports username "' + this.currentUser.username +
        '" (differs from CARELINK_USERNAME) — using the server-reported one',
      );
    }

    if (role === 'CARE_PARTNER_OUS' || role === 'CARE_PARTNER') {
      return this.fetchAsCarepartner(role);
    }
    return this.fetchAsPatient();
  }

  private async fetchAsCarepartner(_role: string): Promise<CareLinkData> {
    let patientId = this.options.patientId;

    if (!patientId) {
      const patientsResp = await this.axiosInstance.get<CareLinkPatientLink[]>(this.urls.linkedPatients);
      if (patientsResp.data?.length > 0) {
        patientId = patientsResp.data[0].username;
        logger.log('Using linked patient:', patientId);
      } else {
        throw new Error('No linked patients found for care partner account');
      }
    }

    // Check if patient has a BLE device by fetching monitor data first
    try {
      const monitorResp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);
      const { family, model } = deviceIdentity(monitorResp.data);
      if (monitorResp.data && this.isBleDevice(family, model)) {
        logger.log('BLE device detected for carepartner, using BLE endpoint');
        return this.fetchBleDeviceData(patientId, 'carepartner');
      }
    } catch {
      // Fall through to standard carepartner flow
    }

    // Standard carepartner flow: BLE endpoint with multi-version fallback
    logger.log('Fetching country settings from:', this.urls.countrySettings);
    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const dataRetrievalUrl = settingsResp.data?.blePereodicDataEndpoint;

    if (!dataRetrievalUrl) {
      throw new Error('Unable to retrieve data retrieval URL for care partner account');
    }

    logger.log('Data retrieval URL:', dataRetrievalUrl);

    const endpoints = buildEndpointCandidates(dataRetrievalUrl);

    const body: Record<string, string> = {
      username: this.accountUsername(),
      role: 'carepartner',
      patientId,
    };

    for (const endpoint of endpoints) {
      try {
        logger.log('Trying carepartner endpoint:', endpoint);
        const resp = await this.axiosInstance.post<CareLinkData>(endpoint, body, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.status === 200) {
          logger.log('GET data (as carepartner)', endpoint);
          return resp.data;
        }
      } catch {
        logger.log('Endpoint failed:', endpoint);
      }
    }

    throw new Error('All carepartner data endpoints failed');
  }

  private isBleDevice(deviceFamily: string | undefined, deviceModel?: string): boolean {
    return isBleDevice(deviceFamily, deviceModel);
  }

  private async fetchBleDeviceData(patientId?: string, role: string = 'patient'): Promise<CareLinkData> {
    logger.log('Fetching BLE device data');

    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const bleEndpoint = settingsResp.data?.blePereodicDataEndpoint;

    if (!bleEndpoint) {
      throw new Error('No BLE endpoint found in country settings');
    }

    if (!patientId) {
      const userResp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
      patientId = userResp.data?.id;
    }

    const body: Record<string, string> = {
      username: this.accountUsername(),
      role,
    };

    if (patientId) {
      body.patientId = patientId;
    }

    const resp = await this.axiosInstance.post<CareLinkData>(bleEndpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    if (resp.data && resp.status === 200) {
      logger.log('GET data (BLE)', bleEndpoint);
      return resp.data;
    }

    throw new Error('BLE endpoint returned empty data');
  }

  private async fetchAsPatient(): Promise<CareLinkData> {
    // Try the monitor endpoint first (works for 7xxG pumps)
    try {
      const resp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);
      const { family, model } = deviceIdentity(resp.data);

      if (resp.data && this.isBleDevice(family, model)) {
        logger.log('BLE device detected, using BLE endpoint');
        return this.fetchBleDeviceData(this.accountUsername());
      }

      if (resp.status === 200 && resp.data && Object.keys(resp.data).length > 1) {
        logger.log('GET data', this.urls.monitorData);
        return resp.data;
      }
    } catch {
      // Fall through to legacy endpoint
    }

    // Fall back to the legacy connect endpoint
    return this.fetchConnectData();
  }

  /**
   * Legacy `patient/connect/data` fetch, with both CareLink data hosts tried
   * in turn (issue #74).
   *
   * The carelink host and the clcloud host both serve this path — only the
   * carelink host was ever tried. See the host-split note on
   * `dataHostCandidates()` in carelink/urls.ts for the probe table and for
   * how much of the "non-US accounts need clcloud" claim is verified.
   *
   * Mirrors buildEndpointCandidates()' version fallback in
   * fetchAsCarepartner(): first candidate that yields data wins, everything
   * else is logged and stepped over. Two deliberate differences:
   *
   * - An empty body does NOT count as success. A host that no longer serves
   *   the endpoint answers 200 with nothing in it, which is indistinguishable
   *   from a working fetch unless you look — the very failure mode this is
   *   meant to catch.
   * - A candidate that errors does not abort the loop. The error from the
   *   configured host is re-thrown if every candidate fails, so fetch()'s
   *   retry policy sees the same failure it always did.
   *
   * If every candidate comes back empty, the first empty body is returned
   * rather than an error: that is what the single-host version did, and a
   * genuinely empty CareLink payload is a real (if useless) answer, not a
   * transport failure. (The degenerate case — a 200 whose body parses to
   * `undefined` — is NOT preserved as-is: it used to return undefined and
   * blow up downstream, now it gets a named error.)
   */
  private async fetchConnectData(): Promise<CareLinkData> {
    const candidates = this.urls.connectDataCandidates(Date.now());

    let emptyBody: CareLinkData | undefined;
    let emptyFromSibling = false;
    let firstError: unknown;

    for (const url of candidates) {
      const isConfiguredHost = url === candidates[0];
      try {
        const resp = await this.axiosInstance.get<CareLinkData>(url);
        if (resp.status === 200 && hasPayload(resp.data)) {
          logger.log('GET data', url);
          return resp.data;
        }
        logger.log(
          candidates.length > 1
            ? 'connect/data returned no payload — trying the other data host'
            : 'connect/data returned no payload',
          url,
        );
        // Remember WHERE the empty body came from. Pre-#74 behaviour was: one
        // candidate, whatever it returned was the answer. We may only fall
        // back to an empty body when doing so preserves that. If the
        // configured host errored and only the *sibling* answered empty,
        // returning that body would convert a recorded failure into a false
        // success — fetch() would record a success, skip forceRefresh on a
        // 401, and report "no data" while CareLink was in fact erroring.
        if (emptyBody === undefined) {
          emptyBody = resp.data;
          emptyFromSibling = !isConfiguredHost;
        }
      } catch (e) {
        firstError ??= e;
        logger.log('connect/data failed:', url);
      }
    }

    if (emptyBody !== undefined && (firstError === undefined || !emptyFromSibling)) {
      return emptyBody;
    }
    throw firstError ?? new Error('All connect/data endpoints failed');
  }

  private throwAndRecord(e: unknown): never {
    const justOpened = this.circuitBreaker.recordFailure();
    if (justOpened) {
      const until = new Date(this.circuitBreaker.getOpenUntil()).toISOString();
      logger.warn('Circuit breaker open — pausing CareLink retries', {
        consecutiveFailures: this.circuitBreaker.getConsecutiveFailures(),
        openUntil: until,
      });
    }
    throw e;
  }

  async fetch(): Promise<CareLinkData> {
    // Circuit breaker (issue #9 item 3): after N consecutive failed fetch()
    // calls, short-circuit without touching the network for the cooldown.
    // The per-attempt backoff inside this method still applies when closed.
    if (this.circuitBreaker.isOpen()) {
      const until = new Date(this.circuitBreaker.getOpenUntil()).toISOString();
      throw new Error(
        `Circuit breaker open — skipping CareLink fetch until ${until} ` +
        `after ${this.circuitBreaker.getConsecutiveFailures()} consecutive failures`,
      );
    }

    this.requestCount = 0;

    // Up to 3 attempts total. The retry decision per attempt is
    // status-aware (see src/retry-policy.ts): 401/403 triggers an
    // authenticated re-attempt; 429 honours Retry-After; permanent 4xx
    // fails fast; 5xx and transport errors retry with capped exponential
    // + jitter.
    const maxRetry = 3;
    logger.info('Starting fetch', { component: 'fetch', maxAttempts: maxRetry });

    // CareLink can invalidate a token before its exp claim — most commonly
    // when the CareLink phone app logs into the same account. On 401/403,
    // force a refresh on the next attempt instead of retrying a dead token.
    let forceRefresh = false;

    for (let i = 1; i <= maxRetry; i++) {
      try {
        this.requestCount = 0;
        const didRefresh = await this.authenticate(forceRefresh);
        // Only clear forceRefresh when this iteration did NOT perform a
        // refresh. If authenticate returned true, the loop just ran a
        // refresh and clearing the flag would let the next 401 fire
        // without another refresh (the pre-fix bug — re-sends dead token
        // until the by-the-clock isTokenExpired check fires again).
        if (!didRefresh) {
          forceRefresh = false;
        }
        const data = await this.getConnectData();
        const closedCircuit = this.circuitBreaker.recordSuccess();
        if (closedCircuit) {
          logger.warn('Circuit breaker closed — CareLink reachable again');
        }
        logger.info('Success!', { component: 'fetch' });
        return data;
      } catch (e: unknown) {
        const err = e as { response?: { status: number; headers?: Record<string, unknown> }; code?: string; cause?: { code?: string }; message?: string };
        const httpStatus = err.response?.status;
        const errorCode = err.code || err.cause?.code || '';
        logger.info(`Attempt ${i} failed: ${httpStatus ? 'HTTP ' + httpStatus : errorCode || (err as Error).message}`, { component: 'fetch', attempt: i });

        // 401/403 is the auth path: the token may simply need a refresh,
        // not a permanent backoff. Short-circuit decideRetry here because
        // the retry policy treats 401/403 as fail-fast (the auth path's
        // own job, not the retry policy's). Skipping decideRetry lets the
        // next iteration run authenticate(forceRefresh = true) before
        // another data call. On the last attempt, give up — the
        // refresh-and-retry cycle has already exhausted itself.
        if (httpStatus === 401 || httpStatus === 403) {
          forceRefresh = true;
          if (i === maxRetry) this.throwAndRecord(e);
          continue;
        }

        // Status-aware retry decision for everything else. Permanent 4xx
        // (other than 401/403) fail fast — no point hammering a host that
        // has nothing to give. 429 honours Retry-After (numeric or
        // HTTP-date). 5xx and transport errors retry with capped
        // exponential + jitter. On the last attempt, decideRetry always
        // returns fail-fast.
        const decision = decideRetry(e, { attempt: i, maxAttempts: maxRetry });
        if (decision.kind === 'fail-fast') {
          this.throwAndRecord(e);
        }
        await sleep(decision.delayMs);
      }
    }

    this.throwAndRecord(new Error('Fetch failed after all retries'));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pulls the device-identity fields out of a CareLink data response, in the
 * order Medtronic's own portal resolves them.
 *
 * The response shape varies by endpoint generation: `monitor/data` returns
 * the family as `deviceFamily`, older endpoints as `medicalDeviceFamily`;
 * the model number arrives as `deviceModel` or `sensorModel` (the portal
 * resolver prefers `deviceModel`, then falls back to `sensorModel`).
 *
 * `CareLinkData` declares only the two family fields — the model fields fall
 * through to its index signature as `unknown`, and a partial payload can
 * carry `null` or a number where a string belongs. Narrowing in one place
 * keeps the call sites cast-free and sends isBleDevice() either a non-empty
 * string or `undefined`, both of which it already handles.
 */
function deviceIdentity(
  data: CareLinkData | undefined,
): { family: string | undefined; model: string | undefined } {
  const raw = (data ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  return {
    family: pick('deviceFamily') ?? pick('medicalDeviceFamily'),
    model: pick('deviceModel') ?? pick('sensorModel'),
  };
}

/**
 * Whether a data response actually carries a payload.
 *
 * A host that no longer serves an endpoint answers `200` with an empty body
 * — axios surfaces that as `{}` or `""`, not as an error. Without this check
 * the legacy fallback could "succeed" with nothing in it, which is the exact
 * silent-empty-fetch failure issue #74 is about.
 *
 * Only a non-empty object counts. A sibling host answering 200 with an
 * HTML/plain-text body or a JSON scalar is not CareLink data, and accepting
 * it would hand a non-object to `transform()` — so non-object bodies are
 * payload-less here, not just empty ones.
 */
function hasPayload(data: unknown): boolean {
  if (typeof data === 'object' && data !== null) return Object.keys(data).length > 0;
  return false;
}

/**
 * Determines whether a CareLink device identifies as a BLE / standalone-CGM
 * device (780G, Guardian 4, Simplera, Instinct, Guardian Connect…). Exported
 * at module level so the helper can be unit-tested without spinning up a
 * CareLinkClient.
 *
 * The patient `monitor/data` endpoint returns the family under `deviceFamily`,
 * while older endpoints use `medicalDeviceFamily`. The fix from upstream
 * PR #2 (https://github.com/domien-f/carelink-bridge/pull/2) made the call
 * sites pass `deviceFamily || medicalDeviceFamily` so BLE detection works
 * for both shapes.
 *
 * ---
 *
 * Two additional inputs matter, found during the 2026-10-08 reverse-engineering
 * pass (research notes: research/probe-2026-10-08/APP-EMULATION-RESEARCH.md):
 *
 * 1. **Medtronic's own portal defines its device-family value as
 *    `SIMPLERA_SYSTEM = "Simplera™ system"` — mixed case.** JavaScript's
 *    `String.includes()` is case-sensitive, so the previous
 *    `includes('SIMPLERA')` returned `false` for that exact string and BLE
 *    detection silently failed. Matching is now normalised (uppercased,
 *    non-alphanumerics stripped) so `"Simplera™ system"`, `"SIMPLERA_SYSTEM"`
 *    and `"simplera"` all match. See issue #73.
 *
 * 2. **Medtronic's portal resolver prefers `deviceModel`, then `sensorModel`,
 *    and treats `"NO_SENSOR"` as a sentinel.** The API returns those fields
 *    alongside the family strings, and the bridge previously ignored both.
 *    They are accepted as an optional second argument.
 *
 * The model prefixes below are an *offline heuristic*, transcribed from
 * Medtronic's published device table. Medtronic also serves a live
 * `deviceModelMapping` / `deviceToFamilyMapping` config to their own client,
 * so the authoritative source is server-side; treat this table as a fallback
 * for when only the family/model string is available. Whether the wire value
 * actually arrives as a display string or an enum key is unverified (needs a
 * real CareLink token), which is exactly why the match is deliberately lenient.
 */

/** Device-model prefixes known to be BLE / standalone-CGM families. */
const BLE_DEVICE_MODELS: readonly string[] = [
  // --- Pumps that pair to the CareLink app over BLE ---
  'MMT1884', // 780G (incl. MMT-1884XCU / XCE / XCF)
  'MMT1885', // 780G
  'MMT1886', // 780G (incl. MMT-1886XCE / XCF)

  // --- Minimed Flex (INFERRED from Medtronic's portal bundle, NOT a wire
  //     observation — issue #91). The Flex (MMT-8062/8063/8082-8085,
  //     "Minimed Flex", minValue 50) is already shipping: upstream
  //     domien-f/carelink-bridge#3 reports silent zero-data fetch after a
  //     780G-to-Flex upgrade, the exact failure mode of undetected BLE.
  'MMT8062', // Minimed Flex
  'MMT8063', // Minimed Flex
  'MMT8082', // Minimed Flex
  'MMT8083', // Minimed Flex
  'MMT8084', // Minimed Flex
  'MMT8085', // Minimed Flex

  // --- Standalone CGM sensors ---
  'MMT7841',  // Guardian 4 Sensor
  'MMT5120',  // Simplera Sync
  'MMT5420',  // Instinct Sensor
  'CSS7200',  // Guardian Connect
  'CSS7201',  // Guardian Connect

  // --- Standalone CGM *systems* (INFERRED from Medtronic's portal bundle,
  //     NOT a wire observation). Issue #73 asked for these. The Guardian 4
  //     System and Simplera System rows are unambiguously BLE-paired devices,
  //     so treating the Sensor but not the System would be internally
  //     inconsistent. Verified only as entries in Medtronic's published
  //     device table; which shape the CareLink API actually returns is
  //     UNVERIFIED without a token.
  'GM4SNAPSHOT', // guardian-4 snapshot sentinel, as published
  'MMT8200',     // Guardian 4 system
  'MMT8201',     // Guardian 4 system
  'MMT6500',     // Simplera system
  'MMT6501',     // Simplera system
  'MMT8400',     // Simplera system
  'MMT8401',     // Simplera system

  // --- Instinct sensor / Go SKU family ---
  'SKU78893', 'SKU78953', 'SKU78955', 'SKU78957', 'SKU78959', 'SKU78960',
  'SKU78954', 'SKU78956', 'SKU78958',
];

/** Sentinel the API uses for "no sensor attached". */
const NO_SENSOR = 'NOSENSOR';

/** Uppercase and strip non-alphanumerics, so "Simplera™ system" -> "SIMPLERASYSTEM". */
function normalise(value: string | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isBleDevice(deviceFamily?: string, deviceModel?: string): boolean {
  const family = normalise(deviceFamily);
  const model = normalise(deviceModel);

  if (family && family !== NO_SENSOR) {
    // Prefix match, not a substring. Deliberate: after normalising, a plain
    // includes('BLE') would also match 'ENABLE', 'DOUBLE' and 'TABLE'.
    // Every family value Medtronic has been observed to send — 'BLE_MINIMED',
    // 'BLE_PUMP', 'SIMPLERA', 'SIMPLERA_SYSTEM', "Simplera™ system" — and all
    // of them start with the token, so prefix covers them without that risk.
    // Residual risk, stated not fixed: the matcher's input is UNVERIFIED (see
    // above), so a future spelling with the BLE token anywhere but leading
    // position is a silent false-negative — the price of the prefix form,
    // accepted because every observed spelling leads with the token.
    if (family.startsWith('BLE') || family.startsWith('SIMPLERA')) return true;
    // Substring, deliberately — but only for this one token (#91). Unlike
    // 'BLE' (a substring of ENABLE, DOUBLE, TABLE), 'FLEX' is not a substring
    // of any other known family value (GUARDIAN, NGP, CGM, CC, PARADIGM,
    // BLE_*, SIMPLERA*, MINIMEDFLEX), audited 2026-10-09. The Flex's family
    // spelling is UNVERIFIED — "Minimed Flex" does not lead with a known
    // token, so prefix matching cannot cover it. Revisit if a non-Flex
    // family containing FLEX ever appears.
    if (family.includes('FLEX')) return true;
  }

  if (model && model !== NO_SENSOR) {
    if (BLE_DEVICE_MODELS.some((prefix) => model.startsWith(prefix))) return true;
  }

  return false;
}

/**
 * Known API versions of the carepartner data endpoint, tried newest-first
 * after whatever version the country-settings config hands out. As of
 * 2026-07 the config returns v6 while the app discovery config advertises
 * a v13 base URL, so the fallback list spans both directions. Exported at
 * module level for unit testing.
 */
const BLE_API_VERSIONS = [13, 11, 6, 5];

export function buildEndpointCandidates(url: string): string[] {
  if (!/\/v\d+\//.test(url)) return [url];
  const candidates = [
    url,
    ...BLE_API_VERSIONS.map(v => url.replace(/\/v\d+\//, `/v${v}/`)),
  ];
  return [...new Set(candidates)];
}
