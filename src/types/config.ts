export type LogFormat = 'json' | 'pretty';

export interface Config {
  username: string;
  password: string;
  nsHost?: string;
  nsBaseUrl?: string;
  nsSecret: string;
  interval: number;
  sgvLimit: number;
  verbose: boolean;
  logFormat: LogFormat;
  patientId?: string;
  countryCode: string;
  language: string;
  staleThresholdMs: number;
  staleWebhookUrl?: string;
  stateFile?: string;
  circuitThreshold: number;
  circuitCooldownMs: number;
  /** 0 = disabled (default, no inbound port). >0 = loopback-only /healthz + /metrics. */
  metricsPort: number;
}
