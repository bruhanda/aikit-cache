import { ConfigError } from '../errors/config-error.js';
import { CacheError } from '../errors/base.js';
import { StorageError } from '../errors/storage-error.js';
import { StreamError } from '../errors/stream-error.js';
import { computeCost } from '../cost/tracker.js';
import { getPricing } from '../cost/pricing-registry.js';
import { defaultClock, type Clock } from '../internal/clock.js';
import { err, ok, type Result } from '../types/result.js';
import { Coalescer, noopDistributedLock } from './coalesce.js';
import { EventBus } from './events.js';
import { isValidEntry, makeEntry, refreshSliding } from './envelope.js';
import { hashRequest } from './key.js';
import { assertValidPattern } from './invalidate.js';
import { applyJitter, resolveTTL, validateTTL, DEFAULT_TTL_JITTER, DEFAULT_TTL_MS } from './ttl.js';
import {
  deserializeStreamEnvelope,
  replayStream,
  serializeStreamEnvelope,
  teeWithCapture,
  type StreamEnvelope,
} from './stream.js';
import type {
  Cache,
  CacheEntry,
  CacheOptions,
  CacheRequest,
  CacheStatsSnapshot,
  CacheEventName,
  CacheEventListener,
  CacheStorage,
  DistributedLock,
  InvalidationPattern,
  SemanticLayerHandle,
  SetOptions,
  TokenUsage,
  WrapOptions,
  WrapStreamOptions,
} from './types.js';
import { StatsAccumulator } from './stats.js';

/**
 * Create an LLM response cache with pluggable storage, semantic layer, cost
 * tracking, in-flight coalescing, and per-model TTL.
 *
 * The returned `Cache` is fully type-safe — `wrap<T>(req, fn)` infers `T`
 * from `fn`'s return type, with no `unknown` widening at the cache
 * boundary. Storage and embedding adapters are typed end-to-end via
 * generics.
 *
 * The cache **never blocks the underlying LLM call** on a storage failure.
 * If `get`/`set` throws, the live `fn()` result is returned and the error
 * is surfaced via the `'error'` event (or thrown if `onError: 'throw'`).
 *
 * @param options Cache configuration; see `CacheOptions`.
 * @returns A fully wired `Cache` instance.
 * @throws {ConfigError} `CACHE_INVALID_OPTIONS` for missing/invalid options.
 *
 * @example
 * const cache = createCache({
 *   storage: memoryStorage({ max: 10_000 }),
 *   ttl: { default: 3_600_000 },
 *   perModelTTL: { 'gpt-4o': 86_400_000 },
 * });
 *
 * const reply = await cache.wrap(
 *   { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] },
 *   () => openai.chat.completions.create({ model: 'gpt-4o', messages }),
 * );
 */
