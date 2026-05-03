import { canonicalJSON } from '../internal/canonical-json.js';
import { defaultClock, type Clock } from '../internal/clock.js';
import { deepEqual } from '../internal/deep-equal.js';
import type {
  CacheEntry,
  CacheEntryView,
  CacheStorage,
  InvalidationPattern,
  StorageCapabilities,
} from '../core/types.js';
import { LRU } from './lru.js';

/** Options accepted by `memoryStorage()`. */
export interface MemoryStorageOptions {
  /** Maximum number of entries before LRU eviction kicks in. Default `1_000`. */
  readonly max?: number;
  /** Maximum total bytes (sums via `sizeOf`). Default unlimited. */
  readonly maxBytes?: number;
  /** Custom byte-size estimator. Default uses canonical JSON length. */
  readonly sizeOf?: (entry: CacheEntry<unknown>) => number;
  /** Fired before an entry is dropped due to capacity or TTL. */
  readonly onEvict?: (key: string, reason: 'capacity' | 'ttl') => void;
  /** Inject a clock for deterministic tests. Default `Date.now`. */
  readonly clock?: Clock;
}

/**
 * In-memory LRU storage with byte-size accounting and lazy TTL eviction.
 * Sync semantics under an async facade for protocol consistency with
 * network-backed adapters.
 *
 * Recommended L1 in `multiTierStorage`. For serverless instances where
 * memory is reset every cold start, this is the only adapter you need.
 *
 * @param options Capacity, sizing, and eviction hooks.
 * @returns A `CacheStorage` backed by an in-process LRU.
 *
 * @example
 * const storage = memoryStorage({ max: 10_000, maxBytes: 50 * 1024 * 1024 });
 */
export function memoryStorage(options: MemoryStorageOptions = {}): CacheStorage {
  const max = options.max ?? 1_000;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const sizeOf = options.sizeOf ?? defaultSizeOf;
  const clock = options.clock ?? defaultClock;
  const onEvict = options.onEvict;

  const lru = new LRU<CacheEntry<unknown>>(max, maxBytes, (key) => onEvict?.(key, 'capacity'));

  const isExpired = (entry: CacheEntry<unknown>): boolean => entry.exp <= clock.now();

  const capabilities: StorageCapabilities = Object.freeze({
    prefixScan: true,
    tagIndex: true,
    vectorSearch: false,
  });

  const storage: CacheStorage = {
    name: 'memory',
    capabilities,

    async get(key) {
      const entry = lru.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        lru.delete(key);
        onEvict?.(key, 'ttl');
        return undefined;
      }
      return entry;
    },

    async set(key, entry, _ttlMs) {
      const bytes = safeSizeOf(sizeOf, entry);
      lru.set(key, entry, bytes);
    },

    async delete(key) {
      return lru.delete(key);
    },

    async invalidate(pattern: InvalidationPattern) {
      let removed = 0;
      const victims: string[] = [];
      if ('key' in pattern) {
        if (lru.delete(pattern.key)) removed += 1;
        return removed;
      }
      if ('prefix' in pattern) {
        for (const key of lru.keys()) if (key.startsWith(pattern.prefix)) victims.push(key);
      } else if ('tag' in pattern) {
        for (const [key, entry] of lru.entries()) {
          if (entry.tags?.includes(pattern.tag)) victims.push(key);
        }
      } else if ('predicate' in pattern) {
        for (const [key, entry] of lru.entries()) {
          const view = entryView(key, entry);
          if (pattern.predicate(view)) victims.push(key);
        }
      }
      for (const key of victims) {
        if (lru.delete(key)) removed += 1;
      }
      return removed;
    },

    async clear() {
      const n = lru.size();
      lru.clear();
      return n;
    },
  };

  return storage;
}

const defaultSizeOf = (entry: CacheEntry<unknown>): number => {
  try {
    return canonicalJSON(entry).length;
  } catch {
    return 0;
  }
};

const safeSizeOf = (
  sizeOf: (entry: CacheEntry<unknown>) => number,
  entry: CacheEntry<unknown>,
): number => {
  try {
    const n = sizeOf(entry);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

const entryView = (key: string, entry: CacheEntry<unknown>): CacheEntryView => ({
  key,
  tags: entry.tags ?? [],
  createdAt: entry.createdAt,
  exp: entry.exp,
  meta: entry.meta ?? {},
});

/**
 * Internal helper exposed for adapters that share the predicate semantics
 * (e.g. multi-tier storage delegating predicate matching to the L1).
 */
export const __internal = { defaultSizeOf, deepEqual, entryView };
