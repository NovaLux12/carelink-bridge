/**
 * Circuit breaker for CareLink (v0.3.0 reliability, issue #9 item 3).
 *
 * After N consecutive fetch failures, stop retrying for a cooldown period
 * instead of hammering a host that has nothing to give. The per-attempt
 * retry policy (src/retry-policy.ts) handles backoff *within* one fetch();
 * this breaker handles failures *across* fetch() calls (the main loop).
 *
 * Zero dependencies. Pure time-based logic — easily unit-tested with
 * injected timestamps. I/O (persistence) lives in persistent-state.ts.
 */

export const DEFAULT_CIRCUIT_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;

export interface CircuitState {
  consecutiveFailures: number;
  circuitOpenUntil: number;
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold = DEFAULT_CIRCUIT_THRESHOLD, cooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  /** True when the circuit is currently open (calls should short-circuit). */
  isOpen(now = Date.now()): boolean {
    return now < this.circuitOpenUntil;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getOpenUntil(): number {
    return this.circuitOpenUntil;
  }

  getState(): CircuitState {
    return {
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
    };
  }

  /** Restore state from disk (persistent-state.ts) on startup. */
  restore(state: Partial<CircuitState>): void {
    if (typeof state.consecutiveFailures === 'number' && state.consecutiveFailures >= 0) {
      this.consecutiveFailures = Math.floor(state.consecutiveFailures);
    }
    if (typeof state.circuitOpenUntil === 'number' && state.circuitOpenUntil >= 0) {
      this.circuitOpenUntil = state.circuitOpenUntil;
    }
  }

  /**
   * Record a successful fetch. Returns true when this success closed a
   * previously-tripped circuit (so the caller can log the transition).
   */
  recordSuccess(): boolean {
    const wasTripped = this.consecutiveFailures >= this.threshold;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    return wasTripped;
  }

  /**
   * Record a failed fetch. Returns true when this failure just opened the
   * circuit (so the caller can log the transition exactly once).
   */
  recordFailure(now = Date.now()): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold && now >= this.circuitOpenUntil) {
      this.circuitOpenUntil = now + this.cooldownMs;
      return true;
    }
    return false;
  }
}
