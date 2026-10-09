/**
 * Minimal structured logger for carelink-bridge.
 *
 * Two output modes, controlled by LOG_FORMAT (env or setLogFormat):
 *  - "pretty" (default): human-readable `Date + args` via console.log, gated by verbose.
 *  - "json" (opt-in):   one JSON object per line: { ts, level, msg, ...fields }.
 *
 * Zero dependencies. v0.4.0 observability slice (issue #10) — small safe
 * increment: no transport, no file. Keys whose names look credential-bearing
 * (see SENSITIVE_KEY) are redacted to [REDACTED], at any nesting depth.
 * That is best-effort defence, not a guarantee: it matches on KEY NAMES, so a
 * credential pasted into an innocuously-named field (`{ note: token }`) still
 * reaches the log. Callers must not do that.
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

// Credential-looking KEY NAMES, whose values are replaced with [REDACTED]
// (#88). This is name matching, not content inspection, and it is bounded —
// see the caveats on redactValue below. Covers the
// Authorization header spelling the codebase itself sets
// (client.ts: `defaults.headers.common['Authorization']`), plus common
// credential/key/bearer/cookie spellings alongside the original four.
// CareLink sessions are cookie-based, so cookie spellings are in scope too.
// Verified against every key the codebase actually logs: none over-matches.
const SENSITIVE_KEY =
  /(secret|password|passwd|token|authorization|api[_-]?key|bearer|credentials?|cookie)/i;

// Depth cap for the recursive walk. Real payloads (an axios error, a monitor
// response) nest a handful of levels; 100 is far beyond anything legitimate and
// still well inside the JS stack. Without a cap, a self-nesting object throws
// RangeError out of the logger — fatal, because the throw often happens inside
// an error handler.
const MAX_DEPTH = 100;

/**
 * Walk a value, redacting sensitive keys at any depth.
 *
 * `onStack` holds the ancestors of the CURRENT path only — not every object
 * ever visited. That distinction matters: a shared reference (the same object
 * appearing twice as siblings) is legitimate data and is rendered twice,
 * whereas a true cycle (an object reachable from itself) would otherwise
 * recurse forever. Ancestors are removed on the way out via finally, so
 * siblings never see each other.
 */
