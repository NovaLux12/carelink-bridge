import type { Config } from './types/config.js';

function readEnv(key: string, defaultVal?: string): string | boolean | null | undefined {
  let val: string | undefined =
    process.env[key] ||
    process.env[key.toLowerCase()] ||
    process.env['CUSTOMCONNSTR_' + key] ||
    process.env['CUSTOMCONNSTR_' + key.toLowerCase()];

  if (val === 'true') return true as unknown as string;
  if (val === 'false') return false as unknown as string;
  if (val === 'null') return null;

  return val !== undefined ? val : defaultVal;
}

function readEnvString(key: string, defaultVal?: string): string | undefined {
  const val = readEnv(key, defaultVal);
  if (val === null || val === undefined) return defaultVal;
  return String(val);
}

function readEnvBool(key: string, defaultVal: boolean): boolean {
  const val = readEnv(key);
  if (val === true || val === false) return val as unknown as boolean;
  if (val === undefined || val === null) return defaultVal;
  return Boolean(val);
}

function readEnvInt(key: string, defaultVal: number): number {
  const val = readEnvString(key, String(defaultVal));
  const parsed = parseInt(val!, 10);
  return Number.isNaN(parsed) ? defaultVal : parsed;
}

export function loadConfig(): Config {
  const username = readEnvString('CARELINK_USERNAME');
  const password = readEnvString('CARELINK_PASSWORD');
  const nsSecret = readEnvString('API_SECRET');

  if (!username) throw new Error('Missing CARELINK_USERNAME');
  if (!password) throw new Error('Missing CARELINK_PASSWORD');
  if (!nsSecret) throw new Error('Missing API_SECRET');

  const defaultIntervalSeconds = 300;
  const defaultStaleThresholdMinutes = 15;

  return {
    username,
    password,
    nsHost: readEnvString('WEBSITE_HOSTNAME'),
    nsBaseUrl: readEnvString('NS'),
    nsSecret,
    interval: readEnvInt('CARELINK_INTERVAL', defaultIntervalSeconds) * 1000,
    sgvLimit: readEnvInt('CARELINK_SGV_LIMIT', 24),
    verbose: !readEnvBool('CARELINK_QUIET', true),
    patientId: readEnvString('CARELINK_PATIENT'),
    countryCode: readEnvString('MMCONNECT_COUNTRYCODE', 'gb')!,
    language: readEnvString('MMCONNECT_LANGCODE', 'en')!,
    staleThresholdMs: readEnvInt('CARELINK_STALE_THRESHOLD_MINUTES', defaultStaleThresholdMinutes) * 60 * 1000,
    staleWebhookUrl: readEnvString('STALE_WEBHOOK_URL'),
  };
}
