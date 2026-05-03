import { computeCost } from './tracker.js';
import { getPricing } from './pricing-registry.js';
import type { CostTracker } from '../core/types.js';

export { estimateRequestUSD, computeCost } from './tracker.js';
export { registerModel, unregisterModel, getPricing, listModels } from './pricing-registry.js';
export { builtInPricing, PRICING_SNAPSHOT_DATE } from './pricing.js';
export type { ModelPricing, CostSavings, TokenUsage } from './types.js';
export type { CostTracker } from '../core/types.js';

/**
 * Default `CostTracker` backed by the built-in pricing snapshot plus any
 * `registerModel(...)` overrides. Pass into `createCache({ costTracker })`
 * to enable `stats().savedUSD` accounting:
 *
 * @example
 * import { createCache } from '@aikit/cache';
 * import { defaultCostTracker } from '@aikit/cache/cost';
 *
 * const cache = createCache({ storage, costTracker: defaultCostTracker });
 */
export const defaultCostTracker: CostTracker = {
  estimateUSD(model, usage) {
    const pricing = getPricing(model);
    if (!pricing) return 0;
    return computeCost(pricing, usage);
  },
};
