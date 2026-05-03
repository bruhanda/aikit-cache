import { afterEach, describe, expect, it } from 'vitest';
import {
  builtInPricing,
  computeCost,
  defaultCostTracker,
  estimateRequestUSD,
  getPricing,
  listModels,
  PRICING_SNAPSHOT_DATE,
  registerModel,
  unregisterModel,
} from '../cost/index.js';
import { CostError } from '../errors/cost-error.js';

describe('builtInPricing', () => {
  it('should be frozen and contain known models', () => {
    expect(Object.isFrozen(builtInPricing)).toBe(true);
    expect(builtInPricing['gpt-4o']).toBeDefined();
    expect(builtInPricing['claude-opus-4-7']).toBeDefined();
  });

  it('should stamp pricingDate from the snapshot constant', () => {
    expect(PRICING_SNAPSHOT_DATE).toBe('2026-04-01');
    expect(builtInPricing['gpt-4o']?.pricingDate).toBe('2026-04-01');
  });
});

describe('computeCost', () => {
  it('should compute total cost with no cached input', () => {
    const cost = computeCost({ inputUSDPer1M: 1, outputUSDPer1M: 2 }, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(1 + 1, 6);
  });

  it('should apply the cached-input rate to cached tokens', () => {
    const cost = computeCost(
      { inputUSDPer1M: 10, outputUSDPer1M: 0, cachedInputUSDPer1M: 1 },
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 },
    );
    // billable = 500k @ $10/M = $5; cached = 500k @ $1/M = $0.5
    expect(cost).toBeCloseTo(5.5, 6);
  });

  it('should default cached rate to inputUSDPer1M when cachedInputUSDPer1M is missing', () => {
    const cost = computeCost(
      { inputUSDPer1M: 10, outputUSDPer1M: 0 },
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(10, 6);
  });

  it('should clamp billable input at zero when cached exceeds total', () => {
    const cost = computeCost(
      { inputUSDPer1M: 10, outputUSDPer1M: 0, cachedInputUSDPer1M: 0 },
      { inputTokens: 100, outputTokens: 0, cachedInputTokens: 1000 },
    );
    expect(cost).toBe(0);
  });
});

describe('estimateRequestUSD', () => {
  it('should return cost for known model', () => {
    const cost = estimateRequestUSD({
      model: 'gpt-4o',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('should return 0 for unknown model', () => {
    expect(
      estimateRequestUSD({
        model: 'unknown-model',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toBe(0);
  });
});

describe('registerModel / unregisterModel / getPricing / listModels', () => {
  afterEach(() => {
    unregisterModel('test:custom');
  });

  it('should register and look up a custom model', () => {
    registerModel('test:custom', { inputUSDPer1M: 1, outputUSDPer1M: 2 });
    const pricing = getPricing('test:custom');
    expect(pricing?.inputUSDPer1M).toBe(1);
    expect(pricing?.outputUSDPer1M).toBe(2);
    expect(pricing?.pricingDate).toBeDefined();
  });

  it('should override built-in pricing when same key registered', () => {
    registerModel('gpt-4o', { inputUSDPer1M: 99, outputUSDPer1M: 99 });
    expect(getPricing('gpt-4o')?.inputUSDPer1M).toBe(99);
    unregisterModel('gpt-4o');
    expect(getPricing('gpt-4o')?.inputUSDPer1M).not.toBe(99);
  });

  it('should reject empty model id', () => {
    expect(() => registerModel('', { inputUSDPer1M: 1, outputUSDPer1M: 1 })).toThrow(CostError);
  });

  it('should reject negative rates', () => {
    expect(() =>
      registerModel('test:custom', { inputUSDPer1M: -1, outputUSDPer1M: 0 }),
    ).toThrow(CostError);
    expect(() =>
      registerModel('test:custom', { inputUSDPer1M: 0, outputUSDPer1M: -1 }),
    ).toThrow(CostError);
    expect(() =>
      registerModel('test:custom', {
        inputUSDPer1M: 1,
        outputUSDPer1M: 1,
        cachedInputUSDPer1M: -0.1,
      }),
    ).toThrow(CostError);
  });

  it('should preserve user-supplied pricingDate', () => {
    registerModel('test:custom', {
      inputUSDPer1M: 1,
      outputUSDPer1M: 2,
      pricingDate: '2025-01-01',
    });
    expect(getPricing('test:custom')?.pricingDate).toBe('2025-01-01');
  });

  it('should default pricingDate to today when missing', () => {
    registerModel('test:custom', { inputUSDPer1M: 1, outputUSDPer1M: 2 });
    expect(getPricing('test:custom')?.pricingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should report whether unregister removed an override', () => {
    registerModel('test:custom', { inputUSDPer1M: 1, outputUSDPer1M: 2 });
    expect(unregisterModel('test:custom')).toBe(true);
    expect(unregisterModel('test:custom')).toBe(false);
  });

  it('should list all known models alphabetically with deduplication', () => {
    registerModel('test:custom', { inputUSDPer1M: 1, outputUSDPer1M: 2 });
    const models = listModels();
    expect(models).toContain('test:custom');
    expect(models).toContain('gpt-4o');
    const sorted = [...models].sort();
    expect(models).toEqual(sorted);
    const set = new Set(models);
    expect(set.size).toBe(models.length);
  });

  it('should return undefined for an unknown model', () => {
    expect(getPricing('does-not-exist')).toBeUndefined();
  });
});

describe('defaultCostTracker', () => {
  it('should compute USD for known models', () => {
    const usd = defaultCostTracker.estimateUSD('gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(usd).toBeGreaterThan(0);
  });

  it('should return 0 for unknown models', () => {
    expect(
      defaultCostTracker.estimateUSD('nonexistent-model', { inputTokens: 1, outputTokens: 1 }),
    ).toBe(0);
  });
});
