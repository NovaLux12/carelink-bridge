export interface CareLinkSG {
  sg: number;
  /**
   * Legacy reading time. Optional because the `display/message` route sends
   * `timestamp` instead — a reading carries one or the other, not both. The
   * transform prefers `timestamp` and falls back here.
   */
  datetime?: string;
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
  /**
   * Newer payloads (`POST {baseUrlCumulus}/display/message`, the route
   * Instinct-era devices use) carry the reading time as `timestamp` instead
   * of `datetime`, and it is a local-time string with no zone. `datetime`
   * stays the older field; a reading may carry either, so both are optional
   * at the type level even though every payload seen so far has one.
   */
  timestamp?: string;
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
  // Wire form. Paradigm-era pumps send a number (4, 5, 6, 16, 43, 61…);
  // NGP-era pumps (780G, 770G) send either the same numeric form or an
  // "N"-prefixed string ("N24", "N131"…) depending on the deployment.
  // The exact wire form is unverified (issue #84), so the type is widened
  // to accept either and last-alarm.ts normalises both before lookup.
  code: number | string;
}

export interface CareLinkData {
  sgs: CareLinkSG[];
  lastSG: CareLinkSG;
  lastSGTrend: string;
  currentServerTime?: number;
  sMedicalDeviceTime?: string;
  lastMedicalDeviceDataUpdateServerTime: number;
  /**
   * Optional, not required: the BLE / display-message shapes may omit it and
   * carry the family under `deviceFamily` instead. Declaring it required is
   * what let the original crash through with no type error.
   */
  medicalDeviceFamily?: string;
  deviceFamily?: string;
  /**
   * The patient's own IANA time zone, carried by v13 `display/message`
   * payloads inside `patientData`. Readings are local wall-clock strings with
   * no offset, so this is the fallback when the device/server clock delta that
   * `pump-offset.ts` uses is unavailable — which is the case for that route,
   * since it does not send `sMedicalDeviceTime` or `currentServerTime`.
   */
  clientTimeZoneName?: string;
  /**
   * Duration fields, minutes spellings (xDrip RecentData.java:146-147).
   *
   * CORRECTION to an earlier comment here: `RecentData.java` has **no legacy
   * block**. The generation marker at :79 precedes every instance field, so
   * BOTH `sensorDurationHours` (:112-113) and `sensorDurationMinutes`
   * (:146-147) are in the same, newer declaration block. The split is not
   * "old file vs new file" — it is which of two spellings Medtronic actually
   * sends on a given payload, and `clientTimeZoneName` (:148) is the marker
   * that a payload is the newer display/message shape.
   *
   * Both are declared and the transform prefers whichever is present, because
   * a v13 payload has been reported to send the MINUTES pair while the older
   * responses send HOURS. Reading only one would silently write `undefined` for
   * sensor age.
   */
  sensorDurationMinutes?: number;
  timeToNextCalibrationMinutes?: number;
  /** Newer-payload sensor/loop flags. Not yet surfaced downstream. */
  gstCommunicationState?: boolean;
  gstBatteryLevel?: number;
  averageSGFloat?: number;
  calFreeSensor?: boolean;
  finalCalibration?: boolean;
  /** Pump suspension flag (RecentData.java:120). Not surfaced downstream. */
  medicalDeviceSuspended?: boolean;
  /**
   * The conduit clock pair (RecentData.java:80 `lastConduitUpdateServerDateTime`
   * and :143 `lastConduitDateTime`).
   *
   * xDrip's v13 path (`correctTimeInDisplayMessage`) derives its correction
   * from THESE, not from `sMedicalDeviceTime`/`currentServerTime`:
   *
   *   diffInHour = round((lastConduitUpdateServerDateTime - lastConduitDateTime) / 3600000)
   *
   * Note `lastConduitDateTime` carries a custom deserializer
   * (`@JsonAdapter(CareLinkJsonAdapter.class)`) — one of only two annotated
   * fields in the whole contract — so its wire form is not a plain ISO string.
   */
  lastConduitDateTime?: string | number;
  lastConduitUpdateServerDateTime?: number;
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
