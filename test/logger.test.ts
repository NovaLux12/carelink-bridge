import { runInNewContext } from 'node:vm';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as logger from '../src/logger.js';

/**
 * src/logger.ts had zero direct coverage (#88). These pin the redaction
 * redaction contract documented in USER-GUIDE, in both formats.
 */
function capture(fn: () => void): string[] {
  const captured: string[] = [];
  const orig = console.log;
  (console as unknown as { log: (...a: unknown[]) => void }).log = (...a: unknown[]) => {
    captured.push(a.map((x) => String(x)).join(' '));
  };
  try {
    fn();
  } finally {
    (console as unknown as { log: typeof console.log }).log = orig;
  }
  return captured;
}

beforeEach(() => {
  logger.setVerbose(true);
  logger.setLogFormat('json');
});
afterEach(() => {
  logger.setLogFormat('pretty');
});

describe('redaction', () => {
  it('redacts every sensitive key spelling', () => {
    const [line] = capture(() =>
      logger.warn('m', {
        api_secret: 'a',
        password: 'p',
        token: 't',
        refresh_token: 'r',
        secretKey: 's',
        Authorization: 'Bearer xyz',
        bearer: 'b',
        credentials: 'c',
        'api-key': 'k',
      }),
    );
    const rec = JSON.parse(line);
    for (const k of Object.keys(rec)) {
      if (['ts', 'level', 'msg'].includes(k)) continue;
      expect(rec[k], k).toBe('[REDACTED]');
    }
  });

  it('redacts nested objects at any depth', () => {
    const [line] = capture(() =>
      logger.warn('m', { headers: { Authorization: 'Bearer xyz' }, deep: { d: { token: 't' } } }),
    );
    const rec = JSON.parse(line);
    expect(rec.headers).toEqual({ Authorization: '[REDACTED]' });
    expect(rec.deep).toEqual({ d: { token: '[REDACTED]' } });
  });

  it('redacts inside arrays and survives cycles', () => {
    const cycle: Record<string, unknown> = { password: 'p' };
    cycle.self = cycle;
    const [line] = capture(() =>
      logger.warn('m', { items: [{ token: 't' }, 'ok'], cycle }),
    );
    const rec = JSON.parse(line);
    expect(rec.items).toEqual([{ token: '[REDACTED]' }, 'ok']);
    expect(rec.cycle).toEqual({ password: '[REDACTED]', self: '[CIRCULAR]' });
  });

  it('redacts the passwd/cookie spellings too', () => {
    const [line] = capture(() =>
      logger.warn('m', { passwd: 'p', cookie: 'c', session_cookie: 'c2' }),
    );
    const rec = JSON.parse(line);
    for (const k of Object.keys(rec)) {
      if (['ts', 'level', 'msg'].includes(k)) continue;
      expect(rec[k], k).toBe('[REDACTED]');
    }
  });

  it('renders a SHARED reference twice — that is not a cycle', () => {
    const shared = { token: 't', n: 1 };
    const [line] = capture(() => logger.warn('m', { a: shared, b: shared }));
    const rec = JSON.parse(line);
    expect(rec.a).toEqual({ token: '[REDACTED]', n: 1 });
    expect(rec.b).toEqual({ token: '[REDACTED]', n: 1 });
    expect(JSON.stringify(rec)).not.toContain('CIRCULAR');
  });

  it('keeps array-of-array shape instead of flattening to objects', () => {
    const [line] = capture(() =>
      logger.warn('m', { m: [[{ token: 'x' }]], n: [[1, 2], [3]] }),
    );
    const rec = JSON.parse(line);
    expect(rec.m).toEqual([[{ token: '[REDACTED]' }]]);
    expect(rec.n).toEqual([[1, 2], [3]]);
  });

  it('survives a cycle routed through an array', () => {
    const inner: Record<string, unknown> = { token: 't' };
    const arr: unknown[] = [inner];
    (inner as Record<string, unknown>)['back'] = arr;
    const [line] = capture(() => logger.warn('m', { arr }));
    const rec = JSON.parse(line);
    expect(rec.arr[0].token).toBe('[REDACTED]');
    expect(rec.arr[0].back).toBe('[CIRCULAR]');
  });

  it('passes non-plain objects through instead of destroying them', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const [line] = capture(() => logger.warn('m', { at: d }));
    expect(JSON.parse(line).at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles deep nesting without overflowing the stack', () => {
    // Within the cap: fully walked, so the secret at the bottom IS redacted.
    let ok: Record<string, unknown> = { token: 't' };
    for (let i = 0; i < 40; i++) ok = { n: ok };
    const [fine] = capture(() => logger.warn('m', { deep: ok }));
    expect(fine).not.toContain('"token":"t"');
    expect(fine).toContain('[REDACTED]');

    // Past the cap: truncated rather than throwing. A RangeError escaping here
    // would be fatal, because warn() is called from error handlers.
    let huge: Record<string, unknown> = { token: 't' };
    for (let i = 0; i < 50000; i++) huge = { n: huge };
    let line = '';
    expect(() => {
      line = capture(() => logger.warn('m', { deep: huge }))[0];
    }).not.toThrow();
    expect(line).toContain('[MAX_DEPTH]');
    expect(line).not.toContain('"token":"t"');
    // envelope survives even the truncation
    expect(JSON.parse(line).level).toBe('warn');
  });

  it('strips an INHERITED toJSON — the private-field class leak', () => {
    // Zero own keys (the secret is a #private field), and the prototype toJSON
    // is invoked by JSON.stringify AFTER redaction walks the object.
    class Session {
      #token = 'SUPERSECRETVALUE123';
      toJSON() {
        return { token: this.#token };
      }
    }
    const [line] = capture(() => logger.warn('m', { sess: new Session() }));
    expect(line).not.toContain('SUPERSECRETVALUE123');
    expect(JSON.parse(line).sess).toBe('[TOJSON_STRIPPED]');
  });

  it('strips an inherited toJSON one level deep too', () => {
    class Inner {
      #t = 'DEEPSECRET';
      toJSON() {
        return { token: this.#t };
      }
    }
    const [line] = capture(() => logger.warn('m', { outer: { inner: new Inner() } }));
    expect(line).not.toContain('DEEPSECRET');
  });

  it('keeps Date rendering (its inherited toJSON is safe)', () => {
    const [line] = capture(() => logger.warn('m', { at: new Date('2026-01-01T00:00:00.000Z') }));
    expect(JSON.parse(line).at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not mangle Buffer or typed arrays into index maps', () => {
    const [line] = capture(() => logger.warn('m', { buf: Buffer.from('us') }));
    expect(JSON.parse(line).buf).toEqual({ type: 'Buffer', data: [117, 115] });
  });

  it('redacts a NON-index key attached to a bare typed array', () => {
    // A bare Uint8Array has no toJSON, so JSON.stringify serialises every own
    // enumerable property — a named one attached to it would leak verbatim.
    const arr = new Uint8Array([1, 2]) as unknown as Record<string, unknown>;
    arr['api_token'] = 'SUPER_SECRET_VALUE_zzz';
    const [line] = capture(() => logger.warn('m', { arr }));
    expect(line).not.toContain('SUPER_SECRET_VALUE_zzz');
    expect(JSON.parse(line).arr.api_token).toBe('[REDACTED]');
    expect(JSON.parse(line).arr['0']).toBe(1);

    const f = new Float64Array([1]) as unknown as Record<string, unknown>;
    f['nested'] = { token: 'SUPER_SECRET_VALUE_zzz' };
    const [l2] = capture(() => logger.warn('m', { f }));
    expect(l2).not.toContain('SUPER_SECRET_VALUE_zzz');
    expect(JSON.parse(l2).f.nested).toEqual({ token: '[REDACTED]' });
  });

  it('does not throw when a toJSON getter throws', () => {
    // The one property read outside the per-key loop; still must not escape.
    const hostile = Object.create({
      get toJSON(): never {
        throw new Error('LOGGER-TRAP');
      },
    });
    let lines: string[] = [];
    expect(() => {
      lines = capture(() => logger.warn('m', { s: hostile }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[UNREADABLE]');
  });

  it('does not degrade a container-shaped field into a character map', () => {
    // redactFields() can return '[TOJSON_STRIPPED]'; a bare spread of that would
    // emit {"0":"[","1":"T",...}. Asserted in BOTH formats, since the two
    // emitters render fields differently.
    class Empty {
      #t = 'SUPERSECRET';
      toJSON() {
        return { token: this.#t };
      }
    }
    logger.setLogFormat('pretty');
    const [pretty] = capture(() => logger.warn('obj-arg', new Empty() as never));
    expect(pretty).not.toContain('"0":"["');
    expect(pretty).not.toContain('SUPERSECRET');
    expect(pretty).toContain('[warn] obj-arg');

    logger.setLogFormat('json');
    const [json] = capture(() => logger.warn('obj-arg', new Empty() as never));
    expect(json).not.toContain('"0":"["');
    expect(json).not.toContain('SUPERSECRET');
    expect(JSON.parse(json).msg).toBe('obj-arg');
    expect(JSON.parse(json).level).toBe('warn');
  });

  it('survives a Proxy whose ownKeys throws (exercised, not incidental)', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('LOGGER-TRAP');
        },
      },
    );
    let lines: string[] = [];
    expect(() => {
      lines = capture(() => logger.warn('m', { hostile }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[UNREADABLE]');
  });

  it('keeps the envelope when the payload cannot be stringified', () => {
    let lines: string[] = [];
    expect(() => {
      lines = capture(() => logger.warn('important-context', { big: BigInt(7) }));
    }).not.toThrow();
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('warn');
    expect(rec.msg).toBe('important-context');
    expect(typeof rec.ts).toBe('string');
    expect(rec.log_stringify_error).toBe(true);
  });

  it('log() is verbose-gated and does NOT redact positional args', () => {
    // Pinned deliberately. log() takes positional values, not a fields object,
    // so key-name redaction cannot apply to it — upload.ts / main.ts /
    // client.ts / last-alarm.ts all use it. In pretty mode the object reaches
    // console.log untouched; in JSON mode args are String()-joined, which
    // reduces an object to "[object Object]" and so cannot leak its keys.
    logger.setVerbose(false);
    expect(capture(() => logger.log('quiet'))).toHaveLength(0);
    logger.setVerbose(true);
    const [jsonLine] = capture(() => logger.log('POST', { token: 'positional' }));
    expect(jsonLine).toContain('POST');
    expect(jsonLine).not.toContain('[REDACTED]');
    logger.setLogFormat('pretty');
    const [prettyLine] = capture(() => logger.log('POST', { token: 'positional' }));
    expect(prettyLine).not.toContain('[REDACTED]');
  });

  it('redacts inside a class instance (no prototype check to slip past)', () => {
    class Svc {
      apiKey = 'k123';
      label = 'ok';
      secret = 'nope';
    }
    const [line] = capture(() => logger.warn('m', { svc: new Svc() }));
    const rec = JSON.parse(line);
    expect(rec.svc).toEqual({ apiKey: '[REDACTED]', label: 'ok', secret: '[REDACTED]' });
    expect(line).not.toContain('k123');
  });

  it('redacts inside a cross-realm object (foreign Object.prototype)', () => {
    // A prototype identity test would let this straight through.
    const foreign = runInNewContext('({ token: "realm-secret", ok: 1 })') as Record<
      string,
      unknown
    >;
    const [line] = capture(() => logger.warn('m', { foreign }));
    expect(line).not.toContain('realm-secret');
    expect(JSON.parse(line).foreign).toEqual({ token: '[REDACTED]', ok: 1 });
  });

  it('strips toJSON so it cannot re-introduce a secret or eat the envelope', () => {
    const hostile = {
      token: 'raw-secret',
      toJSON: () => ({ token: 'raw-secret' }),
    };
    const [line] = capture(() => logger.warn('m', { hostile }));
    expect(line).not.toContain('raw-secret');
    const rec = JSON.parse(line);
    expect(rec.level).toBe('warn');
    expect(rec.msg).toBe('m');
    expect(rec.hostile).toEqual({ token: '[REDACTED]' });
  });

  it('does not throw when a getter throws — the line still comes out', () => {
    const booby = {
      get bad() {
        throw new Error('LOGGER-TRAP');
      },
      token: 't',
    };
    let lines: string[] = [];
    expect(() => {
      lines = capture(() => logger.warn('m', { booby }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).booby).toEqual({ bad: '[UNREADABLE]', token: '[REDACTED]' });
  });

  it('does not throw on data JSON.stringify cannot handle (BigInt)', () => {
    let lines: string[] = [];
    expect(() => {
      lines = capture(() => logger.warn('m', { big: BigInt(7) }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('log_stringify_error');
  });

  it('keeps a key literally named __proto__ as data, and pollutes nothing', () => {
    const hostile = JSON.parse('{"__proto__":{"token":"t"},"a":1}') as Record<string, unknown>;
    const [line] = capture(() => logger.warn('m', hostile));
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(rec, '__proto__')).toBe(true);
    expect(rec.a).toBe(1);
    expect(line).not.toContain('"token":"t"');
    expect(({} as Record<string, unknown>)['token']).toBeUndefined();
  });

  it('does not redact benign fields', () => {
    const [line] = capture(() =>
      logger.warn('m', { username: 'u', component: 'bridge', count: 3 }),
    );
    const rec = JSON.parse(line);
    expect(rec.username).toBe('u');
    expect(rec.component).toBe('bridge');
    expect(rec.count).toBe(3);
  });

  it('redacts identically in pretty format', () => {
    logger.setLogFormat('pretty');
    const [line] = capture(() =>
      logger.warn('careful', { Authorization: 'Bearer xyz', nested: { token: 't' } }),
    );
    expect(line).toContain('"Authorization":"[REDACTED]"');
    expect(line).toContain('"token":"[REDACTED]"');
    expect(line).not.toContain('Bearer xyz');
  });
});

describe('gating and shape', () => {
  it('info is silent when quiet, warn/error always emit', () => {
    logger.setVerbose(false);
    expect(capture(() => logger.info('x'))).toHaveLength(0);
    expect(capture(() => logger.warn('x'))).toHaveLength(1);
    expect(capture(() => logger.error('x'))).toHaveLength(1);
  });

  it('emits the documented JSON record shape', () => {
    const [line] = capture(() => logger.warn('hello', { a: 1 }));
    const rec = JSON.parse(line);
    expect(typeof rec.ts).toBe('string');
    expect(rec.level).toBe('warn');
    expect(rec.msg).toBe('hello');
    expect(rec.a).toBe(1);
  });
});
