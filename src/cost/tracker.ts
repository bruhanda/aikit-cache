import type { ModelPricing, TokenUsage } from '../core/types.js';
import { getPricing } from './pricing-registry.js';

/**
 * Estimate the dollar cost of a single (request, response) pair. Used
 * internally by the cache stats tracker and exported for one-off
 * estimates outside the cache.
 *
 * Returns `0` for unknown models — the cache layer logs an error event
 * with code `COST_UNKNOWN_MODEL` instead of throwing, since unknown
 * pricing should not block production traffic.
 *
 * @param args Model identifier and token usage.
 * @returns Total cost in USD.
 */
export function estimateRequestUSD(args: {
  readonly model: string;
  readonly usage: TokenUsage;
}): number {
  const pricing = getPricing(args.model);
  if (!pricing) return 0;
  return computeCost(pricing, args.usage);
}

/** Compute cost given an explicit pricing record. */
export function computeCost(pricing: ModelPricing, usage: TokenUsage): number {
  const cachedInput = usage.cachedInputTokens ?? 0;
  const billableInput = Math.max(0, usage.inputTokens - cachedInput);
  const cachedRate = pricing.cachedInputUSDPer1M ?? pricing.inputUSDPer1M;
  const inputUSD = (billableInput / 1_000_000) * pricing.inputUSDPer1M
    + (cachedInput / 1_000_000) * cachedRate;
  const outputUSD = (usage.outputTokens / 1_000_000) * pricing.outputUSDPer1M;
  return inputUSD + outputUSD;
}
