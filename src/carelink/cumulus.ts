import type { AxiosInstance } from 'axios';
import * as logger from '../logger.js';
import type {
  CareLinkData,
  CareLinkPatientLink,
  CareLinkUserInfo,
  DiscoverResponse,
} from '../types/carelink.js';

/**
 * CareLink "Cumulus" data transport — `POST {baseUrlCumulus}/display/message`.
 *
 * ## Why this exists
 *
 * The bridge's original data paths are `patient/monitor/data`, a POST to the
 * country-settings `blePereodicDataEndpoint`, and the legacy
 * `patient/connect/data?msgType=last24hours`. None of them is the endpoint the
 * current CareLink Connect app actually uses, and community evidence says the
 * newer sensors (Instinct, MiniMed Go) are served only by this one:
 *
 *   - xDrip+ `CareLinkClient.java` hardcodes
 *     `connect/carepartner/v13/display/message` for its "7xxG" branch and
 *     sends `appVersion` in the body (`useNewEndpoint = true` in every region).
 *   - CarlosJPV/carelink-cumulus-bridge documents the same route and records
 *     that without `appVersion` + `os` in the BODY the server answers
 *     `206 {"message":"Upgrade application"}` and never returns data. Header
 *     variants were tried and rejected there.
 *   - The same source reports `HTTP 204` = authenticated but nothing to send
 *     (wrong role or wrong patientId), which is the classic "login works, zero
 *     data" symptom on an Instinct.
 *
 * Those are statements about *other clients*, not about Medtronic. This module
 * copies the observed contract and states its confidence per field.
 *
 * ## Response shape
 *
 * Newer responses nest everything under `patientData`; older ones return the
 * flat `RecentData` shape the rest of this bridge already transforms. Both are
 * accepted. `sgs[]` arrives **unsorted** on this route — sorting here is
 * load-bearing, because `transform()` applies the trend arrow to the LAST
 * element of the array and takes `.slice(-limit)`.
 */

/**
 * App version declared to the server.
 *
 * Two version fields, two different constraints — do not conflate them:
 *
 *   - discovery PATH segment (`/discover/android/{X}`): `3.6`–`3.8` → cumulus
 *     v13; `3.9`+ → legacy v2 config with NO Auth0. Bumping this to "be
 *     current" silently downgrades the API. Pinned separately in discovery.ts.
 *   - request BODY `appVersion`: must be **>= 3.7**; no upper bound. `3.6.9`
 *     and below return `206 {"message":"Upgrade application"}` and no data.
 *
 * xDrip sends `3.8.0`; CarlosJPV sends `3.8`. Both are reported working, so
 * the minor form is not load-bearing — the field's PRESENCE and its floor are.
 * Overridable because this is a server-side gate that can move without notice.
 */
const DEFAULT_APP_VERSION = '3.8.0';

function appVersion(): string {
  const configured = process.env['CARELINK_APP_VERSION']?.trim();
  return configured || DEFAULT_APP_VERSION;
}

/** Android UA the CareLink API expects. Copied from the reference client. */
const ANDROID_UA =
  'Dalvik/2.1.0 (Linux; U; Android 10; Nexus 5X Build/QQ3A.200805.001)';

/** `display/message` envelope (newer shape). */
export interface CumulusResponse {
  metadata?: { kind?: string; version?: number; clientDateTime?: string };
  patientData?: Record<string, unknown>;
}

export class CumulusHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'CumulusHttpError';
  }
}

/**
 * Read the regional `baseUrlCumulus` out of a discovery document.
 *
 * Pure so it can be tested without a network call. Returns undefined when the
 * document has no entry for the region or the entry omits the field — the
 * caller decides whether that is fatal (it is: without it there is no route).
 */
export function cumulusBaseUrlFrom(
  discovery: DiscoverResponse | undefined,
  region: 'us' | 'eu',
): string | undefined {
  const entry = discovery?.CP?.find(
    (c) => typeof c.region === 'string' && c.region.toLowerCase() === region,
  );
  const base = entry?.['baseUrlCumulus'];
  return typeof base === 'string' && base.trim() !== ''
    ? base.trim().replace(/\/+$/, '')
    : undefined;
}