function redactValue(value: unknown, onStack: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;

  // A logger must not blow the stack on pathological input, and callers include
  // error handlers that must keep running. Real payloads nest a handful deep;
  // anything past MAX_DEPTH is a bug or an attack, not data worth rendering.
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';

  if (onStack.has(value)) return '[CIRCULAR]';
  onStack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, onStack, depth + 1));
    }

    // Typed arrays and Buffers expose hundreds of own index keys, so recursing
    // would turn a Buffer into {"0":117,"1":115,...}. Buffer has its own toJSON
    // that emits only {type,data}, so it can be handed to JSON.stringify intact.
    if (ArrayBuffer.isView(value)) {
      // A BARE typed array (Uint8Array, Float64Array, ...) has no toJSON, so
      // JSON.stringify serialises every own enumerable property — including a
      // named one someone attached to it. "Index keys carry no field names" is
      // only true of the indices; any NON-index own key is a normal field and
      // has to be redacted like one.
      const named = Object.keys(value).filter((k) => !/^\d+$/.test(k));
      if (named.length === 0) return value;
      const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
      for (let i = 0; i < (value as unknown as ArrayLike<unknown>).length; i++) {
        out[i] = (value as unknown as ArrayLike<unknown>)[i];
      }
      for (const k of named) {
        const v = (value as unknown as Record<string, unknown>)[k];
        out[k] = SENSITIVE_KEY.test(k)
          ? '[REDACTED]'
          : typeof v === 'function'
            ? undefined
            : redactValue(v, onStack, depth + 1);
      }
      return out;
    }

    // Only own enumerable keys are considered, and NO prototype check is done.
    // A prototype identity test looks tidier but is a hole: an object from
    // another realm (vm/iframe) has a different Object.prototype and would sail
    // straight past it, and a class instance can hold a credential in a plain
    // own field just as easily. Both are redacted here instead.
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      return '[UNREADABLE]'; // exotic Proxy with a throwing ownKeys trap
    }

    if (keys.length === 0) {
      // No own keys: usually Date, Error, Map, Set — pass through so
      // JSON.stringify renders them properly.
      //
      // BUT a `toJSON` inherited from the prototype is still invoked by
      // JSON.stringify AFTER this walk, and it can return anything at all:
      //   class Session { #token = SECRET; toJSON() { return { token: this.#token }; } }
      // has zero own keys and would hand the secret straight to the log. An own
      // toJSON cannot reach here (the function-drop below removes it), so this
      // is the only place that check has to happen.
      //
      // The read itself is guarded: `toJSON` may be a throwing getter, and this
      // is the one property access outside the per-key loop below.
      let toJSON: unknown;
      try {
        toJSON = (value as { toJSON?: unknown }).toJSON;
      } catch {
        return '[UNREADABLE]';
      }
      if (typeof toJSON !== 'function') return value;
      // Date's own toJSON is the one inherited toJSON that is safe to keep: a
      // fixed formatter over a numeric timestamp that can only ever emit an ISO
      // string. Everything else is replaced.
      return toJSON === Date.prototype.toJSON ? value : '[TOJSON_STRIPPED]';
    }

    const out: Record<string, unknown> = {};
    for (const k of keys) {
      let v: unknown;
      try {
        v = (value as Record<string, unknown>)[k];
      } catch {
        // A throwing getter must not take the whole log line down with it.
        out[k] = '[UNREADABLE]';
        continue;
      }
      // Functions are dropped rather than redacted: `JSON.stringify` invokes
      // `toJSON` AFTER this walk, so an own toJSON would otherwise both
      // re-introduce the secret and replace the {ts, level, msg} envelope.
      if (typeof v === 'function') continue;
      const redacted =
        SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, onStack, depth + 1);
      // defineProperty, not assignment: a key literally named `__proto__`
      // would otherwise set the prototype and then vanish from the output.
      Object.defineProperty(out, k, {
        value: redacted,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    onStack.delete(value);
  }
}

/**
 * JSON.stringify can still throw on data that survived redaction — BigInt is
 * the realistic case, since a logger must never propagate an exception into
 * its caller and the callers include error handlers whose whole job is to keep
 * running. The caller supplies the envelope separately so that a stringify
 * failure degrades the FIELD PAYLOAD, never the {ts, level, msg} record: an
 * operator who sees a bare `log_stringify_error` with no level and no message
 * cannot triage the incident, which is the one moment the log matters most.
 */
function stringifyFields(envelope: Record<string, unknown>, payload: unknown): string {
  try {
    return JSON.stringify({ ...envelope, ...(payload as Record<string, unknown>) });
  } catch {
    try {
      return JSON.stringify({ ...envelope, log_stringify_error: true });
    } catch {
      // Last resort: envelope values themselves are unserialisable.
      return JSON.stringify({ level: envelope['level'], msg: envelope['msg'] });
    }
  }
}

function redactFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out = redactValue(fields, new WeakSet<object>());
  // redactValue can legitimately return a non-object for a container-shaped
  // input — e.g. '[TOJSON_STRIPPED]' for a proxy or a #private-field class.
  // Callers spread this into a record, so a string here would silently become
  // a per-character index map. Coerce rather than let that happen.
  return out !== null && typeof out === 'object' ? (out as Record<string, unknown>) : {};
}

function emitJson(level: string, msg: string, fields?: Record<string, unknown>): void {
  const envelope: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
  console.log(stringifyFields(envelope, redactFields(fields) ?? {}));
}

function emitPretty(level: string, msg: string, fields?: Record<string, unknown>): void {
  const redacted = redactFields(fields);
  const suffix =
    redacted && Object.keys(redacted).length > 0 ? ' ' + stringifyFields({}, redacted) : '';
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
