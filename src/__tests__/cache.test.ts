import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createCache } from '../core/cache.js';
import { memoryStorage } from '../storage/memory.js';
import { ConfigError } from '../errors/config-error.js';
import { CacheError } from '../errors/base.js';
import { StorageError } from '../errors/storage-error.js';
import { isErr, isOk } from '../types/result.js';
import type { Cache, CacheRequest, CacheStorage, SemanticLayer } from '../core/types.js';
import type { ChunkSerializer } from '../types/stream.js';

let now = 1_000_000;
const clock = { now: () => now };

const userMessage = (text: string): CacheRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content: text }],
});

const newCache = (overrides: Partial<Parameters<typeof createCache>[0]> = {}): Cache =>
  createCache({
    storage: memoryStorage({ clock }),
    clock,
    ttlJitter: 0,
    ...overrides,
  });

beforeEach(() => {
  now = 1_000_000;
});

describe('createCache option validation', () => {
  it('should throw when options is missing or invalid', () => {
    expect(() => createCache(undefined as never)).toThrow(ConfigError);
    expect(() => createCache(null as never)).toThrow(ConfigError);
  });

  it('should throw when storage is missing', () => {
    expect(() => createCache({} as never)).toThrow(ConfigError);
  });

  it('should throw on invalid default TTL', () => {
    expect(() => createCache({ storage: memoryStorage(), ttl: { default: -1 } })).toThrow(
      ConfigError,
    );
  });

  it('should throw on invalid perModelTTL value', () => {
    expect(() =>
      createCache({ storage: memoryStorage(), perModelTTL: { x: -1 } }),
    ).toThrow(ConfigError);
  });

  it('should throw on invalid perNamespaceTTL value', () => {
    expect(() =>
      createCache({ storage: memoryStorage(), perNamespaceTTL: { ns: NaN } }),
    ).toThrow(ConfigError);
  });

  it('should throw on empty namespace', () => {
    expect(() => createCache({ storage: memoryStorage(), namespace: '' })).toThrow(ConfigError);
  });

  it('should throw on jitter outside [0, 1]', () => {
    expect(() => createCache({ storage: memoryStorage(), ttlJitter: -0.1 })).toThrow(ConfigError);
    expect(() => createCache({ storage: memoryStorage(), ttlJitter: 1.5 })).toThrow(ConfigError);
  });
});

