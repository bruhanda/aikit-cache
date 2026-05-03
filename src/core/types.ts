import type { ChatMessage } from '../types/chat.js';
import type { ChunkSerializer } from '../types/stream.js';
import type { Result } from '../types/result.js';
import type { CacheError } from '../errors/base.js';

/**
 * Provider-neutral description of an LLM request. The library hashes a
 * canonical form of this object — sorted keys, normalized whitespace,
 * `WrapOptions.ignoreFields` removed — so two semantically identical
 * requests with different key orders or non-deterministic metadata produce
 * the same cache key.
 *
 * Exactly one of `messages` (chat-shaped) or `input` (everything else —
 * embeddings, audio, image generation, agent tool-call args, OpenAI
 * `responses.create`) must be supplied. Passing both throws
 * `CACHE_INVALID_OPTIONS`.
 *
 * Fields beyond `model`/`messages`/`input`/`params` are optional but
 * always included when present, so passing `{ params: { temperature: 0 } }`
 * versus `{ params: { temperature: 0, top_p: 1 } }` produces DIFFERENT
 * keys (different params can produce different completions).
 */
export interface CacheRequest {
  readonly model: string;
  /** Chat-shaped requests. Mutually exclusive with `input`. */
  readonly messages?: readonly ChatMessage[];
  /**
   * Non-chat payloads — embeddings, audio buffers, image prompts, agent
   * tool-call args. Hashed via the same canonicalizer as `messages`.
   */
  readonly input?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Override `CacheOptions.namespace` for this call. */
  readonly namespace?: string;
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  /**
   * Free-form metadata. The entire `metadata` subtree is excluded from the
   * hash by default (`WrapOptions.ignoreFields` defaults to
   * `['id', 'request_id', 'metadata']`). Use it for tenant ids, trace
   * spans, request ids — anything that should ride along with the entry
   * without affecting the cache key.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Per-call usage record. Adapters extract this automatically from provider
 * responses; manual `wrap()` callers can supply it via `WrapOptions.usage`.
 * Drives `stats().savedUSD` accounting on cache hits.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served from provider-side prompt caching (Anthropic/OpenAI). */
  readonly cachedInputTokens?: number;
}

/**
 * Versioned wire format. Loaders that see `v !== 1` treat the entry as a
 * miss — forward-compat for v0.2 schema bumps that change the canonical
 * form without invalidating fresh writes.
 */
export interface CacheEntry<T = unknown> {
  readonly v: 1;
  readonly value: T;
  readonly exp: number;
  readonly createdAt: number;
  readonly tags?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly usage?: TokenUsage;
}

