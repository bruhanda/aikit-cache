import type { BatchedEmbeddingOptions, EmbeddingProvider } from './types.js';

interface PendingItem {
  input: string;
  resolve(vector: Float32Array): void;
  reject(error: unknown): void;
}

/**
 * Coalesce concurrent `embed([…])` calls into one batched upstream request.
 * Useful when many independent code paths each embed a single string at
 * roughly the same time — a request-coalescing equivalent of single-flight
 * for embeddings.
 *
 * @param provider Underlying provider whose batched call we forward to.
 * @param options Batch size and flush window.
 * @returns A drop-in `EmbeddingProvider` with batching transparently applied.
 *
 * @example
 * const embeddings = withBatching(openaiEmbeddings({ apiKey }), { maxBatchSize: 32, flushMs: 10 });
 */
export function withBatching(
  provider: EmbeddingProvider,
  options: BatchedEmbeddingOptions = {},
): EmbeddingProvider {
  const maxBatchSize = options.maxBatchSize ?? 32;
  const flushMs = options.flushMs ?? 10;
  let queue: PendingItem[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async (): Promise<void> => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    timer = undefined;
    try {
      const vectors = await provider.embed(batch.map((b) => b.input));
      if (vectors.length !== batch.length) {
        for (const item of batch) {
          item.reject(new Error(`batched embed: provider returned ${vectors.length}, expected ${batch.length}`));
        }
        return;
      }
      for (let i = 0; i < batch.length; i++) batch[i]!.resolve(vectors[i]!);
    } catch (err) {
      for (const item of batch) item.reject(err);
    }
  };

  const enqueue = (input: string): Promise<Float32Array> =>
    new Promise<Float32Array>((resolve, reject) => {
      queue.push({ input, resolve, reject });
      if (queue.length >= maxBatchSize) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        void flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          void flush();
        }, flushMs);
      }
    });

  return {
    name: `${provider.name}+batched`,
    model: provider.model,
    dimensions: provider.dimensions,
    async embed(inputs) {
      if (inputs.length === 0) return [];
      return Promise.all(inputs.map(enqueue));
    },
  };
}