describe('cache.wrap (exact-match)', () => {
  it('should call fn on miss and cache the result for the next call', async () => {
    const cache = newCache();
    const fn = vi.fn().mockResolvedValue('result');
    const out1 = await cache.wrap(userMessage('hi'), fn);
    const out2 = await cache.wrap(userMessage('hi'), fn);
    expect(out1).toBe('result');
    expect(out2).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    await cache.dispose();
  });

  it('should infer the return type from fn', async () => {
    const cache = newCache();
    const result = await cache.wrap(userMessage('hi'), async () => 42);
    expectTypeOf(result).toEqualTypeOf<number>();
    await cache.dispose();
  });

  it('should return cache miss when an entry has expired', async () => {
    const cache = newCache({ ttl: { default: 1000 } });
    const fn = vi.fn().mockResolvedValue('fresh');
    await cache.wrap(userMessage('hi'), fn);
    now += 2000;
    const fresh = await cache.wrap(userMessage('hi'), () => Promise.resolve('again'));
    expect(fresh).toBe('again');
    await cache.dispose();
  });

  it('should propagate live errors thrown by fn', async () => {
    const cache = newCache();
    await expect(
      cache.wrap(userMessage('hi'), async () => {
        throw new Error('upstream');
      }),
    ).rejects.toThrow('upstream');
    await cache.dispose();
  });

  it('should respect skipLookup', async () => {
    const cache = newCache();
    const fn = vi.fn().mockResolvedValue('x');
    await cache.wrap(userMessage('hi'), fn);
    await cache.wrap(userMessage('hi'), fn, { skipLookup: true });
    expect(fn).toHaveBeenCalledTimes(2);
    await cache.dispose();
  });

  it('should respect skipWrite', async () => {
    const cache = newCache();
    const fn = vi.fn().mockResolvedValue('x');
    await cache.wrap(userMessage('hi'), fn, { skipWrite: true });
    await cache.wrap(userMessage('hi'), fn);
    expect(fn).toHaveBeenCalledTimes(2);
    await cache.dispose();
  });

  it('should accept ttl override per call', async () => {
    const cache = newCache({ ttl: { default: 60_000 } });
    const fn = vi.fn().mockResolvedValue('x');
    await cache.wrap(userMessage('hi'), fn, { ttl: 100 });
    now += 200;
    await cache.wrap(userMessage('hi'), fn);
    expect(fn).toHaveBeenCalledTimes(2);
    await cache.dispose();
  });

  it('should attach tags from options', async () => {
    const cache = newCache();
    await cache.wrap(userMessage('hi'), () => Promise.resolve('v'), { tags: ['t1', 't2'] });
    const removed = await cache.invalidate({ tag: 't1' });
    expect(removed).toBe(1);
    await cache.dispose();
  });

  it('should propagate AbortSignal that is already aborted', async () => {
    const cache = newCache();
    const ac = new AbortController();
    ac.abort();
    await expect(cache.wrap(userMessage('hi'), async () => 'x', { signal: ac.signal })).rejects.toThrow();
    await cache.dispose();
  });

  it('should call fn only once when many in-process callers race for the same key', async () => {
    const cache = newCache();
    const fn = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 5));
      return 'x';
    });
    const promises = Array.from({ length: 10 }, () => cache.wrap(userMessage('hi'), fn));
    const results = await Promise.all(promises);
    expect(results.every((r) => r === 'x')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    await cache.dispose();
  });

  it('should auto-extract OpenAI-style usage', async () => {
    const cache = newCache({
      costTracker: {
        estimateUSD: () => 0.5,
      },
    });
    await cache.wrap(userMessage('hi'), async () => ({
      reply: 'x',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
    await cache.wrap(userMessage('hi'), async () => ({}));
    const stats = cache.stats();
    expect(stats.savedUSD).toBeCloseTo(0.5, 6);
    expect(stats.savedTokens).toEqual({ input: 100, output: 50 });
    await cache.dispose();
  });

  it('should auto-extract Anthropic-style usage', async () => {
    const cache = newCache({ costTracker: { estimateUSD: () => 1 } });
    await cache.wrap(userMessage('a'), async () => ({
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    }));
    await cache.wrap(userMessage('a'), async () => ({}));
    const snap = cache.stats();
    expect(snap.savedUSD).toBeCloseTo(1, 6);
    expect(snap.savedTokens.input).toBe(10);
    await cache.dispose();
  });

  it('should support manual usage override via options.usage', async () => {
    const cache = newCache({ costTracker: { estimateUSD: () => 2 } });
    await cache.wrap(userMessage('a'), async () => 'v', {
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await cache.wrap(userMessage('a'), async () => 'v');
    expect(cache.stats().savedUSD).toBeCloseTo(2, 6);
    await cache.dispose();
  });

  it('should refresh sliding TTL on hit when configured', async () => {
    const cache = newCache({ ttl: { default: 1000, sliding: true } });
    await cache.wrap(userMessage('hi'), () => Promise.resolve('v'));
    now += 500;
    await cache.wrap(userMessage('hi'), () => Promise.resolve('v'));
    // After sliding refresh, exp should now be at now (500) + 1000 = 1500
    now += 999;
    const fn = vi.fn().mockResolvedValue('refresh');
    const out = await cache.wrap(userMessage('hi'), fn);
    expect(out).toBe('v');
    expect(fn).not.toHaveBeenCalled();
    await cache.dispose();
  });

  it('should reject empty request namespace', async () => {
    const cache = newCache();
    await expect(
      cache.wrap({ ...userMessage('hi'), namespace: '' }, async () => 'v'),
    ).rejects.toThrow(ConfigError);
    await cache.dispose();
  });

  it('should reject keyPolicy returning empty namespace', async () => {
    const cache = newCache({ keyPolicy: () => '' });
    await expect(cache.wrap(userMessage('hi'), async () => 'v')).rejects.toThrow(ConfigError);
    await cache.dispose();
  });

  it('should use keyPolicy namespace when provided', async () => {
    const cache = newCache({ keyPolicy: () => 'tenant-7' });
    const fn = vi.fn().mockResolvedValue('v');
    await cache.wrap(userMessage('hi'), fn);
    let listenerKey = '';
    cache.on('hit', (e) => {
      listenerKey = e.key;
    });
    await cache.wrap(userMessage('hi'), fn);
    expect(listenerKey.startsWith('tenant-7:')).toBe(true);
    await cache.dispose();
  });
});

describe('cache.tryWrap (Result-returning)', () => {
  it('should return Ok on success', async () => {
    const cache = newCache();
    const result = await cache.tryWrap(userMessage('hi'), async () => 'v');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBe('v');
    await cache.dispose();
  });

  it('should propagate non-CacheError thrown by fn', async () => {
    const cache = newCache();
    await expect(
      cache.tryWrap(userMessage('hi'), async () => {
        throw new Error('live');
      }),
    ).rejects.toThrow('live');
    await cache.dispose();
  });

  it('should return Err for cache-layer errors when onError is throw', async () => {
    const broken: CacheStorage = {
      ...memoryStorage(),
      name: 'broken',
      get: async () => {
        throw new Error('storage down');
      },
    };
    const cache = createCache({ storage: broken, onError: 'throw', ttlJitter: 0 });
    const result = await cache.tryWrap(userMessage('hi'), async () => 'v');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBeInstanceOf(CacheError);
    await cache.dispose();
  });
});

describe('cache.get / set / delete', () => {
  it('should round-trip values', async () => {
    const cache = newCache();
    await cache.set(userMessage('hi'), { foo: 'bar' });
    const out = await cache.get<{ foo: string }>(userMessage('hi'));
    expect(out).toEqual({ foo: 'bar' });
    await cache.dispose();
  });

  it('should return undefined for missing keys', async () => {
    const cache = newCache();
    expect(await cache.get(userMessage('miss'))).toBeUndefined();
    await cache.dispose();
  });

  it('should accept tags via SetOptions', async () => {
    const cache = newCache();
    await cache.set(userMessage('hi'), 'v', { tags: ['t'] });
    const removed = await cache.invalidate({ tag: 't' });
    expect(removed).toBe(1);
    await cache.dispose();
  });

  it('should report whether delete removed an entry', async () => {
    const cache = newCache();
    expect(await cache.delete(userMessage('hi'))).toBe(false);
    await cache.set(userMessage('hi'), 'v');
    expect(await cache.delete(userMessage('hi'))).toBe(true);
    await cache.dispose();
  });

  it('should emit evict event on manual delete', async () => {
    const cache = newCache();
    const events: string[] = [];
    cache.on('evict', (e) => events.push(`${e.key}|${e.reason}`));
    await cache.set(userMessage('hi'), 'v');
    await cache.delete(userMessage('hi'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('|manual');
    await cache.dispose();
  });
});

describe('cache.invalidate / clear', () => {
  it('should invalidate by key', async () => {
    const cache = newCache();
    await cache.set(userMessage('a'), 'v');
    expect(await cache.invalidate({ key: 'no-such' })).toBe(0);
    await cache.dispose();
  });

  it('should invalidate by predicate', async () => {
    const cache = newCache();
    await cache.set(userMessage('a'), 'v', { tags: ['t1'] });
    await cache.set(userMessage('b'), 'v', { tags: ['t2'] });
    const removed = await cache.invalidate({
      predicate: (entry) => entry.tags.includes('t1'),
    });
    expect(removed).toBe(1);
    await cache.dispose();
  });

  it('should reject invalid invalidation pattern', async () => {
    const cache = newCache();
    await expect(cache.invalidate({} as never)).rejects.toThrow();
    await cache.dispose();
  });

  it('should clear every entry', async () => {
    const cache = newCache();
    await cache.set(userMessage('a'), 'v');
    await cache.set(userMessage('b'), 'v');
    expect(await cache.clear()).toBe(2);
    expect(await cache.get(userMessage('a'))).toBeUndefined();
    await cache.dispose();
  });
});

describe('cache.stats', () => {
  it('should track hits and misses', async () => {
    const cache = newCache();
    await cache.wrap(userMessage('a'), () => Promise.resolve('v'));
    await cache.wrap(userMessage('a'), () => Promise.resolve('v'));
    const snap = cache.stats();
    expect(snap.hits).toBe(1);
    expect(snap.misses).toBe(1);
    await cache.dispose();
  });

  it('should reset counters via resetStats', async () => {
    const cache = newCache();
    await cache.wrap(userMessage('a'), () => Promise.resolve('v'));
    cache.resetStats();
    expect(cache.stats().misses).toBe(0);
    await cache.dispose();
  });
});

describe('cache events', () => {
  it('should emit miss then set then hit', async () => {
    const cache = newCache();
    const seen: string[] = [];
    cache.on('miss', () => seen.push('miss'));
    cache.on('set', () => seen.push('set'));
    cache.on('hit', () => seen.push('hit'));
    await cache.wrap(userMessage('a'), async () => 'v');
    await cache.flush();
    await cache.wrap(userMessage('a'), async () => 'v');
    expect(seen).toEqual(['miss', 'set', 'hit']);
    await cache.dispose();
  });

  it('should emit error event for storage failures', async () => {
    const broken: CacheStorage = {
      ...memoryStorage(),
      name: 'b',
      get: async () => {
        throw new Error('boom');
      },
    };
    const cache = createCache({ storage: broken, ttlJitter: 0 });
    const errs: string[] = [];
    cache.on('error', (e) => errs.push(e.error.code));
    await cache.wrap(userMessage('a'), async () => 'v');
    expect(errs.length).toBeGreaterThan(0);
    await cache.dispose();
  });

  it('should support unsubscribe via the returned disposer', async () => {
    const cache = newCache();
    const seen: string[] = [];
    const off = cache.on('miss', () => seen.push('m'));
    off();
    await cache.wrap(userMessage('a'), async () => 'v');
    expect(seen).toHaveLength(0);
    await cache.dispose();
  });

  it('should rethrow when onError is throw and storage rejects', async () => {
    const broken: CacheStorage = {
      ...memoryStorage(),
      name: 'b',
      get: async () => {
        throw new Error('boom');
      },
    };
    const cache = createCache({ storage: broken, onError: 'throw', ttlJitter: 0 });
    await expect(cache.wrap(userMessage('a'), async () => 'v')).rejects.toBeInstanceOf(StorageError);
    await cache.dispose();
  });

  it('should map a non-Error throw into a StorageError', async () => {
    const broken: CacheStorage = {
      ...memoryStorage(),
      name: 'b',
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      get: async () => {
        throw 'string-error';
      },
    };
    const cache = createCache({ storage: broken, onError: 'throw', ttlJitter: 0 });
    await expect(cache.wrap(userMessage('a'), async () => 'v')).rejects.toBeInstanceOf(CacheError);
    await cache.dispose();
  });
});

describe('cache.dispose', () => {
  it('should reject every method after disposal', async () => {
    const cache = newCache();
    await cache.dispose();
    await expect(cache.wrap(userMessage('a'), async () => 'v')).rejects.toThrow(ConfigError);
    await expect(cache.get(userMessage('a'))).rejects.toThrow(ConfigError);
    await expect(cache.set(userMessage('a'), 'v')).rejects.toThrow(ConfigError);
    await expect(cache.delete(userMessage('a'))).rejects.toThrow(ConfigError);
    await expect(cache.invalidate({ key: 'k' })).rejects.toThrow(ConfigError);
    await expect(cache.clear()).rejects.toThrow(ConfigError);
  });

  it('should be idempotent', async () => {
    const cache = newCache();
    await cache.dispose();
    await expect(cache.dispose()).resolves.toBeUndefined();
  });

  it('should call storage.dispose when present', async () => {
    const dispose = vi.fn(async () => {});
    const storage: CacheStorage = { ...memoryStorage(), name: 'x', dispose };
    const cache = createCache({ storage, ttlJitter: 0 });
    await cache.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('cache stream integration', () => {
  const serializer: ChunkSerializer<string> = {
    id: 'test-stream-v1',
    serialize: (chunks) => JSON.stringify(chunks),
    deserialize: (data) =>
      JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as readonly string[],
  };

  const upstream = (items: readonly string[]): ReadableStream<string> =>
    new ReadableStream<string>({
      start(controller) {
        for (const item of items) controller.enqueue(item);
        controller.close();
      },
    });

  const drain = async (s: ReadableStream<string>): Promise<string[]> => {
    const reader = s.getReader();
    const out: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  };

  it('should require a serializer', async () => {
    const cache = newCache();
    await expect(
      cache.wrapStream(userMessage('hi'), () => upstream(['a']), {} as never),
    ).rejects.toThrow();
    await cache.dispose();
  });

  it('should propagate live stream chunks on first call and replay on subsequent calls', async () => {
    const cache = newCache();
    const first = await cache.wrapStream(
      userMessage('hi'),
      () => upstream(['a', 'b', 'c']),
      { serializer },
    );
    const consumed = await drain(first);
    await cache.flush();

    const replay = await cache.wrapStream(
      userMessage('hi'),
      () => upstream(['x']),
      { serializer },
    );
    const replayed = await drain(replay);
    expect(consumed).toEqual(['a', 'b', 'c']);
    expect(replayed).toEqual(['a', 'b', 'c']);
    await cache.dispose();
  });

  it('should respect skipLookup on streams', async () => {
    const cache = newCache();
    await drain(
      await cache.wrapStream(userMessage('hi'), () => upstream(['a']), { serializer }),
    );
    await cache.flush();
    const fn = vi.fn(() => upstream(['fresh']));
    const stream = await cache.wrapStream(userMessage('hi'), fn, {
      serializer,
      skipLookup: true,
    });
    const out = await drain(stream);
    expect(out).toEqual(['fresh']);
    expect(fn).toHaveBeenCalled();
    await cache.dispose();
  });

  it('should evict and refetch on serializer-id mismatch', async () => {
    const cache = newCache();
    await drain(
      await cache.wrapStream(userMessage('hi'), () => upstream(['a']), { serializer }),
    );
    await cache.flush();

    const otherSerializer: ChunkSerializer<string> = {
      ...serializer,
      id: 'different-v1',
    };
    const fn = vi.fn(() => upstream(['b']));
    const stream = await cache.wrapStream(userMessage('hi'), fn, {
      serializer: otherSerializer,
    });
    const out = await drain(stream);
    expect(out).toEqual(['b']);
    expect(fn).toHaveBeenCalled();
    await cache.dispose();
  });

  it('should not cache when skipWrite is set', async () => {
    const cache = newCache();
    await drain(
      await cache.wrapStream(userMessage('hi'), () => upstream(['x']), {
        serializer,
        skipWrite: true,
      }),
    );
    await cache.flush();
    const fn = vi.fn(() => upstream(['y']));
    const stream = await cache.wrapStream(userMessage('hi'), fn, { serializer });
    const out = await drain(stream);
    expect(out).toEqual(['y']);
    expect(fn).toHaveBeenCalled();
    await cache.dispose();
  });

  it('should reject already-aborted signals', async () => {
    const cache = newCache();
    const ac = new AbortController();
    ac.abort();
    await expect(
      cache.wrapStream(userMessage('hi'), () => upstream(['x']), {
        serializer,
        signal: ac.signal,
      }),
    ).rejects.toThrow();
    await cache.dispose();
  });

  it('should support tryWrapStream as a Result mirror', async () => {
    const cache = newCache();
    const r = await cache.tryWrapStream(userMessage('hi'), () => upstream(['a']), { serializer });
    expect(isOk(r)).toBe(true);
    await cache.dispose();
  });
});

describe('semantic layer integration', () => {
  it('should accept a layer and use it on miss', async () => {
    const indexed: Array<{ key: string; req: CacheRequest }> = [];
    const layer: SemanticLayer = {
      _install: () => ({
        enabled: true,
        async lookup() {
          return { hit: false };
        },
        async index(request, _text, key) {
          indexed.push({ key, req: request });
        },
        embeddingCostUSD: () => 0,
      }),
    };
    const cache = newCache({ semantic: layer });
    await cache.wrap(userMessage('a'), async () => 'v');
    await cache.flush();
    expect(indexed).toHaveLength(1);
    await cache.dispose();
  });

  it('should return semantic hit when lookup finds a match', async () => {
    const layer: SemanticLayer = {
      _install: () => ({
        enabled: true,
        async lookup() {
          return { hit: true, value: 'semantic-value', key: 'k', similarity: 0.99 };
        },
        async index() {},
        embeddingCostUSD: () => 0,
      }),
    };
    const cache = newCache({ semantic: layer });
    const out = await cache.wrap(userMessage('a'), async () => 'live');
    expect(out).toBe('semantic-value');
    await cache.dispose();
  });

  it('should report semantic embedding cost in stats', async () => {
    const layer: SemanticLayer = {
      _install: () => ({
        enabled: true,
        async lookup() {
          return { hit: false };
        },
        async index() {},
        embeddingCostUSD: () => 0.42,
      }),
    };
    const cache = newCache({ semantic: layer });
    expect(cache.stats().embeddingCostUSD).toBe(0.42);
    await cache.dispose();
  });

  it('should surface semantic.lookup errors as error events', async () => {
    const layer: SemanticLayer = {
      _install: () => ({
        enabled: true,
        async lookup() {
          throw new Error('embed boom');
        },
        async index() {},
        embeddingCostUSD: () => 0,
      }),
    };
    const cache = newCache({ semantic: layer });
    const errs: string[] = [];
    cache.on('error', (e) => errs.push(e.operation));
    await cache.wrap(userMessage('a'), async () => 'v');
    expect(errs).toContain('semantic-lookup');
    await cache.dispose();
  });

  it('should throw when semantic._install accesses cache eagerly', () => {
    const layer: SemanticLayer = {
      _install: (getCache) => {
        getCache();
        return { enabled: false, lookup: async () => ({ hit: false }), index: async () => {}, embeddingCostUSD: () => 0 };
      },
    };
    expect(() => createCache({ storage: memoryStorage(), semantic: layer })).toThrow(ConfigError);
  });
});

describe('cache coalesce normalization', () => {
  afterEach(() => {});

  it('should accept coalesce: false', () => {
    const cache = createCache({ storage: memoryStorage(), coalesce: false, ttlJitter: 0 });
    expect(cache).toBeDefined();
  });

  it('should accept coalesce: object with custom abortPolicy', () => {
    const cache = createCache({
      storage: memoryStorage(),
      coalesce: { abortPolicy: 'shared' },
      ttlJitter: 0,
    });
    expect(cache).toBeDefined();
  });

  it('should run leader logic even when coalesce.lock returns held: false', async () => {
    const lockOrder: string[] = [];
    const lock = {
      async acquire() {
        lockOrder.push('acq');
        return {
          held: false,
          release: async () => {
            lockOrder.push('rel');
          },
        };
      },
    };
    const cache = createCache({
      storage: memoryStorage(),
      coalesce: { lock },
      ttlJitter: 0,
    });
    const fn = vi.fn().mockResolvedValue('v');
    await cache.wrap(userMessage('hi'), fn);
    expect(lockOrder).toEqual(['acq', 'rel']);
    await cache.dispose();
  });
});

describe('storage with invalid envelope', () => {
  it('should treat parse failures as misses and surface error event', async () => {
    const broken: CacheStorage = {
      ...memoryStorage(),
      name: 'b',
      get: async () => ({ v: 99, value: 'x', exp: Number.MAX_SAFE_INTEGER, createdAt: 0 } as never),
    };
    const cache = createCache({ storage: broken, ttlJitter: 0 });
    const errs: string[] = [];
    cache.on('error', (e) => errs.push(e.error.code));
    const fn = vi.fn().mockResolvedValue('fresh');
    await cache.wrap(userMessage('a'), fn);
    expect(fn).toHaveBeenCalled();
    expect(errs).toContain('STORAGE_PARSE_FAILED');
    await cache.dispose();
  });
});
