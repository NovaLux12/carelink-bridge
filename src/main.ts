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
import { login, LOGINDATA_FILE } from './login.js';
import type { NightscoutSGVEntry, NightscoutDeviceStatus } from './types/nightscout.js';

const config = loadConfig();
logger.setVerbose(config.verbose);

const client = new CareLinkClient({
  username: config.username,
  password: config.password,
  patientId: config.patientId,
  countryCode: config.countryCode,
  lang: config.language,
});

const baseUrl = config.nsBaseUrl || ('https://' + config.nsHost);
const entriesUrl = baseUrl + '/api/v1/entries.json';
const devicestatusUrl = baseUrl + '/api/v1/devicestatus.json';

const filterSgvs = makeRecencyFilter<NightscoutSGVEntry>(item => item.date);
const filterDeviceStatus = makeRecencyFilter<NightscoutDeviceStatus>(
  item => new Date(item.created_at).getTime(),
);

// --- Stale-data tracking ---
let lastSuccessTimestamp: number | null = null;
let staleNotified = false;

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
      console.error(`[Bridge] Stale webhook returned ${res.status}`);
    }
  } catch (err) {
    console.error('[Bridge] Stale webhook failed:', (err as Error).message);
  }
}

function checkStale(): void {
  if (lastSuccessTimestamp === null) return;

  const elapsed = Date.now() - lastSuccessTimestamp;
  if (elapsed > config.staleThresholdMs) {
    if (!staleNotified) {
      const mins = Math.round(elapsed / 60000);
      console.warn(`[Bridge] STALE — no successful fetch for ${mins} min (threshold ${config.staleThresholdMs / 60000} min)`);
      staleNotified = true;
      void fireStaleWebhook(lastSuccessTimestamp);
    }
  } else if (staleNotified) {
    // Recovered
    console.log('[Bridge] Recovered — fetch succeeded after stale period');
    staleNotified = false;
  }
}

// --- Graceful shutdown ---
let shuttingDown = false;
let loopResolve: (() => void) | null = null;

function handleShutdown(signal: string): void {
  if (shuttingDown) {
    console.log(`[Bridge] Received ${signal} again — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[Bridge] Received ${signal} — shutting down gracefully (max 10s)`);

  const forceTimer = setTimeout(() => {
    console.error('[Bridge] Graceful shutdown timed out — forcing exit');
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
  } catch (err) {
    // Continue even if Nightscout can't be reached
    console.error(err);
  }
}

async function requestLoop(): Promise<void> {
  const abortSignal = { aborted: false };

  while (!shuttingDown) {
    try {
      const data = await client.fetch();

      if (!data?.lastMedicalDeviceDataUpdateServerTime) {
        console.log('[Bridge] Warning: received empty or invalid data from CareLink');
        console.log('[Bridge] Data keys:', Object.keys(data || {}));
      } else {
        const transformed = transform(data, config.sgvLimit);
        const newSgvs = filterSgvs(transformed.entries);
        const newDeviceStatuses = filterDeviceStatus(transformed.devicestatus);

        lastSuccessTimestamp = Date.now();
        staleNotified = false;

        logger.log(
          `Next check in ${Math.round(config.interval / 1000)}s` +
          ` (at ${new Date(Date.now() + config.interval)})`,
        );

        await uploadIfNew(newSgvs, entriesUrl);
        await uploadIfNew(newDeviceStatuses, devicestatusUrl);
      }
    } catch (error) {
      console.error(error);
    }

    checkStale();

    if (shuttingDown) break;
    await sleep(config.interval, abortSignal);
  }

  if (loopResolve) loopResolve();
}

async function ensureLogin(): Promise<void> {
  if (!fs.existsSync(LOGINDATA_FILE)) {
    console.log('[Bridge] No logindata.json found — starting login flow...');
    const isUS = (process.env['MMCONNECT_SERVER'] || 'EU').toUpperCase() !== 'EU';
    await login(isUS, config.username, config.password);
    console.log('');
  }
}

// Start
try {
  await ensureLogin();
  console.log(`[Bridge] Starting — interval set to ${config.interval / 1000}s`);
  console.log(`[Bridge] Stale threshold: ${config.staleThresholdMs / 60000} min${config.staleWebhookUrl ? ' (webhook enabled)' : ''}`);
  console.log('[Bridge] Fetching data now...');

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

  console.log('[Bridge] Shutdown complete');
  process.exit(0);
} catch (err) {
  console.error('[Bridge] Fatal:', (err as Error).message);
  process.exit(1);
}
