export interface CareLinkSG {
  sg: number;
  datetime: string;
  version: number;
  timeChange: boolean;
  kind: 'SG';
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
