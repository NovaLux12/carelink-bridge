import { describe, it, expect, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import {
  cumulusBaseUrlFrom,
  unwrapDisplayMessage,
  fetchDisplayMessage,
  CumulusHttpError,
} from '../src/carelink/cumulus.js';
import type { DiscoverResponse, CareLinkData } from '../src/types/carelink.js';

const DISCOVERY: DiscoverResponse = {
  CP: [
    { region: 'eu', baseUrlCumulus: 'https://clcloud.minimed.eu/connect/carepartner/v13' },
    { region: 'us', baseUrlCumulus: 'https://clcloud.minimed.com/connect/carepartner/v13/' },
  ],
};

function flatPayload(overrides: Partial<CareLinkData> = {}): CareLinkData {
  return {
    sgs: [],
    lastSG: { sg: 120, datetime: 'Oct 20, 2025 11:00:00', version: 1, timeChange: false, kind: 'SG' },
    lastSGTrend: 'FLAT',
    currentServerTime: 1760961600000,
    sMedicalDeviceTime: 'Oct 20, 2025 11:00:00',
    lastMedicalDeviceDataUpdateServerTime: 1760961540000,
    medicalDeviceFamily: 'INSTINCT',
    medicalDeviceBatteryLevelPercent: 80,
    conduitBatteryLevel: 80,
    conduitBatteryStatus: 'FULL',
    conduitInRange: true,
    conduitMedicalDeviceInRange: true,
    conduitSensorInRange: true,
    sensorState: 'NORMAL',
    calibStatus: 'LESS_THAN_TWELVE_HRS',
    sensorDurationHours: 10,
    timeToNextCalibHours: 0,
    ...overrides,
  } as CareLinkData;
}

describe('cumulusBaseUrlFrom', () => {
  it('picks the regional entry and trims a trailing slash', () => {
    expect(cumulusBaseUrlFrom(DISCOVERY, 'us')).toBe(
      'https://clcloud.minimed.com/connect/carepartner/v13',
    );
    expect(cumulusBaseUrlFrom(DISCOVERY, 'eu')).toBe(
      'https://clcloud.minimed.eu/connect/carepartner/v13',
    );
  });

  it('is case-insensitive on the region key', () => {
    const doc: DiscoverResponse = { CP: [{ region: 'EU', baseUrlCumulus: 'https://x/v13' }] };
    expect(cumulusBaseUrlFrom(doc, 'eu')).toBe('https://x/v13');
  });

  it('returns undefined when the region or the field is missing', () => {
    expect(cumulusBaseUrlFrom({ CP: [] }, 'eu')).toBeUndefined();
    expect(cumulusBaseUrlFrom({ CP: [{ region: 'eu' }] }, 'eu')).toBeUndefined();
    expect(cumulusBaseUrlFrom(undefined, 'eu')).toBeUndefined();
  });
});

describe('unwrapDisplayMessage', () => {
  it('unwraps patientData when the newer envelope is used', () => {
    const inner = flatPayload({ sgs: [] });
    const result = unwrapDisplayMessage({ patientData: inner, metadata: { version: 13 } }, 200);
    expect(result.medicalDeviceFamily).toBe('INSTINCT');
  });

  it('accepts the flat RecentData shape unchanged', () => {
    const flat = flatPayload();
    const result = unwrapDisplayMessage(flat, 200);
    expect(result.medicalDeviceFamily).toBe('INSTINCT');
  });

  it('sorts sgs ascending by time (the wire order is not chronological)', () => {
    const sgs = [
      { sg: 130, datetime: 'Oct 20, 2025 11:10:00', version: 1, timeChange: false, kind: 'SG' as const },
      { sg: 110, datetime: 'Oct 20, 2025 11:00:00', version: 1, timeChange: false, kind: 'SG' as const },
      { sg: 120, datetime: 'Oct 20, 2025 11:05:00', version: 1, timeChange: false, kind: 'SG' as const },
    ];
    const result = unwrapDisplayMessage(flatPayload({ sgs }), 200);
    expect(result.sgs.map((s) => s.sg)).toEqual([110, 120, 130]);
  });

  it('sorts on `timestamp` when the newer reading shape is used', () => {
    const sgs = [
      { sg: 130, timestamp: '2025-10-20T11:10:00', version: 1, timeChange: false, kind: 'SG' as const },
      { sg: 110, timestamp: '2025-10-20T11:00:00', version: 1, timeChange: false, kind: 'SG' as const },
    ];
    const result = unwrapDisplayMessage(flatPayload({ sgs }), 200);
    expect(result.sgs.map((s) => s.sg)).toEqual([110, 130]);
  });

  it('explains HTTP 204 as wrong role / patientId rather than "no data"', () => {
    expect(() => unwrapDisplayMessage(undefined, 204)).toThrow(CumulusHttpError);
    expect(() => unwrapDisplayMessage(undefined, 204)).toThrow(/204.*wrong role/i);
  });

  it('explains the 206 "Upgrade application" rejection', () => {
    // This is the exact body the reference client records for a missing
    // appVersion/os in the request body.
    expect(() => unwrapDisplayMessage({ message: 'Upgrade application' }, 206)).toThrow(
      /Upgrade application/,
    );
  });

  it('does not mistake a metadata-only envelope for data', () => {
    expect(() => unwrapDisplayMessage({ message: 'Upgrade application' }, 206)).toThrow(
      CumulusHttpError,
    );
  });
});

describe('fetchDisplayMessage', () => {
  function mockHttp(post: ReturnType<typeof vi.fn>): AxiosInstance {
    return { post } as unknown as AxiosInstance;
  }

  it('sends username, role, appVersion and os in the BODY', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: flatPayload() });
    await fetchDisplayMessage({
      http: mockHttp(post),
      baseUrlCumulus: 'https://clcloud.minimed.eu/connect/carepartner/v13',
      getUser: async () => ({ username: 'jlee', role: 'PATIENT' }) as never,
    });

    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://clcloud.minimed.eu/connect/carepartner/v13/display/message');
    expect(body).toMatchObject({
      username: 'jlee',
      role: 'PATIENT',
      appVersion: '3.8.0',
      os: 'android',
    });
  });

  it('resolves the linked patient for a care-partner account', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: flatPayload() });
    await fetchDisplayMessage({
      http: mockHttp(post),
      baseUrlCumulus: 'https://x/v13',
      getUser: async () => ({ username: 'carer', role: 'CARE_PARTNER_OUS' }) as never,
      getLinkedPatients: async () => [{ username: 'jlee' }],
    });

    expect(post.mock.calls[0][1]).toMatchObject({ patientId: 'jlee', role: 'CARE_PARTNER_OUS' });
  });

  it('sends no patientId for a plain patient account', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: flatPayload() });
    const getLinkedPatients = vi.fn();
    await fetchDisplayMessage({
      http: mockHttp(post),
      baseUrlCumulus: 'https://x/v13',
      getUser: async () => ({ username: 'jlee', role: 'PATIENT' }) as never,
      getLinkedPatients: getLinkedPatients as never,
    });

    expect(post.mock.calls[0][1]).not.toHaveProperty('patientId');
    expect(getLinkedPatients).not.toHaveBeenCalled();
  });

  it('refuses to send a request without a username or role', async () => {
    const post = vi.fn();
    await expect(
      fetchDisplayMessage({
        http: mockHttp(post),
        baseUrlCumulus: 'https://x/v13',
        getUser: async () => ({}) as never,
      }),
    ).rejects.toThrow(/no username/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('appVersion floor (the gate most likely to bite)', () => {
  // Measured against a live account by the reference implementation:
  // <= 3.6.9 -> 206 {"message":"Upgrade application"} and NO data;
  // >= 3.7.0 -> 200 + data. The body field is not a header.
  const FLOOR = '3.7.0';

  function cmp(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  it('the default appVersion is at or above the documented floor', async () => {
    const post = vi.fn().mockResolvedValue({
      status: 200,
      data: flatPayload(),
    });
    await fetchDisplayMessage({
      http: { post } as unknown as AxiosInstance,
      baseUrlCumulus: 'https://x/v13',
      getUser: async () => ({ username: 'u', role: 'PATIENT' }) as never,
    });
    const sent = (post.mock.calls[0][1] as Record<string, string>).appVersion;
    expect(cmp(sent, FLOOR)).toBeGreaterThanOrEqual(0);
  });

  it('honours CARELINK_APP_VERSION when set', async () => {
    const original = process.env['CARELINK_APP_VERSION'];
    process.env['CARELINK_APP_VERSION'] = '3.9.1';
    try {
      const post = vi.fn().mockResolvedValue({ status: 200, data: flatPayload() });
      await fetchDisplayMessage({
        http: { post } as unknown as AxiosInstance,
        baseUrlCumulus: 'https://x/v13',
        getUser: async () => ({ username: 'u', role: 'PATIENT' }) as never,
      });
      expect((post.mock.calls[0][1] as Record<string, string>).appVersion).toBe('3.9.1');
    } finally {
      if (original === undefined) delete process.env['CARELINK_APP_VERSION'];
      else process.env['CARELINK_APP_VERSION'] = original;
    }
  });
});

describe('deterministic sgs ordering', () => {
  // The transform applies the trend arrow to the LAST element and slices the
  // tail for upload, and Nightscout treats the newest entry as authoritative.
  // If equal timestamps leave the order arbitrary, the same payload can
  // produce different "latest" values between runs — unacceptable for a
  // medical feed. Tie-break by sg so ordering is total.
  it('breaks equal-timestamp ties deterministically by value', () => {
    const sgs = [
      { sg: 200, timestamp: '2025-10-20T11:00:00', version: 1, timeChange: false, kind: 'SG' as const },
      { sg: 100, timestamp: '2025-10-20T11:00:00', version: 1, timeChange: false, kind: 'SG' as const },
      { sg: 150, timestamp: '2025-10-20T09:55:00', version: 1, timeChange: false, kind: 'SG' as const },
    ];
    const a = unwrapDisplayMessage(flatPayload({ sgs }), 200);
    const b = unwrapDisplayMessage(flatPayload({ sgs: [...sgs].reverse() }), 200);
    expect(a.sgs.map((s) => s.sg)).toEqual([150, 100, 200]);
    // Same multiset in either input order must yield the same output order.
    expect(b.sgs.map((s) => s.sg)).toEqual([150, 100, 200]);
    expect(a.sgs[a.sgs.length - 1].sg).toBe(b.sgs[b.sgs.length - 1].sg);
  });

  it('is stable across repeated calls on the same payload', () => {
    const sgs = [
      { sg: 111, timestamp: '2025-10-20T11:00:00', version: 1, timeChange: false, kind: 'SG' as const },
      { sg: 222, timestamp: '2025-10-20T11:00:00', version: 1, timeChange: false, kind: 'SG' as const },
    ];
    const first = unwrapDisplayMessage(flatPayload({ sgs }), 200).sgs.map((s) => s.sg);
    const second = unwrapDisplayMessage(flatPayload({ sgs }), 200).sgs.map((s) => s.sg);
    expect(second).toEqual(first);
  });
});
