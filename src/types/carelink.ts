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
  // Per-reading optional fields (#85). `sensorState` lets a warm-up or
  // calibration-required reading be distinguished from a normal one, and is
  // published on the devicestatus `connect` block when present.
  //
  // ⚠ `relativeOffset` does NOT belong here semantically, and reading it here
  // would be wrong. The only source that describes it
  // (`findings-log/probe-2026-10-08/APP-EMULATION-RESEARCH.md`) lists it as a
  // **Marker** field — the treatments schema — not a `SensorGlucose` field; it
  // does not occur in either the patient eager bundle or the lazy chunk that
  // carries the marker parser (searched 2026-11-15, zero hits in both). It is
  // kept declared only because a reading that does carry it should not be
  // silently reshaped to drop the key. Timestamp correction is done once, at
  // payload level, from the conduit/device clock pair in
  // `src/transform/pump-offset.ts` — never per reading — so this field is not
  // an input to it and must not become one without a real captured payload
  // showing what its unit and epoch actually are. See issue #147.
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
   * sensor time remaining.
   *
   * ⚠ These are time REMAINING, not elapsed — do not read them as sensor age.
   * Verified live 2026-11-27; see `sensorHours()` in `transform/index.ts`.
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

  // ---- pump identity, basal and algorithm settings (780G BLE payload) -------
  //
  // All present on a real NGP payload and previously unread. `basal` is the
  // one that changes a delivered-dose statement: without it there is no record
  // of what basal rate was running during any given hour.
  medicalDeviceInformation?: CareLinkMedicalDeviceInformation;
  basal?: CareLinkActiveBasal;
  /** Highest temp/programmed basal the pump will accept, U/hr. */
  maxAutoBasalRate?: number;
  /** Largest single bolus the pump will accept, U. */
  maxBolusAmount?: number;
  /** Mean SG over the pump's own window — mg/dL here even when `bgUnits` says mmol. */
  averageSG?: number;
  /** Pump's own percent-in-range figure. */
  timeInRange?: number;
  /** Thresholds the pump itself uses, in the SAME unit as `sgs[].sg`. */
  sgBelowLimit?: number;
  belowHypoLimit?: number;
  aboveHyperLimit?: number;
  pumpBannerState?: unknown[];
  systemStatusMessage?: string;

  lastAlarm?: CareLinkAlarm;
  /**
   * The pump's own event stream: meals, boluses, fingersticks, calibration,
   * and SmartGuard's own activity. Present on the periodic connect-data
   * response. Mapped to Nightscout treatments by `src/transform/treatments.ts`.
   */
  markers?: CareLinkMarker[];
  /**
   * SmartGuard's auto-mode state. Two nested fields, two disjoint vocabularies:
   *
   *   autoModeShieldState : AUTO_BASAL | SAFE_BASAL | FEATURE_OFF
   *   plgmLgsState        : FEATURE_OFF | REFRACTORY_PERIOD | MONITORING |
   *                         SUSPEND_FIRED_PLGM | SUSPEND_FIRED_LGS
   *
   * `plgmLgsState` is the Predictive-Low-Glucose-Management / Low-Glucose-
   * Suspend state: SUSPEND_FIRED_* means the pump has stopped delivery. Both
   * vocabularies come from the vendor's own client parser
   * (carelink-api-research area DP §3), not from a captured payload — so a
   * value outside these sets is possible and is surfaced rather than dropped.
   */
  therapyAlgorithmState?: CareLinkTherapyAlgorithmState;
  bgUnits?: string;
  bgunits?: string;
  timeFormat?: string;
  [key: string]: unknown;
}

/**
 * One entry of the pump's `markers[]` event stream.
 *
 * `index` is a SLOT, not a timestamp: the real time is
 * `anchor − (287 − index) × 300_000 ms`. See `src/transform/treatments.ts`.
 */
export interface CareLinkMarker {
  index?: number;
  type?: string;
  /** Carbs on a MEAL, units on an INSULIN, glucose on a BG reading. */
  amount?: number;
  value?: number;
  deliverySuspended?: boolean;
  dateTime?: string;

