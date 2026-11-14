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
import { isUsablePayload } from './payload-shape.js';
import { decideStale } from './stale-watchdog.js';
import * as logger from './logger.js';
import * as metrics from './metrics.js';
import type { UploadEndpoint } from './metrics.js';
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
const treatmentsUrl = baseUrl + '/api/v1/treatments.json';

const filterSgvs = makeRecencyFilter<NightscoutSGVEntry>(item => item.date, {
  label: 'sgv',
});
const filterDeviceStatus = makeRecencyFilter<NightscoutDeviceStatus>(
  item => new Date(item.created_at).getTime(),
  { label: 'devicestatus' },
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
  const decision = decideStale(lastSuccessTimestamp, Date.now(), config.staleThresholdMs);
  if (decision.stale === null) return;

  // Track the gauge off the same decision the watchdog uses, not just off the
  // stale-payload branch. Without this, a bridge whose every fetch is failing
  // (circuit open, network dead, auth broken) fires the STALE warning while
  // carelink_stale still reads 0 — the gauge would report "fine" in exactly the
  // situation it exists to flag.
  metrics.setStale(decision.stale);

  if (decision.stale) {
    if (!staleNotified) {
      const mins = Math.round((decision.elapsedMs ?? 0) / 60000);
      logger.warn(`STALE — no successful fetch for ${mins} min (threshold ${config.staleThresholdMs / 60000} min)`, { component: 'bridge' });
      staleNotified = true;
      void fireStaleWebhook(lastSuccessTimestamp as number);
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
        // The caller's real threshold, so a CARELINK_STALE_THRESHOLD_MINUTES
        // override is honoured here too. Omitting it would silently restore the
        // pre-#134 behaviour where stale data read as healthy.
        staleThresholdMs: config.staleThresholdMs,
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
    const stored = await upload(items, endpoint, config.nsSecret);
    // Derive the metric label from the endpoint we actually posted to. The
    // previous shape was a two-way `entries` / not-`entries` test, so treatments
    // were counted as devicestatus the moment they became a third target.
    const kind: UploadEndpoint = endpoint.includes('entries')
      ? 'entries'
      : endpoint.includes('treatments')
        ? 'treatments'
        : 'devicestatus';
    metrics.incUpload(kind, stored);
    // What the count means, precisely.
    //
    // CORRECTED 2026-11-13: this used to say "Report what was STORED, not what
    // was sent" and treat a gap as evidence of dedup. That was wrong.
    // Nightscout's POST response is the request ECHOED back, not the stored set
    // — `lib/server/treatments.js:163` returns `objOrArray`,
    // `devicestatus.js:159,170` returns `statuses` including the re-sent copies
    // it did not insert, and `entries` returns `docs`. So `stored` equals
    // `items.length` in the normal case and the gap branch below is
    // effectively unreachable.
    //
    // The load-bearing check lives in `upload()`: it throws when Nightscout
    // answers 200 but stores none of a non-empty payload, which is the
    // silent-discard case that matters. This log is accounting, not proof.
    if (stored !== items.length) {
      logger.info(
        'Nightscout accepted ' + stored + ' of ' + items.length + ' item(s) in the ' +
          'response — the remainder were dropped server-side',
        { endpoint, sent: items.length, accepted: stored },
      );
    } else {
      logger.info('Upload accepted', { endpoint, count: stored });
    }
  } catch (err) {
    // Continue even if Nightscout can't be reached, but COUNT it. Before this
    // the failure existed only as a log line, so a Nightscout that had started
    // rejecting every write was invisible on any dashboard — the upload counter
    // only ever incremented on success.
    const reason = metrics.classifyUploadFailure(err);
    metrics.incUploadFailure(
      endpoint.includes('entries')
        ? 'entries'
        : endpoint.includes('treatments')
          ? 'treatments'
          : 'devicestatus',
      reason,
    );
    logger.error('Upload failed', { endpoint, reason, error: (err as Error).message });
  }
}

async function requestLoop(): Promise<void> {
  const abortSignal = { aborted: false };

  while (!shuttingDown) {
    const t0 = Date.now();
    try {
      const data = await client.fetch();

      if (!isUsablePayload(data)) {
        metrics.incFetch('failure');
        logger.warn('Empty or invalid data from CareLink', { component: 'bridge', keys: Object.keys(data || {}).length });
      } else {
        const transformed = transform(data, config.sgvLimit);

        if (transformed.stale) {
          // CareLink answered 200 with data that is older than the threshold.
          // Count it honestly and do NOT advance the success clock: resetting
          // lastSuccessTimestamp / staleNotified here is what made the stale
          // watchdog unable to fire for the case it was built for.
          metrics.incFetch('failure');
          metrics.observeFetchDuration(Date.now() - t0);
          metrics.setCircuitOpen(client.isCircuitOpen());
          metrics.setStale(true);
          checkStale();
          if (shuttingDown) break;
          await sleep(config.interval, abortSignal);
          continue;
        }

        metrics.incFetch('success');
        metrics.setLastSuccess(Date.now());
        metrics.observeFetchDuration(Date.now() - t0);

        const newSgvs = filterSgvs(transformed.entries);
        const newDeviceStatuses = filterDeviceStatus(transformed.devicestatus);
        // Treatments carry a deterministic _id (see transform/treatments.ts), so
        // Nightscout's own _id dedup makes a re-post an UPDATE rather than a
        // duplicate. No local filter is applied: a marker we already sent must
        // still be sent while it is in CareLink's rolling 24 h window, or a
        // restart would never re-assert a meal it had not yet seen.
        const newTreatments = transformed.treatments;

        lastSuccessTimestamp = Date.now();
        staleNotified = false;
        metrics.setStale(false);
        // Age of the DATA, not of the fetch. A successful fetch of an hour-old
        // payload looks identical to a fresh one in every other counter, which
        // is exactly the "stale but 200" case the legacy backend produces.
        // transform() already refused the stale case above, so any reading here
        // is one the bridge considers fresh — this exposes how fresh.
        const newest = transformed.entries[transformed.entries.length - 1];
        if (newest && Number.isFinite(newest.date)) {
          metrics.setNewestReading(newest.date);
        }
        persistState();

        logger.info('Fetch succeeded', {
          sgvCount: transformed.entries.length,
          newSgvCount: newSgvs.length,
          newDeviceStatusCount: newDeviceStatuses.length,
          treatmentCount: newTreatments.length,
        });

        logger.log(
          `Next check in ${Math.round(config.interval / 1000)}s` +
          ` (at ${new Date(Date.now() + config.interval)})`,
        );

        await uploadIfNew(newSgvs, entriesUrl);
        await uploadIfNew(newDeviceStatuses, devicestatusUrl);
        await uploadIfNew(newTreatments, treatmentsUrl);
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
