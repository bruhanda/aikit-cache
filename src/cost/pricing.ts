import type { ModelPricing } from '../core/types.js';

/**
 * Frozen Apr 2026 pricing snapshot. Exported so consumers can audit the
 * numbers; mutations go through `pricing-registry.ts`'s `registerModel()`.
 *
 * Prices are dollars per 1,000,000 tokens. Numbers reflect public
 * pricing pages as of the snapshot date and are best-effort — consumers
 * should override with `registerModel()` when contractual rates differ.
 */
export const PRICING_SNAPSHOT_DATE = '2026-04-01';

/**
 * Built-in pricing table. Frozen at module load — bundlers can keep only
 * the keys you statically reference.
 */
export const builtInPricing: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gpt-4o': pricing(2.5, 10, { cachedInputUSDPer1M: 1.25 }),
  'gpt-4o-mini': pricing(0.15, 0.6, { cachedInputUSDPer1M: 0.075 }),
  'gpt-4-turbo': pricing(10, 30),
  'gpt-3.5-turbo': pricing(0.5, 1.5),
  'gpt-5': pricing(5, 20, { cachedInputUSDPer1M: 2.5 }),
  'gpt-5-2': pricing(5, 20, { cachedInputUSDPer1M: 2.5 }),
  'gpt-5-4': pricing(15, 60, { cachedInputUSDPer1M: 7.5 }),
  'gpt-5-mini': pricing(0.25, 1.0, { cachedInputUSDPer1M: 0.125 }),
  'o1': pricing(15, 60),
  'o1-mini': pricing(3, 12),
  'o3': pricing(10, 40),
  'o3-mini': pricing(1.1, 4.4),
  'o4-mini': pricing(1.1, 4.4),

  'claude-3-5-sonnet': pricing(3, 15, { cachedInputUSDPer1M: 0.3 }),
  'claude-3-5-haiku': pricing(0.8, 4),
  'claude-3-opus': pricing(15, 75),
  'claude-opus-4-6': pricing(15, 75, { cachedInputUSDPer1M: 1.5 }),
  'claude-opus-4-7': pricing(15, 75, { cachedInputUSDPer1M: 1.5 }),
  'claude-sonnet-4-6': pricing(3, 15, { cachedInputUSDPer1M: 0.3 }),
  'claude-haiku-4-5': pricing(0.8, 4, { cachedInputUSDPer1M: 0.08 }),

  'gemini-1.5-pro': pricing(1.25, 5),
  'gemini-1.5-flash': pricing(0.075, 0.3),
  'gemini-2.0-flash': pricing(0.1, 0.4),
  'gemini-2.5-pro': pricing(1.25, 5),

  'mistral-large-latest': pricing(2, 6),
  'mistral-medium': pricing(0.4, 2),
  'mistral-small-latest': pricing(0.2, 0.6),

  'text-embedding-3-small': pricing(0.02, 0),
  'text-embedding-3-large': pricing(0.13, 0),
  'text-embedding-ada-002': pricing(0.1, 0),

  'voyage-3': pricing(0.06, 0),
  'voyage-3-lite': pricing(0.02, 0),
  'voyage-code-3': pricing(0.18, 0),

  'embed-v4.0': pricing(0.12, 0),
  'embed-multilingual-v3.0': pricing(0.1, 0),
});

function pricing(
  inputUSDPer1M: number,
  outputUSDPer1M: number,
  extras?: { readonly cachedInputUSDPer1M?: number },
): ModelPricing {
  const out: { -readonly [K in keyof ModelPricing]: ModelPricing[K] } = {
    inputUSDPer1M,
    outputUSDPer1M,
    pricingDate: PRICING_SNAPSHOT_DATE,
  };
  if (extras?.cachedInputUSDPer1M !== undefined) {
    out.cachedInputUSDPer1M = extras.cachedInputUSDPer1M;
  }
  return Object.freeze(out);
}
