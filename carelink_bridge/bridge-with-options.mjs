// Map Home Assistant app options (/data/options.json) to the environment
// variables the bridge reads, then start the bridge.
//
// This runs as `node` (uid 1000) after run.sh has handed over. It does not
// reimplement any bridge logic: once the environment is set it imports the
// published entrypoint and gets out of the way.

import fs from 'node:fs';

const OPTIONS_FILE = '/data/options.json';

// option name in config.yaml  ->  env var read by src/config.ts & friends
const MAPPING = [
  ['carelink_username',               'CARELINK_USERNAME'],
  ['carelink_password',               'CARELINK_PASSWORD'],
  ['api_secret',                      'API_SECRET'],
  ['ns',                              'NS'],
  ['mmconnect_server',                'MMCONNECT_SERVER'],
  ['mmconnect_countrycode',           'MMCONNECT_COUNTRYCODE'],
  ['mmconnect_langcode',              'MMCONNECT_LANGCODE'],
  ['mmconnect_servername',            'MMCONNECT_SERVERNAME'],
  ['carelink_interval',               'CARELINK_INTERVAL'],
  ['carelink_sgv_limit',              'CARELINK_SGV_LIMIT'],
  ['carelink_quiet',                  'CARELINK_QUIET'],
  ['log_format',                      'LOG_FORMAT'],
  ['carelink_patient',                'CARELINK_PATIENT'],
  ['carelink_assume_timezone',        'CARELINK_ASSUME_TIMEZONE'],
  ['carelink_stale_threshold_minutes', 'CARELINK_STALE_THRESHOLD_MINUTES'],
  ['stale_webhook_url',               'STALE_WEBHOOK_URL'],
  ['carelink_data_path',              'CARELINK_DATA_PATH'],
  ['carelink_app_version',            'CARELINK_APP_VERSION'],
  ['carelink_circuit_threshold',      'CARELINK_CIRCUIT_THRESHOLD'],
  ['carelink_circuit_cooldown_s',     'CARELINK_CIRCUIT_COOLDOWN_S'],
  ['carelink_metrics_port',           'CARELINK_METRICS_PORT'],
];

function readOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
  } catch (err) {
    // Fail loudly rather than starting a bridge with no credentials: the
    // bridge's own error for a missing CARELINK_USERNAME is clear enough, but
    // a silent empty environment here would be a second, worse failure mode.
    console.error(`[ha-app] cannot read ${OPTIONS_FILE}: ${err.message}`);
    process.exit(1);
  }
}

const options = readOptions();

for (const [option, envVar] of MAPPING) {
  const value = options[option];

  // Unset rather than empty: the bridge treats an empty string as "present but
  // blank" for some keys (CARELINK_PATIENT, MMCONNECT_SERVERNAME) and its own
  // default is the correct behaviour in that case.
  if (value === undefined || value === null || value === '') continue;

  // Booleans must be the literal lowercase strings `true`/`false`.
  // `readEnvBool` in src/config.ts only recognises those two literals — any
  // other non-empty string goes through `Boolean(val)`, which is TRUE. So
  // "False" would mean quiet, and CARELINK_QUIET is inverted into `verbose`.
  // Verified against the published image: CARELINK_QUIET=False -> verbose:false.
  if (typeof value === 'boolean') {
    process.env[envVar] = value ? 'true' : 'false';
    continue;
  }

  process.env[envVar] = String(value);
}

// State must live on the persistent volume, not /app. It is written with the
// same atomic `rename` as the token, so it needs a real directory — /data is a
// bind mount of the app's private data folder, which is exactly that.
process.env['CARELINK_STATE_FILE'] = '/data/state.json';

// The bridge is a long-running daemon, so its structured log lines are the only
// UI Home Assistant has for it. `pretty` is the default and reads fine in the
// app log; `json` is available for anyone shipping the log elsewhere.
console.log('[ha-app] starting carelink-bridge');

await import('/app/dist/main.js');
