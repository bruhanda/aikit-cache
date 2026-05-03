import { CostError } from '../errors/cost-error.js';
import type { ModelPricing } from '../core/types.js';
import { builtInPricing } from './pricing.js';

const overrides = new Map<string, ModelPricing>();

/**
 * Register or override pricing for a model. Built-in models are always
 * pre-registered; this is for custom/private models or for overriding
 * the snapshot's defaults.
 *
 * @param model Model identifier as it appears in `CacheRequest.model`.
 * @param pricing Per-1M-token rates.
 * @throws {CostError} `COST_INVALID_PRICING` for negative rates.
 *
 * @example
 * registerModel('internal-llama-70b', { inputUSDPer1M: 0.5, outputUSDPer1M: 1.5 });
 */
export function registerModel(model: string, pricing: ModelPricing): void {
  if (!model) throw new CostError('COST_INVALID_PRICING', 'model identifier is required');
  if (pricing.inputUSDPer1M < 0 || pricing.outputUSDPer1M < 0) {
    throw new CostError(
      'COST_INVALID_PRICING',
      `pricing rates must be non-negative; got input=${pricing.inputUSDPer1M}, output=${pricing.outputUSDPer1M}`,
      { model },
    );
  }
  if (pricing.cachedInputUSDPer1M !== undefined && pricing.cachedInputUSDPer1M < 0) {
    throw new CostError('COST_INVALID_PRICING', 'cachedInputUSDPer1M must be non-negative', { model });
  }
  const stored: ModelPricing = Object.freeze({
    ...pricing,
    pricingDate: pricing.pricingDate ?? new Date().toISOString().slice(0, 10),
  });
  overrides.set(model, stored);
}

/**
 * Remove a previously-registered override.
 *
 * @param model Model identifier.
 * @returns `true` when an override existed and was removed.
 */
export function unregisterModel(model: string): boolean {
  return overrides.delete(model);
}

/**
 * Look up the effective pricing for a model. Overrides win over the
 * built-in snapshot; returns `undefined` for unknown models so the cost
 * tracker can degrade gracefully.
 *
 * @param model Model identifier.
 * @returns Effective `ModelPricing` or `undefined`.
 */
export function getPricing(model: string): ModelPricing | undefined {
  return overrides.get(model) ?? builtInPricing[model];
}

/**
 * List every model with known pricing — built-in plus overrides.
 *
 * @returns Sorted, deduplicated list of model identifiers.
 */
export function listModels(): readonly string[] {
  const all = new Set<string>([...Object.keys(builtInPricing), ...overrides.keys()]);
  return Array.from(all).sort();
}
