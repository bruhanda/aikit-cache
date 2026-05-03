import type {
  CacheEntryView,
  CacheRequest,
  CostTracker,
  SemanticLayer as SemanticLayerType,
} from '../core/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

export type { EmbeddingProvider } from '../embeddings/types.js';
export type { VectorRecord, VectorSearchHit } from '../core/types.js';
export type SemanticLayer = SemanticLayerType;

export interface SemanticCandidate {
  readonly key: string;
  readonly similarity: number;
  readonly entry: CacheEntryView;
}

export interface SemanticOptions {
  readonly embeddings: EmbeddingProvider;
  /**
   * Cosine similarity threshold in `[0, 1]`. Default `0.95`.
   *
   * The default is intentionally above the historical sweet spot of
   * 0.92–0.94 — a confidently-wrong cached answer to a slightly different
   * question is the worst possible UX failure here, much worse than a
   * cache miss. Values below 0.92 are documented as a foot-gun.
   */
  readonly threshold?: number;
  readonly topK?: number;
  readonly onlyOnMiss?: boolean;
  /**
   * Custom function deciding what string to embed. Default joins the
   * `user`-role messages' string content. THROWS for multimodal content
   * containing non-text parts so vision-aware semantic caching is opt-in.
   */
  readonly extractText?: (request: CacheRequest) => string;
  readonly vectorNamespace?: string;
  readonly rerank?: (candidates: readonly SemanticCandidate[]) => SemanticCandidate | undefined;
  /**
   * Optional cost tracker used to attribute embedding spend. Pass
   * `defaultCostTracker` from `@aikit/cache/cost` to enable, or omit to
   * keep `embeddingCostUSD` at `0`. Decoupled from the layer itself so
   * `semantic/*` does not need to import `cost/*`.
   */
  readonly costTracker?: CostTracker;
}
