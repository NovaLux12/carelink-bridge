export interface CareLinkSG {
  sg: number;
  datetime: string;
  version: number;
  timeChange: boolean;
  kind: 'SG';
  // Per-reading fields from the RecentData payload (#85). sensorState lets a
  // warm-up or calibration-required reading be distinguished from a normal
  // one; relativeOffset is per-reading offset data and the natural input for
  // the whole-hour pump-offset rounding (kept separate from the timestamp
  // semantics — see src/transform/pump-offset.ts).
  sensorState?: string;
  relativeOffset?: number;
}

export interface CareLinkActiveInsulin {
  datetime: string;
  version: number;
  amount: number;
  kind: 'Insulin';
}

export interface CareLinkAlarm {
  type: string;
  version: number;
  flash: boolean;
  datetime: string;
  kind: 'Alarm';
  code: number;
}

export interface CareLinkData {
  sgs: CareLinkSG[];
  lastSG: CareLinkSG;
  lastSGTrend: string;
  currentServerTime: number;
  sMedicalDeviceTime: string;
  lastMedicalDeviceDataUpdateServerTime: number;
  medicalDeviceFamily: string;
  deviceFamily?: string;
  medicalDeviceBatteryLevelPercent: number;
  // Newer NGP-tier pumps report this instead of (or alongside)
  // medicalDeviceBatteryLevelPercent (#82). The reference client prefers it
  // and falls back only when it is 0; this bridge mirrors that precedence
  // (see deviceBatteryPercent() in src/transform/index.ts). INFERRED from
  // the reference client's model — unverified on the wire.
  pumpBatteryLevelPercent?: number;
  conduitBatteryLevel: number;
  conduitBatteryStatus: string;
  conduitInRange: boolean;
  conduitMedicalDeviceInRange: boolean;
  conduitSensorInRange: boolean;
  sensorState: string;
  calibStatus: string;
  sensorDurationHours: number;
  timeToNextCalibHours: number;
  reservoirRemainingUnits?: number;
  reservoirAmount?: number;
  // Percent form of the reservoir, alongside the two units fields (#83).
  // Present in the payload schema; typed here so it is available. The
  // Nightscout `pump.reservoir` output deliberately keeps using the units
  // fields (see below) — the percent is quantised and the units are rounded,
  // so they can disagree slightly, and downstream looping clients read the
  // units value.
  reservoirLevelPercent?: number;
  activeInsulin?: CareLinkActiveInsulin;
  lastAlarm?: CareLinkAlarm;
  bgUnits?: string;
  bgunits?: string;
  timeFormat?: string;
  [key: string]: unknown;
}

export interface CareLinkUserInfo {
  id?: string;
  accountId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  language?: string;
  role: string;
  loginDateUTC?: string;
  cpRegistrationStatus?: string | null;
  accountSuspended?: string | null;
  needToReconsent?: boolean;
  mfaRequired?: boolean;
  mfaEnabled?: boolean;
}

export interface CareLinkPatientLink {
  username: string;
}

export interface CareLinkCountrySettings {
  blePereodicDataEndpoint?: string;
}

export interface LoginData {
  access_token: string;
  refresh_token: string;
  scope?: string;
  client_id: string;
  token_url: string;
  audience?: string;
}

export interface Auth0SSOConfig {
  server: {
    hostname: string;
    port?: number;
    prefix?: string;
  };
  client: {
    client_id: string;
    scope: string;
    audience: string;
    redirect_uri: string;
  };
  system_endpoints: {
    authorization_endpoint_path: string;
    token_endpoint_path: string;
  };
}

export interface DiscoverResponse {
  CP: Array<{
    region: string;
    UseSSOConfiguration?: string;
    Auth0SSOConfiguration?: string;
    /**
     * Which cumulus track this entry points at, as a full base URL, e.g.
     * 'https://clcloud.minimed.eu/connect/carepartner/v13'. Optional in the
     * live shape; the issue-#75 pin guard in src/login-errors.ts fails closed
     * when it is missing.
     */
    baseUrlCumulus?: string;
    [key: string]: unknown;
  }>;
  /**
   * Medtronic's pinned signer list: 8 `{ host, cert }` entries, `cert` being
   * base64 (no PEM armour). Watched by `checkDiscoveryCertificates` in
   * src/discovery.ts (issue #77) as a change tripwire only — it is not, and
   * cannot be, verification of the unknown `x-cum-signature` algorithm.
   */
  certificates?: Array<{ host: string; cert: string }>;
}
