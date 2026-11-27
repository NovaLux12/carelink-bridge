export interface NightscoutSGVEntry {
  type: 'sgv';
  sgv: number;
  date: number;
  dateString: string;
  device: string;
  direction?: string;
  trend?: number;
}

export interface NightscoutLastAlarmAnnotation {
  // Canonical numeric form for the alarm code. For NGP pumps whose wire
  // form is the "N"-prefixed string ("N24" → 24), this is the parsed number;
  // the original wire form is preserved in `wireCode` when it was a string.
  // Widening `code` to `number | string` was avoided so downstream Nightscout
  // consumers keep a stable numeric shape; the optional `wireCode` is
  // additive and only set when the wire sent a non-numeric form.
  code: number;
  // Original wire form if it was a string (NGP "N24" etc.). Absent for the
  // numeric path so existing consumers see no schema change.
  wireCode?: string;
  datetime: string;
  // Human-readable description from the in-repo code->text table. Always
  // present; for unknown codes, this is "Unknown alarm code <n>" so a
  // reading tool never silently drops an alarm.
  text: string;
  // Severity drives log level and downstream handling. 'stop_using_pump'
  // is load-bearing safety information regardless of any other annotation.
  severity: 'stop_using_pump' | 'delivery_stopped' | 'attention' | 'other';
}

