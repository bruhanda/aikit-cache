/**
 * Pluggable embedding source. Implementations should:
 *   - normalize vectors to unit length (cosine similarity assumes this);
 *   - support batched calls efficiently (called with up to 64 inputs at once);
 *   - throw `EmbeddingError` (or any `Error` — wrapped automatically) on failure.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(inputs: readonly string[]): Promise<readonly Float32Array[]>;
}

export interface EmbeddingResult {
  readonly vector: Float32Array;
  readonly tokens?: number;
}

export interface BatchedEmbeddingOptions {
  readonly maxBatchSize?: number;
  readonly flushMs?: number;
}
