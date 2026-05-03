import { describe, expect, it } from 'vitest';
import {
  applyJitter,
  DEFAULT_TTL_JITTER,
  DEFAULT_TTL_MS,
  resolveTTL,
  validateTTL,
} from '../core/ttl.js';
import { ConfigError } from '../errors/config-error.js';

describe('DEFAULT_TTL_MS', () => {
  it('should be one hour', () => {
    expect(DEFAULT_TTL_MS).toBe(60 * 60 * 1000);
  });
});

describe('DEFAULT_TTL_JITTER', () => {
  it('should be 10%', () => {
    expect(DEFAULT_TTL_JITTER).toBe(0.1);
  });
});

describe('validateTTL', () => {
  it('should accept zero', () => {
    expect(() => validateTTL(0)).not.toThrow();
  });

  it('should accept positive finite numbers', () => {
    expect(() => validateTTL(60_000)).not.toThrow();
  });

  it('should reject negative numbers', () => {
    expect(() => validateTTL(-1)).toThrow(ConfigError);
  });

  it('should reject NaN', () => {
    expect(() => validateTTL(NaN)).toThrow(ConfigError);
  });

  it('should reject Infinity', () => {
    expect(() => validateTTL(Infinity)).toThrow(ConfigError);
    expect(() => validateTTL(-Infinity)).toThrow(ConfigError);
  });

  it('should reject non-number values', () => {
    expect(() => validateTTL('5' as unknown as number)).toThrow(ConfigError);
  });
});

describe('resolveTTL', () => {
  it('should return override when provided', () => {
    expect(resolveTTL({ model: 'm', override: 1234 })).toBe(1234);
  });

  it('should return perModelTTL when override is missing', () => {
    expect(
      resolveTTL({ model: 'gpt-4o', perModelTTL: { 'gpt-4o': 5000 } }),
    ).toBe(5000);
  });

  it('should return perNamespaceTTL when model has no entry', () => {
    expect(
      resolveTTL({
        model: 'unknown',
        namespace: 'ns',
        perNamespaceTTL: { ns: 7000 },
      }),
    ).toBe(7000);
  });

  it('should fall back to policy.default', () => {
    expect(resolveTTL({ model: 'unknown', policy: { default: 9000 } })).toBe(9000);
  });

  it('should fall back to DEFAULT_TTL_MS when policy is unset', () => {
    expect(resolveTTL({ model: 'unknown' })).toBe(DEFAULT_TTL_MS);
  });

  it('should prefer override over perModelTTL/perNamespaceTTL/policy', () => {
    expect(
      resolveTTL({
        model: 'gpt-4o',
        namespace: 'ns',
        override: 100,
        perModelTTL: { 'gpt-4o': 200 },
        perNamespaceTTL: { ns: 300 },
        policy: { default: 400 },
      }),
    ).toBe(100);
  });

  it('should prefer perModelTTL over perNamespaceTTL', () => {
    expect(
      resolveTTL({
        model: 'gpt-4o',
        namespace: 'ns',
        perModelTTL: { 'gpt-4o': 200 },
        perNamespaceTTL: { ns: 300 },
        policy: { default: 400 },
      }),
    ).toBe(200);
  });

  it('should reject invalid override TTL', () => {
    expect(() => resolveTTL({ model: 'm', override: -1 })).toThrow(ConfigError);
  });
});

describe('applyJitter', () => {
  it('should return base TTL when jitter is zero', () => {
    expect(applyJitter(1000, 0)).toBe(1000);
  });

  it('should clamp to a minimum of 1ms', () => {
    expect(applyJitter(1, 1, () => 0)).toBeGreaterThanOrEqual(1);
  });

  it('should produce values within +/- jitter%', () => {
    // Worst-case offsets at rng() = 0 (delta = -ttlMs * jitter) and rng() = 1.
    const ttl = 10_000;
    const jitter = 0.2;
    const low = applyJitter(ttl, jitter, () => 0);
    const high = applyJitter(ttl, jitter, () => 0.999999);
    expect(low).toBeLessThanOrEqual(ttl);
    expect(low).toBeGreaterThanOrEqual(ttl - ttl * jitter);
    expect(high).toBeGreaterThanOrEqual(ttl);
    expect(high).toBeLessThanOrEqual(ttl + ttl * jitter);
  });

  it('should accept a deterministic rng', () => {
    const fixed = applyJitter(1000, 0.5, () => 0.5);
    expect(fixed).toBe(1000);
  });

  it('should default to DEFAULT_TTL_JITTER when no jitter passed', () => {
    const v = applyJitter(1000, undefined, () => 0.5);
    expect(v).toBe(1000);
  });
});
