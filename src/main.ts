import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config();
import { loadConfig } from './config.js';
import { CareLinkClient } from './carelink/client.js';
import { transform } from './transform/index.js';
import { makeRecencyFilter } from './filter.js';
import { upload } from './nightscout/upload.js';
import * as logger from './logger.js';
import * as metrics from './metrics.js';
import type { Server } from 'node:http';
import { startObserveServer } from './observe-server.js';
import { login, LOGINDATA_FILE } from './login.js';
import { loadPersistentState, savePersistentState, type PersistentState } from './persistent-state.js';
import type { NightscoutSGVEntry, NightscoutDeviceStatus } from './types/nightscout.js';

const config = loadConfig();
logger.setVerbose(config.verbose);
logger.setLogFormat(config.logFormat);

// Persistent state (issue #9 item 4): survives restarts, mode 0600.
// Default sits next to logindata.json; override with CARELINK_STATE_FILE.
const STATE_FILE = config.stateFile || path.join(path.dirname(LOGINDATA_FILE), 'state.json');
const persisted: PersistentState = loadPersistentState(STATE_FILE);
if (persisted.lastSuccessTimestamp !== null) {
  logger.info(`Restored last success: ${new Date(persisted.lastSuccessTimestamp).toISOString()}`, { component: 'state' });
}
if (persisted.consecutiveFailures > 0) {
  logger.info(`Restored circuit state: ${persisted.consecutiveFailures} consecutive failures`, { component: 'state' });
}

const client = new CareLinkClient({
  username: config.username,
  password: config.password,
  patientId: config.patientId,
  countryCode: config.countryCode,
  lang: config.language,
  circuitThreshold: config.circuitThreshold,
  circuitCooldownMs: config.circuitCooldownMs,
});
client.restoreCircuitState(persisted);
client.setRefreshTracking(persisted.lastRefreshTokenUse, persisted.nextScheduledRefresh);

const baseUrl = config.nsBaseUrl || ('https://' + config.nsHost);
const entriesUrl = baseUrl + '/api/v1/entries.json';
const devicestatusUrl = baseUrl + '/api/v1/devicestatus.json';

const filterSgvs = makeRecencyFilter<NightscoutSGVEntry>(item => item.date);
const filterDeviceStatus = makeRecencyFilter<NightscoutDeviceStatus>(
  item => new Date(item.created_at).getTime(),
);

// --- Stale-data tracking (seeded from persistent state) ---
let lastSuccessTimestamp: number | null = persisted.lastSuccessTimestamp;
let staleNotified = false;

function persistState(): void {
  try {
    savePersistentState(STATE_FILE, {
      version: persisted.version,
      lastSuccessTimestamp,
      consecutiveFailures: client.getConsecutiveFailures(),
      circuitOpenUntil: client.getCircuitOpenUntil(),
      lastRefreshTokenUse: client.getLastRefreshAt(),
      nextScheduledRefresh: client.getNextScheduledRefresh(),
    });
  } catch (err) {
    // State is best-effort — a disk failure here must never break the loop.
    logger.error('Failed to persist state.json', { component: 'state', error: (err as Error).message });
  }
}

async function fireStaleWebhook(since: number): Promise<void> {
  if (!config.staleWebhookUrl) return;
  try {
    const res = await fetch(config.staleWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridge: 'stale',
        since: new Date(since).toISOString(),
        threshold_ms: config.staleThresholdMs,
      }),
    });
    if (!res.ok) {
      logger.error(`Stale webhook returned ${res.status}`, { component: 'bridge', status: res.status });
    }
  } catch (err) {
    logger.error('Stale webhook failed', { component: 'bridge', error: (err as Error).message });
  }
}

function checkStale(): void {
  if (lastSuccessTimestamp === null) return;

  const elapsed = Date.now() - lastSuccessTimestamp;
  if (elapsed > config.staleThresholdMs) {
    if (!staleNotified) {
      const mins = Math.round(elapsed / 60000);
      logger.warn(`STALE — no successful fetch for ${mins} min (threshold ${config.staleThresholdMs / 60000} min)`, { component: 'bridge' });
      staleNotified = true;
      void fireStaleWebhook(lastSuccessTimestamp);
    }
  } else if (staleNotified) {
    // Recovered
    logger.info('Recovered — fetch succeeded after stale period', { component: 'bridge' });
    staleNotified = false;
  }
}

// --- Opt-in observability server (issue #10 item 2): loopback-only /healthz + /metrics.
// Disabled by default (CARELINK_METRICS_PORT unset/0) so the bridge still opens
// no inbound port unless the operator asks for it.
let observeServer: Server | null = null;
if (config.metricsPort > 0) {
  observeServer = startObserveServer({
    port: config.metricsPort,
    getStatus: () => {
      const circuitOpen = client.isCircuitOpen();
      metrics.setCircuitOpen(circuitOpen);
      return {
        lastSuccessTimestamp,
        consecutiveFailures: client.getConsecutiveFailures(),
        circuitOpen,
      };
    },
  });
}

