import { describe, it, expect } from 'vitest';
import { CareLinkClient } from '../src/carelink/client.js';

/**
 * `CARELINK_DATA_PATH=auto` tries display/message first, then the legacy
 * chain. If BOTH fail, the operator must be able to see why the NEW route
 * failed — that is the whole point of validation day. Reporting only the
 * legacy error hides it.
 *
 * Equally important: the thrown error must remain the legacy one, WITH its
 * `response.status` intact. The retry policy and circuit breaker key off that
 * status (401/403 trigger a refresh, 429 honours Retry-After), so wrapping it
 * in a fresh Error would silently disable both.
 */
function client(mode: string) {
  const c = new CareLinkClient({
    username: 'u', password: 'p', server: 'EU', dataPath: mode,
  }) as any;

  const legacyError: any = new Error('legacy boom');
  legacyError.response = { status: 404 };

  c.axiosInstance = {
    defaults: { headers: { common: {} } },
    get: async (url: string) => {
      if (url.includes('/patient/users/me')) {
        return { status: 200, data: { username: 'u', role: 'PATIENT' } };
      }
      // Discovery fails → display/message cannot even resolve a base URL.
      if (url.includes('/discover/')) throw new Error('discovery unreachable');
      if (url.includes('/patient/monitor/data')) return { status: 200, data: {} };
      if (url.includes('/patient/connect/data')) throw legacyError;
      throw new Error('unexpected ' + url);
    },
    post: async () => { throw new Error('display/message 204'); },
  };
  return c;
}

describe('auto mode diagnostics', () => {
  it('reports the display/message failure alongside the legacy one', async () => {
    const c = client('auto');
    await expect(c.getConnectData()).rejects.toThrow(/display\/message also failed/);
  });

  it('preserves response.status so retry and circuit-breaker still work', async () => {
    const c = client('auto');
    try {
      await c.getConnectData();
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.response?.status).toBe(404);
    }
  });

  it('points the operator at the mode that isolates the new route', async () => {
    const c = client('auto');
    await expect(c.getConnectData()).rejects.toThrow(/CARELINK_DATA_PATH=cumulus/);
  });

  it('does not annotate when cumulus mode was never attempted', async () => {
    const c = client('legacy');
    await expect(c.getConnectData()).rejects.toThrow('legacy boom');
    await expect(c.getConnectData()).rejects.not.toThrow(/display\/message also failed/);
  });
});