export function createCache(options: CacheOptions): Cache {
  if (!options || typeof options !== 'object') {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'createCache requires an options object');
  }
  if (!options.storage) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'createCache requires a `storage` adapter', { field: 'storage' });
  }
  if (options.ttl?.default !== undefined) validateTTL(options.ttl.default);
  if (options.perModelTTL) for (const v of Object.values(options.perModelTTL)) validateTTL(v);
  if (options.perNamespaceTTL) for (const v of Object.values(options.perNamespaceTTL)) validateTTL(v);
  if (options.namespace !== undefined && options.namespace.length === 0) {
    throw new ConfigError('CONFIG_INVALID_NAMESPACE', '`namespace` must be a non-empty string', { field: 'namespace' });
  }
  if (options.ttlJitter !== undefined && (options.ttlJitter < 0 || options.ttlJitter > 1)) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', '`ttlJitter` must be in [0, 1]', { field: 'ttlJitter' });
  }

  const clock: Clock = options.clock ?? defaultClock;
  const events = new EventBus();
  const coalescer = new Coalescer<unknown>();
  const stats = new StatsAccumulator(clock.now());
  const onError: 'silent' | 'throw' = options.onError ?? 'silent';
  const ttlJitter = options.ttlJitter ?? DEFAULT_TTL_JITTER;
  const costTracking = options.costTracking ?? true;
  const coalesceConfig = normalizeCoalesce(options.coalesce);
  const lock: DistributedLock = coalesceConfig.lock ?? noopDistributedLock;
  const ttlPolicy = options.ttl ?? { default: DEFAULT_TTL_MS };
  const namespace = options.namespace;
  const keyPolicy = options.keyPolicy;
  const storage = options.storage;
  const semantic: SemanticLayerHandle | undefined = options.semantic?._install(undefined as unknown as Cache, storage);
  const pendingWrites = new Set<Promise<unknown>>();

  let disposed = false;
  const assertNotDisposed = (): void => {
    if (disposed) throw new ConfigError('CACHE_DISPOSED', 'cache has been disposed');
  };

  const reportError = (error: unknown, operation: string): void => {
    const cacheError = wrapError(error, operation);
    stats.recordError();
    events.emit('error', { error: cacheError, operation });
    if (onError === 'throw') throw cacheError;
  };

  const resolveNamespace = (request: CacheRequest): string | undefined => {
    if (keyPolicy) {
      const ns = keyPolicy(request);
      if (typeof ns !== 'string' || ns.length === 0) {
        throw new ConfigError(
          'CONFIG_INVALID_NAMESPACE',
          'keyPolicy returned an empty namespace; refusing to mix data across tenants',
        );
      }
      return ns;
    }
    return request.namespace ?? namespace;
  };

  const buildKey = async (request: CacheRequest, options?: WrapOptions): Promise<string> => {
    const ns = resolveNamespace(request);
    const opts: { namespace?: string; ignoreFields?: readonly string[] } = {};
    if (ns !== undefined) opts.namespace = ns;
    if (options?.ignoreFields !== undefined) opts.ignoreFields = options.ignoreFields;
    return hashRequest(request, opts);
  };

  const computeTTL = (request: CacheRequest, override?: number): number => {
    const ns = resolveNamespace(request);
    return resolveTTL({
      model: request.model,
      ...(ns !== undefined ? { namespace: ns } : {}),
      ...(override !== undefined ? { override } : {}),
      policy: ttlPolicy,
      ...(options.perModelTTL ? { perModelTTL: options.perModelTTL } : {}),
      ...(options.perNamespaceTTL ? { perNamespaceTTL: options.perNamespaceTTL } : {}),
    });
  };

  const tryGet = async (key: string): Promise<CacheEntry<unknown> | undefined> => {
    try {
      const raw = await storage.get(key);
      if (raw === undefined) return undefined;
      if (!isValidEntry(raw)) {
        reportError(
          new StorageError('STORAGE_PARSE_FAILED', 'get', storage.name, 'invalid envelope shape', { key }),
          'get',
        );
        return undefined;
      }
      if (raw.exp <= clock.now()) {
        events.emit('miss', { key, reason: 'expired' });
        return undefined;
      }
      return raw;
    } catch (e) {
      reportError(e, 'get');
      return undefined;
    }
  };

  const trySet = async (
    key: string,
    entry: CacheEntry<unknown>,
    ttlMs: number,
  ): Promise<void> => {
    try {
      await storage.set(key, entry, ttlMs);
      events.emit('set', { key, ttl: ttlMs });
    } catch (e) {
      reportError(e, 'set');
    }
  };

  const recordHit = (
    request: CacheRequest,
    entry: CacheEntry<unknown>,
    key: string,
    from: 'exact' | 'semantic',
    similarity?: number,
  ): void => {
    let savedUSD = 0;
    if (costTracking && entry.usage) {
      const pricing = getPricing(request.model);
      if (pricing) savedUSD = computeCost(pricing, entry.usage);
    }
    stats.recordHit(request.model, entry.usage, savedUSD);
    const view = {
      key,
      tags: entry.tags ?? [],
      createdAt: entry.createdAt,
      exp: entry.exp,
      meta: entry.meta ?? {},
    };
    const payload =
      similarity === undefined
        ? { key, from, entry: view }
        : { key, from, similarity, entry: view };
    events.emit('hit', payload);
  };

  const trackPending = <T>(promise: Promise<T>): Promise<T> => {
    pendingWrites.add(promise);
    promise.finally(() => pendingWrites.delete(promise));
    return promise;
  };

  const cache: Cache = {
    async wrap<T>(request: CacheRequest, fn: () => Promise<T>, opts?: WrapOptions): Promise<T> {
      assertNotDisposed();
      if (opts?.signal?.aborted) throw abortError(opts.signal.reason);

      const key = await buildKey(request, opts);

      if (!opts?.skipLookup) {
        const cached = await tryGet(key);
        if (cached) {
          if (ttlPolicy.sliding) {
            const ttl = computeTTL(request, opts?.ttl);
            const refreshed = refreshSliding(cached, ttl, clock.now(), ttlPolicy.maxAgeMs);
            if (refreshed !== cached) {
              trackPending(trySet(key, refreshed, ttl));
            }
          }
          recordHit(request, cached, key, 'exact');
          return cached.value as T;
        }
        events.emit('miss', { key, reason: 'not-found' });

        if (semantic?.enabled) {
          try {
            const canonicalText = '';
            const semHit = await semantic.lookup(request, canonicalText);
            if (semHit.hit) {
              const synth: CacheEntry<unknown> = makeEntry(semHit.value, computeTTL(request, opts?.ttl), clock.now());
              recordHit(request, synth, semHit.key, 'semantic', semHit.similarity);
              return semHit.value as T;
            }
          } catch (e) {
            reportError(e, 'semantic-lookup');
          }
        }
      }

      const exec = async (): Promise<T> => {
        const value = await fn();
        if (!opts?.skipWrite) {
          const ttlBase = computeTTL(request, opts?.ttl);
          const ttl = applyJitter(ttlBase, ttlJitter);
          const usage = opts?.usage ?? extractUsage(value);
          const extras: { tags?: readonly string[]; usage?: TokenUsage } = {};
          if (opts?.tags) extras.tags = opts.tags;
          if (usage) extras.usage = usage;
          const entry = makeEntry(value, ttl, clock.now(), extras);
          trackPending(trySet(key, entry, ttl));
          if (semantic?.enabled) {
            trackPending(
              (async () => {
                try {
                  await semantic.index(request, '', key);
                } catch (e) {
                  reportError(e, 'semantic-index');
                }
              })(),
            );
          }
        }
        stats.recordMiss();
        return value;
      };

      const lockHandle = await lock.acquire(key, { ttlMs: 30_000 });
      try {
        return await coalescer.dedupe(key, async () => {
          const waiters = coalescer.waiters(key);
          if (waiters > 0) {
            stats.recordCoalesce(waiters);
            events.emit('coalesce', { key, waiters });
          }
          if (lockHandle.held) return exec();
          const recheck = await tryGet(key);
          if (recheck) {
            recordHit(request, recheck, key, 'exact');
            return recheck.value as T;
          }
          return exec();
        }) as Promise<T>;
      } finally {
        await lockHandle.release();
      }
    },

    async wrapStream<TChunk>(
      request: CacheRequest,
      fn: () => Promise<ReadableStream<TChunk>> | ReadableStream<TChunk>,
      opts: WrapStreamOptions<TChunk>,
    ): Promise<ReadableStream<TChunk>> {
      assertNotDisposed();
      if (!opts || !opts.serializer) {
        throw new StreamError('STREAM_SERIALIZER_MISSING', 'wrapStream requires a `serializer` option');
      }
      if (opts.signal?.aborted) throw abortError(opts.signal.reason);

      const key = await buildKey(request, opts);

      if (!opts.skipLookup) {
        const cached = await tryGet(key);
        if (cached) {
          try {
            const envelope = cached.value as StreamEnvelope;
            const { chunks, timings } = deserializeStreamEnvelope(opts.serializer, envelope);
            recordHit(request, cached, key, 'exact');
            return replayStream(chunks, timings, opts.chunkDelayMs ?? 'instant');
          } catch (e) {
            reportError(e, 'stream-replay');
            try {
              await storage.delete(key);
            } catch {
              // best effort
            }
          }
        } else {
          events.emit('miss', { key, reason: 'not-found' });
        }
      }

      const upstream = await fn();
      const { consumer, captured } = teeWithCapture(upstream, () => clock.now());

      if (!opts.skipWrite) {
        trackPending(
          (async () => {
            try {
              const { chunks, timings } = await captured;
              const envelope = serializeStreamEnvelope(opts.serializer, chunks, timings);
              const ttlBase = computeTTL(request, opts.ttl);
              const ttl = applyJitter(ttlBase, ttlJitter);
              const extras: {
                tags?: readonly string[];
                meta?: Readonly<Record<string, unknown>>;
                usage?: TokenUsage;
              } = {
                meta: { serializerId: opts.serializer.id },
              };
              if (opts.tags) extras.tags = opts.tags;
              if (opts.usage) extras.usage = opts.usage;
              const entry = makeEntry<StreamEnvelope>(envelope, ttl, clock.now(), extras);
              await trySet(key, entry, ttl);
            } catch (e) {
              reportError(e, 'stream-capture');
            }
          })(),
        );
      }

      stats.recordMiss();
      return consumer;
    },

    async tryWrap<T>(
      request: CacheRequest,
      fn: () => Promise<T>,
      opts?: WrapOptions,
    ): Promise<Result<T, CacheError>> {
      try {
        const value = await this.wrap<T>(request, fn, opts);
        return ok(value);
      } catch (e) {
        return err(wrapError(e, 'wrap'));
      }
    },

    async tryWrapStream<TChunk>(
      request: CacheRequest,
      fn: () => Promise<ReadableStream<TChunk>> | ReadableStream<TChunk>,
      opts: WrapStreamOptions<TChunk>,
    ): Promise<Result<ReadableStream<TChunk>, CacheError>> {
      try {
        const stream = await this.wrapStream<TChunk>(request, fn, opts);
        return ok(stream);
      } catch (e) {
        return err(wrapError(e, 'wrapStream'));
      }
    },

    async get<T = unknown>(request: CacheRequest): Promise<T | undefined> {
      assertNotDisposed();
      const key = await buildKey(request);
      const entry = await tryGet(key);
      return entry?.value as T | undefined;
    },

    async set<T>(request: CacheRequest, value: T, opts?: SetOptions): Promise<void> {
      assertNotDisposed();
      const key = await buildKey(request);
      const ttlBase = computeTTL(request, opts?.ttl);
      const ttl = applyJitter(ttlBase, ttlJitter);
      const extras: { tags?: readonly string[]; usage?: TokenUsage } = {};
      if (opts?.tags) extras.tags = opts.tags;
      if (opts?.usage) extras.usage = opts.usage;
      const entry = makeEntry(value, ttl, clock.now(), extras);
      await trySet(key, entry, ttl);
    },

    async delete(request: CacheRequest): Promise<boolean> {
      assertNotDisposed();
      const key = await buildKey(request);
      try {
        const removed = await storage.delete(key);
        if (removed) events.emit('evict', { key, reason: 'manual' });
        return removed;
      } catch (e) {
        reportError(e, 'delete');
        return false;
      }
    },

    async invalidate(pattern: InvalidationPattern): Promise<number> {
      assertNotDisposed();
      const validated = assertValidPattern(pattern);
      try {
        return await storage.invalidate(validated);
      } catch (e) {
        reportError(e, 'invalidate');
        return 0;
      }
    },

    async clear(): Promise<number> {
      assertNotDisposed();
      try {
        return await storage.clear();
      } catch (e) {
        reportError(e, 'clear');
        return 0;
      }
    },

    stats(): CacheStatsSnapshot {
      const embedding = semantic?.embeddingCostUSD?.() ?? 0;
      return stats.snapshot(clock.now(), embedding);
    },

    resetStats(): void {
      stats.reset(clock.now());
    },

    on<E extends CacheEventName>(event: E, listener: CacheEventListener<E>): () => void {
      return events.on(event, listener);
    },

    async flush(): Promise<void> {
      const pending = Array.from(pendingWrites);
      await Promise.allSettled(pending);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await this.flush();
      await coalescer.drain();
      try {
        await storage.dispose?.();
      } catch (e) {
        reportError(e, 'dispose');
      }
      try {
        await semantic?.dispose?.();
      } catch (e) {
        reportError(e, 'dispose');
      }
      events.clear();
    },
  };

  return cache;
}