/** A reading's timestamp: newer payloads use `timestamp`, older use `datetime`. */
function readingTime(sg: { timestamp?: string; datetime?: string }): number {
  const raw = sg.timestamp || sg.datetime;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Normalise a `display/message` response into the flat `CareLinkData` shape.
 *
 * - unwraps `patientData` when present
 * - sorts `sgs` ascending by time (the wire order is not chronological)
 *
 * Throws on the two server-side rejections that are otherwise indistinguishable
 * from an empty account:
 *   - `206 {"message": "…"}` without `patientData` → the server refused
 *   - `204` / empty body → authenticated, nothing to send
 */
export function unwrapDisplayMessage(
  raw: unknown,
  status: number,
): CareLinkData {
  const envelope = (raw ?? {}) as CumulusResponse & { message?: string };

  if (status === 204 || raw === undefined || raw === null) {
    throw new CumulusHttpError(
      'HTTP 204 / empty body from display/message — authenticated but no data. ' +
        'Usually the wrong role (a patient account where a care-partner account is expected) ' +
        'or a wrong patientId.',
      status,
      raw,
    );
  }

  if (envelope.message && !envelope.patientData) {
    throw new CumulusHttpError(
      `display/message rejected the request: "${envelope.message}"`,
      status,
      raw,
    );
  }

  const data = (envelope.patientData ?? envelope) as unknown as CareLinkData;

  if (Array.isArray(data.sgs)) {
    // Sort ascending by time. This is load-bearing: transform() applies the
    // trend arrow to the LAST element and takes `.slice(-limit)` from the tail,
    // and Nightscout treats the newest entry as authoritative.
    //
    // Ties are broken by value, deliberately. Two readings can share a
    // timestamp on this route (observed shape, and `sg` is not unique per
    // stamp), and `Array.prototype.sort` is only stable as of ES2019 — the
    // ORDER OF EQUAL ELEMENTS is otherwise implementation-defined. Without a
    // tie-break the last element is arbitrary, so the trend arrow and the
    // "latest" value can land on a different reading between two runs of the
    // same payload. A deterministic order makes the same input always produce
    // the same output, which is the minimum bar for a medical feed.
    data.sgs = [...data.sgs].sort((a, b) => {
      const dt = readingTime(a) - readingTime(b);
      if (dt !== 0) return dt;
      return a.sg - b.sg;
    });
  }
  return data;
}

export interface CumulusTransportDeps {
  /** Axios instance already carrying the bearer token. */
  http: AxiosInstance;
  /** Resolved regional cumulus base, e.g. `https://clcloud.minimed.eu/connect/carepartner/v13`. */
  baseUrlCumulus: string;
  /** Resolves the account identity; the route needs username + role in the body. */
  getUser: () => Promise<CareLinkUserInfo>;
  /** Linked patients, for care-partner accounts. */
  getLinkedPatients?: () => Promise<CareLinkPatientLink[]>;
  /** Override the care-partner patient id (config). */
  patientId?: string;
}

/**
 * Fetch one `display/message` payload.
 *
 * Role is taken from `/users/me`, because the body field must match what
 * CareLink assigned to the account, not a guess from config.
 */
export async function fetchDisplayMessage(
  deps: CumulusTransportDeps,
): Promise<CareLinkData> {
  const user = await deps.getUser();
  const username = user?.username;
  const role = user?.role?.toUpperCase();

  if (!username) {
    throw new Error('display/message: /users/me returned no username');
  }
  if (!role) {
    throw new Error('display/message: /users/me returned no role');
  }

  const isCarePartner =
    role.includes('CARE_PARTNER') || role.includes('CAREPARTNER');

  let patientId = deps.patientId;
  if (isCarePartner && !patientId && deps.getLinkedPatients) {
    const patients = await deps.getLinkedPatients();
    patientId = patients?.[0]?.username;
  }

  const body: Record<string, string> = {
    username,
    role,
    appVersion: appVersion(),
    os: 'android',
  };
  if (patientId) body.patientId = patientId;

  const url = `${deps.baseUrlCumulus}/display/message`;
  logger.log('POST display/message', url);

  const resp = await deps.http.post<CumulusResponse>(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ANDROID_UA,
    },
    // 204/206 are legitimate answers here, not transport failures — the
    // axios default would throw on neither, but the status must reach
    // unwrapDisplayMessage() to be explained properly.
    validateStatus: (s) => s >= 200 && s < 300,
  });

  return unwrapDisplayMessage(resp.data, resp.status);
}
