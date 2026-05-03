import { describe, expect, it } from 'vitest';
import { StatsAccumulator } from '../core/stats.js';

describe('StatsAccumulator', () => {
  it('should start with zero counters', () => {
    const stats = new StatsAccumulator(100);
    const snap = stats.snapshot(200);
    expect(snap.hits).toBe(0);
    expect(snap.misses).toBe(0);
    expect(snap.hitRate).toBe(0);
    expect(snap.errors).toBe(0);
    expect(snap.coalesced).toBe(0);
    expect(snap.savedTokens).toEqual({ input: 0, output: 0 });
    expect(snap.savedUSD).toBe(0);
    expect(snap.embeddingCostUSD).toBe(0);
    expect(snap.netSavedUSD).toBe(0);
    expect(snap.byModel).toEqual({});
    expect(snap.since).toBe(100);
    expect(snap.until).toBe(200);
  });

  it('should accumulate hits and savings per model', () => {
    const stats = new StatsAccumulator(0);
    stats.recordHit('gpt-4o', { inputTokens: 100, outputTokens: 50 }, 0.0125);
    stats.recordHit('gpt-4o', { inputTokens: 200, outputTokens: 100 }, 0.025);
    const snap = stats.snapshot(100);
    expect(snap.hits).toBe(2);
    expect(snap.savedTokens).toEqual({ input: 300, output: 150 });
    expect(snap.savedUSD).toBeCloseTo(0.0375, 6);
    expect(snap.byModel['gpt-4o']).toMatchObject({
      hits: 2,
      savedTokens: { input: 300, output: 150 },
    });
    expect(snap.byModel['gpt-4o']!.savedUSD).toBeCloseTo(0.0375, 6);
  });

  it('should accumulate hits without usage', () => {
    const stats = new StatsAccumulator(0);
    stats.recordHit('gpt-4o', undefined, 0);
    const snap = stats.snapshot(100);
    expect(snap.hits).toBe(1);
    expect(snap.savedTokens).toEqual({ input: 0, output: 0 });
  });

  it('should compute hitRate correctly', () => {
    const stats = new StatsAccumulator(0);
    stats.recordHit('m', undefined, 0);
    stats.recordHit('m', undefined, 0);
    stats.recordMiss();
    const snap = stats.snapshot(100);
    expect(snap.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it('should record errors and coalesced waiters', () => {
    const stats = new StatsAccumulator(0);
    stats.recordError();
    stats.recordCoalesce(5);
    stats.recordCoalesce(2);
    const snap = stats.snapshot(100);
    expect(snap.errors).toBe(1);
    expect(snap.coalesced).toBe(7);
  });

  it('should compute netSavedUSD as savedUSD minus embeddingCostUSD', () => {
    const stats = new StatsAccumulator(0);
    stats.recordHit('m', undefined, 0.01);
    stats.recordEmbeddingCost(0.005);
    const snap = stats.snapshot(100);
    expect(snap.savedUSD).toBeCloseTo(0.01, 6);
    expect(snap.embeddingCostUSD).toBeCloseTo(0.005, 6);
    expect(snap.netSavedUSD).toBeCloseTo(0.005, 6);
  });

  it('should let an external embeddingCostUSD parameter override the internal counter', () => {
    const stats = new StatsAccumulator(0);
    stats.recordEmbeddingCost(1);
    const snap = stats.snapshot(100, 0.5);
    expect(snap.embeddingCostUSD).toBe(0.5);
  });

  it('should reset counters and the since timestamp', () => {
    const stats = new StatsAccumulator(0);
    stats.recordHit('m', { inputTokens: 1, outputTokens: 1 }, 1);
    stats.recordMiss();
    stats.reset(500);
    const snap = stats.snapshot(600);
    expect(snap.hits).toBe(0);
    expect(snap.misses).toBe(0);
    expect(snap.savedUSD).toBe(0);
    expect(snap.byModel).toEqual({});
    expect(snap.since).toBe(500);
  });

  it('should freeze the snapshot to prevent mutation', () => {
    const stats = new StatsAccumulator(0);
    const snap = stats.snapshot(0);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.savedTokens)).toBe(true);
    expect(Object.isFrozen(snap.byModel)).toBe(true);
  });
});
