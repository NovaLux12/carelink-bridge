import { describe, it, expect } from 'vitest';
import { CircuitBreaker, DEFAULT_CIRCUIT_THRESHOLD, DEFAULT_CIRCUIT_COOLDOWN_MS } from '../src/circuit-breaker.js';

/**
 * Circuit breaker contract (issue #9 item 3).
 *
 * After N consecutive failures the bridge short-circuits for a cooldown
 * instead of hammering CareLink. Success resets. Transitions are
 * signalled by boolean returns so callers log open/close exactly once.
 */
describe('CircuitBreaker', () => {
  it('exposes the issue #9 defaults (5 failures, 60s cooldown)', () => {
    expect(DEFAULT_CIRCUIT_THRESHOLD).toBe(5);
    expect(DEFAULT_CIRCUIT_COOLDOWN_MS).toBe(60_000);
    const cb = new CircuitBreaker();
    expect(cb.isOpen()).toBe(false);
    expect(cb.getConsecutiveFailures()).toBe(0);
  });

  it('stays closed through threshold-1 failures', () => {
    const cb = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) {
      expect(cb.recordFailure(1_000)).toBe(false);
    }
    expect(cb.isOpen(1_000)).toBe(false);
    expect(cb.getConsecutiveFailures()).toBe(4);
  });

  it('opens on the Nth consecutive failure and reports openUntil', () => {
    const cb = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) cb.recordFailure(1_000);
    expect(cb.recordFailure(1_000)).toBe(true);
    expect(cb.isOpen(1_000)).toBe(true);
    expect(cb.getOpenUntil()).toBe(61_000);
    // Still open just before cooldown, closed just after.
    expect(cb.isOpen(60_999)).toBe(true);
    expect(cb.isOpen(61_001)).toBe(false);
  });

  it('does not re-open while already open (single open log per trip)', () => {
    const cb = new CircuitBreaker(2, 60_000);
    expect(cb.recordFailure(0)).toBe(false);
    expect(cb.recordFailure(0)).toBe(true);
    // Further failures during the open window don't re-trigger.
    expect(cb.recordFailure(1_000)).toBe(false);
    expect(cb.isOpen(1_000)).toBe(true);
  });

  it('success resets the counter and reports close only when tripped', () => {
    const cb = new CircuitBreaker(3, 60_000);
    expect(cb.recordSuccess()).toBe(false);
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.recordSuccess()).toBe(false);
    cb.recordFailure(0);
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.isOpen(0)).toBe(true);
    expect(cb.recordSuccess()).toBe(true);
    expect(cb.isOpen(0)).toBe(false);
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getOpenUntil()).toBe(0);
  });

  it('restores persisted state and ignores garbage', () => {
    const cb = new CircuitBreaker();
    cb.restore({ consecutiveFailures: 4, circuitOpenUntil: 99_000 });
    expect(cb.getConsecutiveFailures()).toBe(4);
    expect(cb.getOpenUntil()).toBe(99_000);
    cb.restore({ consecutiveFailures: -3, circuitOpenUntil: -1 });
    expect(cb.getConsecutiveFailures()).toBe(4);
    expect(cb.getOpenUntil()).toBe(99_000);
    cb.restore({});
    expect(cb.getConsecutiveFailures()).toBe(4);
  });

  it('honours custom threshold/cooldown', () => {
    const cb = new CircuitBreaker(2, 5_000);
    expect(cb.recordFailure(0)).toBe(false);
    expect(cb.recordFailure(0)).toBe(true);
    expect(cb.getOpenUntil()).toBe(5_000);
  });
});
