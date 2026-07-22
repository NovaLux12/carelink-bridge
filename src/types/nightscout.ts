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
  code: number;
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
  last_alarm?: NightscoutLastAlarmAnnotation;
  pump?: {
    battery: { percent: number };
    reservoir: number | undefined;
    iob: {
      timestamp: string;
      bolusiob?: number;
    };
    clock: string;
  };
  connect: {
    sensorState: string;
    calibStatus: string;
    sensorDurationHours: number;
    timeToNextCalibHours: number;
    conduitInRange: boolean;
    conduitMedicalDeviceInRange: boolean;
    conduitSensorInRange: boolean;
    medicalDeviceBatteryLevelPercent?: number;
    medicalDeviceFamily?: string;
  };
}

export interface TransformResult {
  devicestatus: NightscoutDeviceStatus[];
  entries: NightscoutSGVEntry[];
}
