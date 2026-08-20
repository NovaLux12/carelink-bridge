/**
 * Minimal structured logger for carelink-bridge.
 *
 * Two output modes, controlled by LOG_FORMAT (env or setLogFormat):
 *  - "pretty" (default): human-readable `Date + args` via console.log, gated by verbose.
 *  - "json" (opt-in):   one JSON object per line: { ts, level, msg, ...fields }.
 *
 * Zero dependencies. ~60 lines. v0.4.0 observability slice (issue #10) — small
 * safe increment: no transport, no file, no PII. Callers pass only non-secret
 * fields; keys matching /secret|password|token/i are redacted to [REDACTED].
 */

let verbose = false;

export type LogFormat = 'json' | 'pretty';

function initialFormat(): LogFormat {
  return process.env['LOG_FORMAT'] === 'json' ? 'json' : 'pretty';
}

let logFormat: LogFormat = initialFormat();

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function setLogFormat(f: string): void {
  if (f === 'json' || f === 'pretty') logFormat = f;
}

export function getLogFormat(): LogFormat {
  return logFormat;
}

const SENSITIVE_KEY = /(secret|password|token|api_secret)/i;

function redactFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

function emitJson(level: string, msg: string, fields?: Record<string, unknown>): void {
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...redactFields(fields),
  };
  console.log(JSON.stringify(rec));
}

function emitPretty(level: string, msg: string, fields?: Record<string, unknown>): void {
  const suffix = fields && Object.keys(fields).length > 0 ? ' ' + JSON.stringify(redactFields(fields)) : '';
  // Keep the existing Date-prefix shape so journalctl/grep keep working.
  console.log(new Date(), `[${level}] ${msg}${suffix}`);
}

/** Legacy verbose-gated log — preserved for backward compatibility. */
export function log(...args: unknown[]): void {
  if (!verbose) return;
  if (logFormat === 'json') {
    emitJson('info', args.map(String).join(' '));
  } else {
    console.log(new Date(), ...args);
  }
}

/** Structured info — also verbose-gated (quiet by default). */
export function info(msg: string, fields?: Record<string, unknown>): void {
  if (!verbose) return;
  if (logFormat === 'json') emitJson('info', msg, fields);
  else emitPretty('info', msg, fields);
}

/** Structured warn — always visible (not verbose-gated). */
export function warn(msg: string, fields?: Record<string, unknown>): void {
  if (logFormat === 'json') emitJson('warn', msg, fields);
  else emitPretty('warn', msg, fields);
}

/** Structured error — always visible. */
export function error(msg: string, fields?: Record<string, unknown>): void {
  if (logFormat === 'json') emitJson('error', msg, fields);
  else emitPretty('error', msg, fields);
}
