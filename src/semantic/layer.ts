import { ConfigError } from '../errors/config-error.js';
import { EmbeddingError } from '../errors/embedding-error.js';
import type {
  Cache,
  CacheRequest,
  CacheStorage,
  SemanticLayer,
  SemanticLayerHandle,
} from '../core/types.js';
import { VectorStoreAdapter } from './store-adapter.js';
import type { SemanticCandidate, SemanticOptions } from './types.js';

/**
 * Wrap a cache with an embedding-based semantic lookup layer.
 *
 * On cache miss, the request's canonical text is embedded and matched
 * against the vector index. If the highest-scoring candidate has cosine
 * similarity ≥ `threshold`, its cached value is returned. Otherwise, fall
 * through to `fn()` and on success the live result is indexed under both
 * the exact hash and the embedding vector for future semantic matches.
 *
 * @param options Semantic configuration; see `SemanticOptions`.
 * @returns A `SemanticLayer` ready to pass into `createCache({ semantic })`.
 * @throws {ConfigError} `CONFIG_INVALID_THRESHOLD` for thresholds outside `[0, 1]`.
 *
 * @example
 * const cache = createCache({
 *   storage: ...,
 *   semantic: withSemantic({
 *     embeddings: openaiEmbeddings({ apiKey }),
 *     threshold: 0.95,
 *   }),
 * });
 */
export function withSemantic(options: SemanticOptions): SemanticLayer {
  const threshold = options.threshold ?? 0.95;
  if (threshold < 0 || threshold > 1) {
    throw new ConfigError('CONFIG_INVALID_THRESHOLD', `threshold must be in [0, 1]; got ${threshold}`, {
      field: 'threshold',
    });
  }
  const topK = options.topK ?? 5;
  const extractText = options.extractText ?? defaultExtractText;
  const rerank = options.rerank ?? defaultRerank;

  return {
    _install(getCache: () => Cache, storage: CacheStorage): SemanticLayerHandle {
      void getCache; // captured lazily; layer doesn't need a back-reference today
      const vectorStore = new VectorStoreAdapter(storage);
      let embeddingCostUSD = 0;

      const embed = async (request: CacheRequest): Promise<Float32Array | undefined> => {
        let text: string;
        try {
          text = extractText(request);
        } catch (cause) {
          throw new EmbeddingError('EMBEDDING_REQUEST_FAILED', options.embeddings.name, 'extractText threw', {
            cause,
          });
        }
        if (!text) {
          throw new EmbeddingError(
            'EMBEDDING_REQUEST_FAILED',
            options.embeddings.name,
            'extractText returned empty string; supply a custom extractText for non-chat requests',
          );
        }
        const vectors = await options.embeddings.embed([text]);
        const vector = vectors[0];
        if (!vector || vector.length !== options.embeddings.dimensions) {
          throw new EmbeddingError(
            'EMBEDDING_DIMENSION_MISMATCH',
            options.embeddings.name,
            `expected ${options.embeddings.dimensions} dimensions, got ${vector?.length ?? 0}`,
            {
              expectedDim: options.embeddings.dimensions,
              actualDim: vector?.length ?? 0,
            },
          );
        }

        if (options.costTracker) {
          embeddingCostUSD += options.costTracker.estimateUSD(options.embeddings.model, {
            inputTokens: estimateTokens(text),
            outputTokens: 0,
          });
        }

        return vector;
      };

      const handle: SemanticLayerHandle = {
        enabled: true,
        async lookup(request, _canonicalText): Promise<{ readonly hit: false } | { readonly hit: true; readonly value: unknown; readonly key: string; readonly similarity: number }> {
          // `lookup` is only invoked from `wrap()` after an exact miss, so the
          // post-miss path matches `onlyOnMiss: true` (the documented default).
          // `onlyOnMiss: false` would also call lookup *before* the exact check —
          // tracked as future work; the option is retained on `SemanticOptions`
          // so callers can opt in once the pre-miss path lands.
          const vector = await embed(request);
          if (!vector) return { hit: false };
          const ns = options.vectorNamespace;
          const hits = ns ? await vectorStore.search(vector, topK, ns) : await vectorStore.search(vector, topK);
          if (hits.length === 0) return { hit: false };
          const candidates: SemanticCandidate[] = [];
          for (const hit of hits) {
            if (hit.score < threshold) continue;
            const entry = await storage.get(hit.id);
            if (!entry) continue;
            candidates.push({
              key: hit.id,
              similarity: hit.score,
              entry: {
                key: hit.id,
                tags: entry.tags ?? [],
                createdAt: entry.createdAt,
                exp: entry.exp,
                meta: entry.meta ?? {},
              },
            });
          }
          if (candidates.length === 0) return { hit: false };
          const winner = rerank(candidates);
          if (!winner) return { hit: false };
          const entry = await storage.get(winner.key);
          if (!entry) return { hit: false };
          return {
            hit: true,
            value: entry.value,
            key: winner.key,
            similarity: winner.similarity,
          };
        },
        async index(request, _canonicalText, key): Promise<void> {
          const vector = await embed(request);
          if (!vector) return;
          await vectorStore.upsert([{ id: key, vector }]);
        },
        embeddingCostUSD: () => embeddingCostUSD,
      };
      return handle;
    },
  };
}

/**
 * Default `extractText`: joins `user`-role messages' string content. Throws
 * on non-text content parts so vision-aware semantic caching is opt-in.
 */
function defaultExtractText(request: CacheRequest): string {
  if (request.messages) {
    const parts: string[] = [];
    for (const m of request.messages) {
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') {
        parts.push(m.content);
        continue;
      }
      for (const part of m.content) {
        if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
          parts.push((part as { text: string }).text);
          continue;
        }
        throw new Error(
          `multimodal content (${part.type}) requires a custom extractText that hashes non-text parts`,
        );
      }
    }
    return parts.join('\n');
  }
  if (typeof request.input === 'string') return request.input;
  if (Array.isArray(request.input)) {
    const arr: readonly unknown[] = request.input;
    const flat: string[] = [];
    for (const item of arr) if (typeof item === 'string') flat.push(item);
    if (flat.length > 0) return flat.join('\n');
  }
  throw new Error('default extractText only handles `messages` (chat) or string `input`');
}

function defaultRerank(candidates: readonly SemanticCandidate[]): SemanticCandidate | undefined {
  let best: SemanticCandidate | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.similarity > best.similarity) best = candidate;
  }
  return best;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