  // ---- INSULIN bolus detail (measured on a real 780G BLE payload) ----------
  //
  // CareLink does NOT put the dose in `amount`/`value` on this route. It
  // arrives as a pair of split amounts, and READING THE WRONG ONE CHANGES THE
  // TREATMENT RECORD. Measured 2026-11-27, index 228:
  //
  //   programmedFastAmount: 4.4   <- what was dialled in
  //   deliveredFastAmount:  1.85  <- what actually went in
  //
  // The pump had stopped delivering partway (the payload also carries
  // `BC_SID_ACTIVE_INSULIN_CLEARED_DUE_PUMP_ERROR`); the bolus was NOT cancelled
  // but 2.55 U never reached him. Recording 4.4 would have overstated IOB by
  // 2.55 U at a moment he was falling, and understated the shortfall afterwards.
  // `delivered*` is the only honest number for an IOB/COB calculation.
  programmedFastAmount?: number;
  deliveredFastAmount?: number;
  programmedExtendedAmount?: number;
  deliveredExtendedAmount?: number;
  /** `FAST`, `EXTENDED` or `COMBO`. Present on every INSULIN marker. */
  bolusType?: string;
  /** `RECOMMENDED` (Bolus Wizard suggested) vs `MANUAL` (user typed it). */
  activationType?: string;
  /** Minutes the extended (square-wave) portion was programmed to run. */
  programmedDuration?: number;
  /** De-duplicating id for the marker across the rolling re-send. */
  id?: number;
  /** Pump's own view: did the bolus run to completion. */
  completed?: boolean;

  // ---- other marker fields observed on the 780G ---------------------------

  /** TIME_CHANGE only: the wall-clock the pump held before the edit. */
  previousDateTime?: string;
  /** AUTO_MODE_STATUS only: SmartGuard's own on/off statement. */
  autoModeOn?: boolean;

  [key: string]: unknown;
}

/**
 * Pump identity, firmware and algorithm settings — ONE nested object on the
 * BLE route. Observed 2026-11-27 on a real 780G; none of it was being read.
 *
 * `softwareRevision` is the load-bearing field: FDA Class 2 recall
 * **Z-2698-2026** covers 780G software **6.62** paired with the Instinct
 * sensor, where the pump stops delivering (Error 53 then 23). The delivered
 * pump reports **6.63V**, i.e. the fix is present. That fact is only knowable
 * from this object, so not reading it means the recall status of the actual
 * hardware in use is invisible to the record.
 */
export interface CareLinkMedicalDeviceInformation {
  manufacturer?: string;
  modelNumber?: string;
  hardwareRevision?: string;
  firmwareRevision?: string;
  softwareRevision?: string;
  systemId?: string;
  pnpId?: string;
  [key: string]: unknown;
}

/**
 * The pump's currently active basal programme.
 *
 * `basalRate` is the programmed rate in U/hr. On a 780G in MANUAL mode this is
 * what is actually running; while SmartGuard is active the algorithm sets
 * delivery and this stays the underlying profile, so it must not be presented
 * as the delivered rate in auto mode — see `pump.autoMode` for which applies.
 */
export interface CareLinkActiveBasal {
  /** Profile name, e.g. `BASAL1`. */
  activeBasalPattern?: string;
  /** U/hr. */
  basalRate?: number;
  [key: string]: unknown;
}

/**
 * SmartGuard auto-mode state. Field names and both vocabularies are OBSERVED in
 * the vendor's own client parser; whether a given pump populates them is not.
 */
export interface CareLinkTherapyAlgorithmState {
  /** `AUTO_BASAL`, `SAFE_BASAL` or `FEATURE_OFF`. */
  autoModeShieldState?: string;
  /** `FEATURE_OFF`, `REFRACTORY_PERIOD`, `MONITORING`, `SUSPEND_FIRED_PLGM`, `SUSPEND_FIRED_LGS`. */
  plgmLgsState?: string;
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
