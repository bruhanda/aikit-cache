import type { CacheStatsSnapshot, CostSavings, TokenUsage } from './types.js';

interface MutableModelStats {
  hits: number;
  inputTokens: number;
  outputTokens: number;
  savedUSD: number;
}

/**
 * Atomic counters for cache hits/misses, errors, coalesced waiters, and
 * dollar savings. Single-threaded by JS event-loop semantics; no locks
 * needed.
 */
export class StatsAccumulator {
  private hits = 0;
  private misses = 0;
  private errors = 0;
  private coalesced = 0;
  private savedInputTokens = 0;
  private savedOutputTokens = 0;
  private savedUSD = 0;
  private embeddingCostUSD = 0;
  private since: number;
  private readonly byModel: Map<string, MutableModelStats> = new Map();

  constructor(now: number) {
    this.since = now;
  }

  /** Record a cache hit. */
  recordHit(model: string, usage: TokenUsage | undefined, savedUSD: number): void {
    this.hits += 1;
    if (usage) {
      this.savedInputTokens += usage.inputTokens;
      this.savedOutputTokens += usage.outputTokens;
    }
    this.savedUSD += savedUSD;
    const entry = this.getOrCreateModel(model);
    entry.hits += 1;
    if (usage) {
      entry.inputTokens += usage.inputTokens;
      entry.outputTokens += usage.outputTokens;
    }
    entry.savedUSD += savedUSD;
  }

  recordMiss(): void {
    this.misses += 1;
  }

  recordError(): void {
    this.errors += 1;
  }

  recordCoalesce(waiters: number): void {
    this.coalesced += waiters;
  }

  recordEmbeddingCost(usd: number): void {
    this.embeddingCostUSD += usd;
  }

  /** Reset every counter. The `since` timestamp resets to `now`. */
  reset(now: number): void {
    this.hits = 0;
    this.misses = 0;
    this.errors = 0;
    this.coalesced = 0;
    this.savedInputTokens = 0;
    this.savedOutputTokens = 0;
    this.savedUSD = 0;
    this.embeddingCostUSD = 0;
    this.since = now;
    this.byModel.clear();
  }

  /** Frozen snapshot. */
  snapshot(now: number, embeddingCostUSDExternal?: number): CacheStatsSnapshot {
    const total = this.hits + this.misses;
    const byModel: Record<string, CostSavings> = {};
    for (const [model, entry] of this.byModel) {
      byModel[model] = Object.freeze({
        hits: entry.hits,
        savedTokens: Object.freeze({ input: entry.inputTokens, output: entry.outputTokens }),
        savedUSD: round(entry.savedUSD),
      });
    }
    const embeddingCostUSD = round(embeddingCostUSDExternal ?? this.embeddingCostUSD);
    const savedUSD = round(this.savedUSD);
    return Object.freeze({
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      errors: this.errors,
      coalesced: this.coalesced,
      savedTokens: Object.freeze({ input: this.savedInputTokens, output: this.savedOutputTokens }),
      savedUSD,
      embeddingCostUSD,
      netSavedUSD: round(savedUSD - embeddingCostUSD),
      byModel: Object.freeze(byModel),
      since: this.since,
      until: now,
    });
  }

  private getOrCreateModel(model: string): MutableModelStats {
    let entry = this.byModel.get(model);
    if (!entry) {
      entry = { hits: 0, inputTokens: 0, outputTokens: 0, savedUSD: 0 };
      this.byModel.set(model, entry);
    }
    return entry;
  }
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