/** Read-only projection of an entry passed to predicate-based invalidation. */
export interface CacheEntryView {
  readonly key: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly exp: number;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** Storage-level capability flags negotiated by features that need them. */
export interface StorageCapabilities {
  readonly prefixScan?: boolean;
  readonly tagIndex?: boolean;
  readonly vectorSearch?: boolean;
  readonly maxValueBytes?: number;
}

export interface VectorRecord {
  readonly id: string;
  readonly vector: Float32Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface VectorSearchHit {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Optional per-adapter hook that round-trips raw bytes through an
 * encode/decode pair on every persist/load. Lets users plug in AES-GCM-
 * with-KMS or gzip without forking the adapter.
 *
 * Round-trip is `decode(encode(bytes)) === bytes`. The cache layer never
 * inspects the bytes; it only round-trips them through this pair.
 */
export interface TransformAtRest {
  encode(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decode(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/**
 * Bring-your-own storage. Implement these methods and you have a
 * fully-featured backend.
 *
 * Implementations should:
 *   - return `undefined` for missing keys (never throw);
 *   - throw a `StorageError` (or any `Error` — wrapped automatically) for
 *     transient failures so the cache layer can apply graceful degradation;
 *   - honor the TTL passed to `set()` precisely; KV stores with coarse TTL
 *     granularity should round up, not down.
 */
export interface CacheStorage {
  readonly name: string;
  readonly capabilities?: StorageCapabilities;

  get(key: string): Promise<CacheEntry<unknown> | undefined>;
  set(key: string, entry: CacheEntry<unknown>, ttlMs: number): Promise<void>;
  delete(key: string): Promise<boolean>;

  mget?(keys: readonly string[]): Promise<ReadonlyArray<CacheEntry<unknown> | undefined>>;
  mset?(entries: ReadonlyArray<{ key: string; entry: CacheEntry<unknown>; ttlMs: number }>): Promise<void>;
  mdelete?(keys: readonly string[]): Promise<number>;

  invalidate(pattern: InvalidationPattern): Promise<number>;
  clear(): Promise<number>;

  vectorSearch?(query: Float32Array, topK: number, namespace?: string): Promise<readonly VectorSearchHit[]>;
  vectorUpsert?(records: readonly VectorRecord[]): Promise<void>;
  vectorDelete?(ids: readonly string[]): Promise<number>;

  dispose?(): Promise<void>;
}

/** Pattern accepted by `cache.invalidate()` and `storage.invalidate()`. */
export type InvalidationPattern =
  | { readonly key: string }
  | { readonly prefix: string }
  | { readonly tag: string }
  | { readonly predicate: (entry: CacheEntryView) => boolean };

/** Pricing for a single model in dollars per 1,000,000 tokens. */
export interface ModelPricing {
  readonly inputUSDPer1M: number;
  readonly outputUSDPer1M: number;
  /** Discounted rate for cached input tokens under provider-side prompt caching. */
  readonly cachedInputUSDPer1M?: number;
  /** ISO-8601 snapshot date for provenance. */
  readonly pricingDate?: string;
}

/** Per-model savings totals. */
export interface CostSavings {
  readonly hits: number;
  readonly savedTokens: { readonly input: number; readonly output: number };
  readonly savedUSD: number;
}

/** Frozen statistics view returned by `cache.stats()`. */
export interface CacheStatsSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly errors: number;
  readonly coalesced: number;
  readonly savedTokens: { readonly input: number; readonly output: number };
  readonly savedUSD: number;
  readonly embeddingCostUSD: number;
  readonly netSavedUSD: number;
  readonly byModel: Readonly<Record<string, CostSavings>>;
  readonly since: number;
  readonly until: number;
}

export type CacheEventName = 'hit' | 'miss' | 'set' | 'evict' | 'error' | 'coalesce';

export type CacheEventListener<E extends CacheEventName> =
  E extends 'hit'
    ? (e: {
        readonly key: string;
        readonly from: 'exact' | 'semantic';
        readonly similarity?: number;
        readonly entry: CacheEntryView;
      }) => void
    : E extends 'miss'
      ? (e: { readonly key: string; readonly reason: 'not-found' | 'expired' }) => void
      : E extends 'set'
        ? (e: { readonly key: string; readonly ttl: number; readonly bytes?: number }) => void
        : E extends 'evict'
          ? (e: { readonly key: string; readonly reason: 'capacity' | 'ttl' | 'manual' }) => void
          : E extends 'error'
            ? (e: { readonly error: CacheError; readonly operation: string }) => void
            : E extends 'coalesce'
              ? (e: { readonly key: string; readonly waiters: number }) => void
              : never;

/**
 * Distributed mutex used to share single-flight coalescing across processes.
 * The interface is intentionally narrow — `acquire()` returns a `release`
 * function which must be safe to call multiple times.
 *
 * Implementations ship under `./storage/redis` (`redisLock`) and
 * `./storage/upstash` (`upstashLock`). The default lock inside `createCache`
 * is an in-process no-op — coalescing still works within one runtime, but
 * multi-pod deployments fall back to per-pod coalescing unless a real lock
 * is supplied.
 */
export interface DistributedLock {
  acquire(
    key: string,
    opts?: { readonly waitMs?: number; readonly ttlMs?: number },
  ): Promise<{
    readonly held: boolean;
    readonly release: () => Promise<void>;
  }>;
}

export interface TTLPolicy {
  readonly default: number;
  readonly sliding?: boolean;
  readonly maxAgeMs?: number;
}

/** Options accepted by `createCache()`. See JSDoc on individual fields. */
export interface CacheOptions {
  readonly storage: CacheStorage;
  readonly ttl?: TTLPolicy;
  readonly perModelTTL?: Readonly<Record<string, number>>;
  readonly perNamespaceTTL?: Readonly<Record<string, number>>;
  readonly ttlJitter?: number;
  readonly namespace?: string;
  readonly keyPolicy?: (request: CacheRequest) => string;
  readonly costTracking?: boolean;
  readonly coalesce?:
    | boolean
    | {
        readonly lock?: DistributedLock;
        readonly abortPolicy?: 'leader-only' | 'shared';
      };
  readonly semantic?: SemanticLayer;
  readonly onError?: 'silent' | 'throw';
  readonly clock?: { now(): number };
  readonly fetch?: typeof fetch;
}

export interface WrapOptions {
  readonly ttl?: number;
  readonly tags?: readonly string[];
  readonly skipLookup?: boolean;
  readonly skipWrite?: boolean;
  readonly ignoreFields?: readonly string[];
  readonly usage?: TokenUsage;
  readonly signal?: AbortSignal;
}

export interface SetOptions {
  readonly ttl?: number;
  readonly tags?: readonly string[];
  readonly usage?: TokenUsage;
}

export interface WrapStreamOptions<TChunk> extends WrapOptions {
  readonly serializer: ChunkSerializer<TChunk>;
  readonly chunkDelayMs?: 'preserve' | 'instant' | number;
}

/**
 * The runtime cache object. Construct via `createCache(...)`.
 *
 * Aliased as `LLMCache` for npm SEO. Half the use cases (tool-call dedup,
 * embedding cache, RAG retrieval cache) are not strictly LLM responses,
 * so `Cache` ages better; `LLMCache` is the discoverable name.
 */
export interface Cache {
  /**
   * Cache the result of `fn()` keyed by the canonical hash of `request`.
   *
   * @param request Provider-neutral request.
   * @param fn Function executed on cache miss.
   * @param options Optional TTL/tags/skip overrides.
   * @returns The cached or freshly-computed value, typed exactly as `fn`.
   * @throws Live errors thrown by `fn` (never swallowed). Cache-layer
   *   errors are silenced by default; set `onError: 'throw'` to escalate.
   *
   * @example
   * const reply = await cache.wrap(
   *   { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] },
   *   () => openai.chat.completions.create({ model: 'gpt-4o', messages }),
   * );
   */
  wrap<T>(request: CacheRequest, fn: () => Promise<T>, options?: WrapOptions): Promise<T>;

  /**
   * Cache a streaming response. Returns a `ReadableStream<TChunk>` either way:
   * misses tee the upstream stream so the consumer reads chunks in real time
   * while the cache accumulates them in the background; hits replay from a
   * stored array via a fresh stream with optional cadence preservation.
   *
   * Nothing is cached if the upstream errors mid-stream.
   *
   * @param request Provider-neutral request.
   * @param fn Function returning the upstream `ReadableStream`.
   * @param options Required `serializer`; optional `chunkDelayMs`.
   * @returns A consumer-side `ReadableStream<TChunk>`.
   * @throws Live errors thrown by `fn`. Cache failures are silenced by default.
   */
  wrapStream<TChunk>(
    request: CacheRequest,
    fn: () => Promise<ReadableStream<TChunk>> | ReadableStream<TChunk>,
    options: WrapStreamOptions<TChunk>,
  ): Promise<ReadableStream<TChunk>>;

  /**
   * Non-throwing mirror of `wrap()` returning a `Result<T, CacheError>`.
   * Useful when `onError: 'throw'` is the global default but a specific
   * call site wants graceful handling.
   *
   * @param request Provider-neutral request.
   * @param fn Function executed on cache miss.
   * @param options Optional TTL/tags/skip overrides.
   * @returns A `Result` whose error arm carries the typed `CacheError`.
   * @throws Never throws; live errors from `fn` are wrapped into `Result.err`.
   */
  tryWrap<T>(
    request: CacheRequest,
    fn: () => Promise<T>,
    options?: WrapOptions,
  ): Promise<Result<T, CacheError>>;

  /**
   * Non-throwing mirror of `wrapStream()`.
   *
   * @param request Provider-neutral request.
   * @param fn Function returning the upstream `ReadableStream`.
   * @param options Required `serializer`; optional `chunkDelayMs`.
   * @returns A `Result` whose error arm carries the typed `CacheError`.
   */
  tryWrapStream<TChunk>(
    request: CacheRequest,
    fn: () => Promise<ReadableStream<TChunk>> | ReadableStream<TChunk>,
    options: WrapStreamOptions<TChunk>,
  ): Promise<Result<ReadableStream<TChunk>, CacheError>>;

  /**
   * Low-level read. Returns the cached value if a non-expired entry exists,
   * else `undefined`. Does not trigger coalescing — use `wrap` for that.
   *
   * @param request Provider-neutral request.
   * @returns The stored value or `undefined`.
   */
  get<T = unknown>(request: CacheRequest): Promise<T | undefined>;

  /**
   * Low-level write. Stores `value` under the canonical hash of `request`.
   *
   * @param request Provider-neutral request.
   * @param value Value to store.
   * @param options Optional TTL/tags/usage overrides.
   */
  set<T>(request: CacheRequest, value: T, options?: SetOptions): Promise<void>;

  /**
   * Delete a single cached entry by request.
   *
   * @param request Provider-neutral request.
   * @returns `true` if anything was removed.
   */
  delete(request: CacheRequest): Promise<boolean>;

  /**
   * Programmatic invalidation. Storage adapters route to the most efficient
   * backend operation (Redis SCAN+DEL, KV bulk delete, in-memory iterate).
   *
   * @param pattern One of `{ key }`, `{ prefix }`, `{ tag }`, `{ predicate }`.
   * @returns The count of removed entries.
   */
  invalidate(pattern: InvalidationPattern): Promise<number>;

  /**
   * Clear the entire namespace. Use with care.
   *
   * @returns The count of removed entries.
   */
  clear(): Promise<number>;

  /**
   * Snapshot of the cache statistics. Frozen, safe to log or serialize.
   *
   * @returns A `CacheStatsSnapshot` capturing totals and per-model breakdown.
   */
  stats(): CacheStatsSnapshot;

  /** Reset stats counters to zero. Does not affect stored entries. */
  resetStats(): void;

  /**
   * Subscribe to cache events.
   *
   * @param event Event name.
   * @param listener Listener function.
   * @returns Synchronous unsubscribe.
   */
  on<E extends CacheEventName>(event: E, listener: CacheEventListener<E>): () => void;

  /**
   * Await every pending background write (streaming captures, KV writes
   * scheduled via `ctx.waitUntil()`). Edge handlers should call this before
   * returning a `Response` if they need writes to be durable across early
   * termination. Idempotent and cheap when nothing is in flight.
   */
  flush(): Promise<void>;

  /**
   * Async cleanup — `flush()`es pending writes, drains in-flight coalescing
   * entries, awaits the storage's `dispose()`, removes event listeners.
   * After `dispose()` every method throws `ConfigError(CACHE_DISPOSED)`.
   */
  dispose(): Promise<void>;
}

/** Alias of {@link Cache}. Re-exported for SEO and call-site clarity. */
export type LLMCache = Cache;

/**
 * Internal hook used by `createCache` to install the optional semantic
 * layer. Public types only see `withSemantic()` returning a `SemanticLayer`.
 */
export interface SemanticLayer {
  readonly _install: (cache: Cache, storage: CacheStorage) => SemanticLayerHandle;
}

/**
 * Handle returned by `_install`. The cache layer calls these on every
 * `wrap()` to extend the lookup with embedding-based matches.
 */
export interface SemanticLayerHandle {
  readonly enabled: boolean;
  readonly lookup: (
    request: CacheRequest,
    canonicalText: string,
  ) => Promise<{ readonly hit: false } | { readonly hit: true; readonly value: unknown; readonly key: string; readonly similarity: number }>;
  readonly index: (
    request: CacheRequest,
    canonicalText: string,
    key: string,
  ) => Promise<void>;
  readonly embeddingCostUSD: () => number;
  readonly dispose?: () => Promise<void>;
}
