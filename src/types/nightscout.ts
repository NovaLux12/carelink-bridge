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
  severity: 'stop_using_pump' | 'delivery_stopped' | 'other';
}

export interface NightscoutDeviceStatus {
  created_at: string;
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
    iob: {
      timestamp: string;
      bolusiob?: number;
    };
    clock: string;
    /**
     * SmartGuard auto-mode state, passed through from
     * `therapyAlgorithmState`. `suspendFired` is `null`, not `false`, when
     * `plgmLgsState` is a token outside the recorded vocabulary — see
     * describeAutoMode() in src/transform/index.ts.
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
}