export interface NightscoutDeviceStatus {
  /**
   * Deterministic 24-hex id, so a re-sent devicestatus UPDATES instead of
   * appending. Nightscout's devicestatus `create()` only skips a record whose
   * `_id` is a 24-hex string; with none it runs `insertMany` every POST.
   */
  _id?: string;
  created_at: string;
  /**
   * Epoch milliseconds of the same instant as `created_at`.
   *
   * NOT decorative: Nightscout's IOB plugin reads this exact field.
   * `lib/plugins/iob.js` (v15.0.9) fromDeviceStatus(), pump branch:
   *
   *     iob: iobPump.iob || iobPump.bolusiob,
   *     mills: devicestatusEntry.mills
   *
   * It takes the timestamp from top-level `mills`, NOT from
   * `pump.iob.timestamp`. Omit it and the plugin computes `time - undefined`
   * = NaN and throws away the whole IOB value, however correct the number
   * inside `pump.iob` is — measured as `iob_u: null` on a devicestatus row
   * that carried `pump.iob.bolusiob: 0`.
   */
  mills?: number;
  device: string;
  uploader: {
    battery: number;
  };
  /**
   * CareLink alarm annotation, emitted as `devicestatus.last_alarm`.
   *
   * SCOPE — verified 2026-11-08 against `nightscout/cgm-remote-monitor` @
   * c6a0d8e: **nothing in the Nightscout server or its plugins reads
   * `last_alarm`**. `grep -rn last_alarm` over the repo (excluding
   * node_modules) returns **0 hits**. The plugins read `uploader.battery`
   * (upbat.js:31,70-72), `pump.pump.{clock,reservoir,battery.percent,status}`
   * (pump.js:302-330), `loop.lastOkMoment` (loop.js) and `xdripjs.*`
   * (xdripjs.js:31+). Alarms surface in Nightscout via the SGV/errorcodes path
   * (lib/plugins/errorcodes.js:36-52), not via devicestatus.
   *
   * So this field is PERSISTED AND VISIBLE IN THE RAW API, but it drives no
   * Nightscout UI element or alarm. It is not useless — it makes a pump alarm
   * retrievable from `devicestatus` for any consumer that looks, and the bridge
   * also logs alarms itself — but do not assume a CareLink alarm will produce a
   * Nightscout alarm or a phone notification on its own.
   *
   * CAVEAT: `static/js/client.js` in the repo is a ~255-byte stub, so the real
   * client bundle could not be inspected. A UI reader there cannot be ruled
   * out, only the server and plugin paths can.
   */
  last_alarm?: NightscoutLastAlarmAnnotation;
  pump?: {
    battery: { percent: number };
    reservoir: number | undefined;
    /**
     * Reservoir as the pump's own 5 snap-point percent (0/25/50/75/100).
     * Published so a percent-only payload is not silently `undefined` on
     * `reservoir`; it is NOT a substitute for the units value (research memo
     * §P2.1 — the capacity needed to convert is not in the payload).
     */
    reservoirPercent?: number;
    /**
     * Text Nightscout renders IN THE PUMP PILL in place of its own reservoir
     * string. Read by `lib/plugins/pump.js` updateReservoir():
     *
     *     if (result.reservoir_display_override) {
     *       result.reservoir.display = result.reservoir_display_override;
     *     }
     *
     * Nightscout's default is `value.toPrecision(3) + 'U'` — a bare `256U`,
     * which next to an unlabelled battery percentage reads as two competing
     * numbers. We send `256U · 85%` so both quantities are named by their
     * units and the reader does not have to know the layout to tell which is
     * which.
     */
    reservoir_display_override?: string;
    /**
     * Forces the reservoir pill's COLOUR LEVEL independent of the units value.
     *
     * Nightscout colours the reservoir from `pump.reservoir` against
     * `PUMP_WARN_RES`/`PUMP_URGENT_RES` (10/5 U). That is the right rule for a
     * pump whose reservoir holds 300 U, and it is what we want — so this is
     * left unset deliberately and the stock thresholds apply. Documented here
     * because it is the other half of the same override pair and will be wanted
     * the moment a 300 U reservoir needs different bands from a 180 U one.
     *
     * Values: 2 urgent, 1 warn, 0 info, null/absent = let Nightscout decide.
     */
    reservoir_level_override?: number;
    iob: {
      timestamp: string;
      /**
       * The MM Connect conventional key, and the one Nightscout's plugin tries
       * FIRST (`iobPump.iob || iobPump.bolusiob`). Written alongside
       * `bolusiob` so a genuine 0 U does not depend on the `||` fallback —
       * `0 || undefined` is `undefined`.
       */
      iob?: number;
      bolusiob?: number;
    };
    clock: string;
    /**
     * Free-form key/value rows rendered inside the pump pill's info panel.
     *
     * This is Nightscout's OWN supported extension point, not a hack.
     * `lib/plugins/pump.js` updateVisualisation() (v15.0.9) does:
     *
     *     , extended: pump.extended || null
     *     ...
     *     if (result.extended) {
     *       info.push({label: '------------', value: ''});
     *       Object.entries(result.extended).forEach(([key, value]) => {
     *          info.push({ label: key, value: value });
     *       });
     *     }
     *
     * So anything here appears as a labelled row when the pump pill is opened —
     * the only way to surface 780G-specific facts in the UI without patching
     * Nightscout itself. Used for the fields Nightscout has no native slot for:
     * bolus delivery shortfall, SmartGuard state, firmware.
     *
     * Values must be strings or numbers; a nested object renders as
     * `[object Object]`.
     */
    extended?: Record<string, string | number>;
    /**
     * Delivery status, as Nightscout's pump plugin actually reads it.
     *
     * `lib/plugins/pump.js` `updateStatus()` (v15.0.9, verified by fetching the
     * file) does:
     *
     *   if (pump.status) {
     *     var status = pump.status.status || 'normal';
     *     if (pump.status.bolusing)      status = 'bolusing';
     *     else if (pump.status.suspended) status = 'suspended';
     *     ...
     *     if (suspended && prefs.warnOnSuspend) {
     *       result.status.level = levels.WARN;
     *       result.status.message = 'Pump Suspended';
     *     }
     *   }
     *
     * So `suspended` is not cosmetic: on a Nightscout with `warnOnSuspend` on,
     * it raises a real WARNING on the pump pill. This is the only suspend field
     * Nightscout reads — `autoMode.suspendFired` returns zero hits in the whole
     * repo — which means before this existed, the bridge's most important
     * "not delivering" fact had nowhere to land.
     *
     * `status` is the base word (`'normal'` if omitted, which is Nightscout's
     * own default). `suspended` is set ONLY from an explicit `true` in the
     * payload and omitted otherwise — absent stays absent, because asserting a
     * running pump is a claim a missing field cannot support.
     */
    status?: {
      status?: string;
      suspended?: boolean;
      bolusing?: boolean;
    };
    /**
     * SmartGuard auto-mode state, passed through from
     * `therapyAlgorithmState`. `suspendFired` is `null`, not `false`, when
     * `plgmLgsState` is a token outside the recorded vocabulary — see
     * describeAutoMode() in src/transform/index.ts.
     *
     * SCOPE — verified 2026-11-13 against nightscout/cgm-remote-monitor
     * v15.0.9: `autoMode`, `plgm`, `shieldState` and `suspendFired` all return
     * ZERO hits in that repo. This is the same dead-letter category as
     * `last_alarm` above. Kept deliberately as the raw-evidence record (it is
     * the faithful transcript of what the pump said), but it is NOT the safety
     * path — `status.suspended` above is.
     */
    autoMode?: {
      shieldState?: string;
      plgmState?: string;
      suspendFired: boolean | null;
      recognised: boolean;
      unrecognisedStates: string[];
    };
  };
  connect: {
    sensorState: string;
    calibStatus: string;
    // Optional: the wire carries either `*Hours` (legacy) or `*Minutes`
    // (v13 display/message), and a payload can legitimately carry neither.
    // Declaring these required is what let a missing value write `undefined`
    // into a medical field with no type error.
    sensorDurationHours?: number;
    timeToNextCalibHours?: number;
    conduitInRange: boolean;
    conduitMedicalDeviceInRange: boolean;
    conduitSensorInRange: boolean;
    medicalDeviceBatteryLevelPercent?: number;
    // Raw pump-reported battery, passed through alongside the medical-device
    // value (#82). Optional: absent on older devices.
    pumpBatteryLevelPercent?: number;
    medicalDeviceFamily?: string;
  };
}

export interface TransformResult {
  devicestatus: NightscoutDeviceStatus[];
  entries: NightscoutSGVEntry[];
  /**
   * Pump events mapped to Nightscout treatments. Empty when the payload has no
   * `markers[]`, which is normal for a CGM-only account.
   */
  treatments: Record<string, unknown>[];
  /**
   * Set when the payload was refused because its own device clock says the data
   * is older than the staleness threshold.
   *
   * This exists so the fetch loop can tell "nothing to say" from "everything
   * rejected as stale". Without it the loop sees an empty but successful
   * transform, counts a success, and RESETS the stale watchdog that exists to
   * catch exactly this case — a pump that stopped syncing looks healthy.
   */
  stale?: boolean;
  /** How old the refused payload was, in minutes. Present only when stale. */
  staleMinutes?: number;
}