const normalizeCoalesce = (
  value: CacheOptions['coalesce'],
): { enabled: boolean; lock?: DistributedLock; abortPolicy: 'leader-only' | 'shared' } => {
  if (value === false) return { enabled: false, abortPolicy: 'leader-only' };
  if (value === true || value === undefined) return { enabled: true, abortPolicy: 'leader-only' };
  return {
    enabled: true,
    ...(value.lock !== undefined ? { lock: value.lock } : {}),
    abortPolicy: value.abortPolicy ?? 'leader-only',
  };
};

const wrapError = (error: unknown, operation: string): CacheError => {
  if (error instanceof CacheError) return error;
  if (error instanceof Error) {
    return new StorageError('STORAGE_BACKEND_UNAVAILABLE', mapOperation(operation), 'unknown', error.message, {
      cause: error,
    });
  }
  return new StorageError('STORAGE_BACKEND_UNAVAILABLE', mapOperation(operation), 'unknown', String(error));
};

const mapOperation = (operation: string): 'get' | 'set' | 'delete' | 'invalidate' | 'clear' | 'vectorSearch' | 'vectorUpsert' | 'mget' | 'mset' | 'mdelete' | 'vectorDelete' => {
  switch (operation) {
    case 'get':
    case 'set':
    case 'delete':
    case 'invalidate':
    case 'clear':
    case 'vectorSearch':
    case 'vectorUpsert':
      return operation;
    default:
      return 'get';
  }
};

const abortError = (reason: unknown): Error => {
  if (reason instanceof Error) return reason;
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
};

/**
 * Best-effort extraction of `TokenUsage` from a provider response. Recognizes
 * OpenAI's `usage` and Anthropic's `usage` shapes; returns `undefined` for
 * anything else so the cache layer can still record the entry without
 * polluting cost stats with guesses.
 */
function extractUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const usage = v['usage'];
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;

  const promptTokens = numericField(u, 'prompt_tokens') ?? numericField(u, 'input_tokens');
  const completionTokens = numericField(u, 'completion_tokens') ?? numericField(u, 'output_tokens');
  const cachedTokens =
    numericField(u, 'cached_tokens') ??
    numericField(u, 'cache_read_input_tokens') ??
    extractCachedFromDetails(u);

  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const out: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
  };
  if (cachedTokens !== undefined) out.cachedInputTokens = cachedTokens;
  return out;
}

function numericField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function extractCachedFromDetails(usage: Record<string, unknown>): number | undefined {
  const details = usage['prompt_tokens_details'];
  if (details && typeof details === 'object') {
    const cached = (details as Record<string, unknown>)['cached_tokens'];
    if (typeof cached === 'number') return cached;
  }
  return undefined;
}