// --- Graceful shutdown ---
let shuttingDown = false;
let loopResolve: (() => void) | null = null;

function handleShutdown(signal: string): void {
  if (shuttingDown) {
    logger.info(`Received ${signal} again — forcing exit`, { component: 'bridge', signal });
    process.exit(1);
  }
  shuttingDown = true;
  if (observeServer) {
    observeServer.close();
    observeServer = null;
  }
  logger.info(`Received ${signal} — shutting down gracefully (max 10s)`, { component: 'bridge', signal });

  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit', { component: 'bridge' });
    process.exit(1);
  }, 10_000);

  if (loopResolve) {
    loopResolve();
    forceTimer.unref();
  } else {
    clearTimeout(forceTimer);
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// --- Core loop ---
function sleep(ms: number, abortSignal?: { aborted: boolean }): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (abortSignal) {
      const interval = setInterval(() => {
        if (abortSignal.aborted) {
          clearTimeout(timer);
          clearInterval(interval);
          resolve();
        }
      }, 500);
    }
  });
}

async function uploadIfNew(items: unknown[], endpoint: string): Promise<void> {
  if (items.length === 0) {
    logger.log('No new items for', endpoint);
    return;
  }
  try {
    await upload(items, endpoint, config.nsSecret);
    const kind = endpoint.includes('entries') ? 'entries' as const : 'devicestatus' as const;
    metrics.incUpload(kind, items.length);
    logger.info('Upload succeeded', { endpoint, count: items.length });
  } catch (err) {
    // Continue even if Nightscout can't be reached
    logger.error('Upload failed', { endpoint, error: (err as Error).message });
  }
}

async function requestLoop(): Promise<void> {
  const abortSignal = { aborted: false };

  while (!shuttingDown) {
    const t0 = Date.now();
    try {
      const data = await client.fetch();

      if (!data?.lastMedicalDeviceDataUpdateServerTime) {
        metrics.incFetch('failure');
        logger.warn('Empty or invalid data from CareLink', { component: 'bridge', keys: Object.keys(data || {}).length });
      } else {
        metrics.incFetch('success');
        metrics.setLastSuccess(Date.now());
        metrics.observeFetchDuration(Date.now() - t0);

        const transformed = transform(data, config.sgvLimit);
        const newSgvs = filterSgvs(transformed.entries);
        const newDeviceStatuses = filterDeviceStatus(transformed.devicestatus);

        lastSuccessTimestamp = Date.now();
        staleNotified = false;
        persistState();

        logger.info('Fetch succeeded', {
          sgvCount: transformed.entries.length,
          newSgvCount: newSgvs.length,
          newDeviceStatusCount: newDeviceStatuses.length,
        });

        logger.log(
          `Next check in ${Math.round(config.interval / 1000)}s` +
          ` (at ${new Date(Date.now() + config.interval)})`,
        );

        await uploadIfNew(newSgvs, entriesUrl);
        await uploadIfNew(newDeviceStatuses, devicestatusUrl);
      }
    } catch (error) {
      metrics.incFetch('failure');
      metrics.observeFetchDuration(Date.now() - t0);
      logger.error('Fetch failed', { error: (error as Error).message });
      persistState();
    }
    metrics.setCircuitOpen(client.isCircuitOpen());

    checkStale();

    if (shuttingDown) break;
    await sleep(config.interval, abortSignal);
  }

  if (loopResolve) loopResolve();
}

async function ensureLogin(): Promise<void> {
  if (!fs.existsSync(LOGINDATA_FILE)) {
    logger.info('No logindata.json found — starting login flow...', { component: 'bridge' });
    const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
    await login(isUS, config.username, config.password);
    console.log('');
  }
}

// Start
try {
  await ensureLogin();
  logger.info(`Starting — interval set to ${config.interval / 1000}s`, { component: 'bridge', intervalMs: config.interval });
  logger.info(`Stale threshold: ${config.staleThresholdMs / 60000} min${config.staleWebhookUrl ? ' (webhook enabled)' : ''}`, { component: 'bridge', staleThresholdMs: config.staleThresholdMs });
  logger.info('Fetching data now...', { component: 'bridge' });

  const loopPromise = requestLoop();

  // If shutdown signal arrives during the loop, wait for it to finish
  await new Promise<void>(resolve => {
    if (shuttingDown) {
      resolve();
    } else {
      loopResolve = resolve;
      loopPromise.then(resolve);
    }
  });

  logger.info('Shutdown complete', { component: 'bridge' });
  process.exit(0);
} catch (err) {
  logger.error('Fatal', { component: 'bridge', error: (err as Error).message });
  process.exit(1);
}
