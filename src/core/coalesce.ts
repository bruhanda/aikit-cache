import type { DistributedLock } from './types.js';

/**
 * In-flight single-flight deduplication. When N callers ask for the same
 * key concurrently, only the first calls `fn()`; the remaining N-1 await
 * the same Promise. Entries are removed on `.finally()` so the map cannot
 * leak memory under sustained burst load.
 *
 * Thread-safe within a single runtime — the underlying `Map` is single-
 * threaded by JS event-loop semantics. Cross-process coalescing requires
 * a `DistributedLock` (see `CacheOptions.coalesce.lock`).
 */
export class Coalescer<V = unknown> {
  private readonly inflight = new Map<string, { promise: Promise<V>; waiters: number }>();

  /**
   * Run `fn()` exactly once for the duration of an in-flight key.
   *
   * @param key Coalescing key (typically the cache key).
   * @param fn Async producer.
   * @returns The resolved value.
   * @throws Whatever `fn()` throws.
   */
  dedupe(key: string, fn: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key);
    if (existing) {
      existing.waiters += 1;
      return existing.promise;
    }

    const promise = (async () => fn())();
    const entry = { promise, waiters: 0 };
    this.inflight.set(key, entry);
    promise.finally(() => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    });
    return promise;
  }

  /** Number of waiters absorbed by an in-flight call (excluding the leader). */
  waiters(key: string): number {
    return this.inflight.get(key)?.waiters ?? 0;
  }

  /** Whether a leader is currently computing `key`. */
  has(key: string): boolean {
    return this.inflight.has(key);
  }

  /** Number of distinct keys currently in flight. */
  size(): number {
    return this.inflight.size;
  }

  /** Wait for every in-flight entry to settle. Used by `cache.dispose()`. */
  async drain(): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const entry of this.inflight.values()) promises.push(entry.promise.catch(() => undefined));
    await Promise.all(promises);
  }
}

/**
 * Wrap a `DistributedLock` around a coalescing operation. The leader's
 * `fn()` runs only when the lock is held; if `acquire()` returns `held: false`
 * (a peer holds the lock), the local caller awaits the lock and then
 * re-checks the cache via the supplied `recheck()` hook before falling
 * back to `fn()`.
 *
 * @param key Coalescing key.
 * @param lock Distributed mutex.
 * @param fn Producer (called only by the leader).
 * @param recheck Optional cache-recheck after acquiring the lock.
 * @param options TTL/wait settings forwarded to `lock.acquire`.
 * @returns The resolved value.
 */
export async function withDistributedLock<T>(
  key: string,
  lock: DistributedLock,
  fn: () => Promise<T>,
  recheck?: () => Promise<T | undefined>,
  options?: { readonly waitMs?: number; readonly ttlMs?: number },
): Promise<T> {
  const handle = await lock.acquire(key, options);
  try {
    if (handle.held) return await fn();
    if (recheck) {
      const cached = await recheck();
      if (cached !== undefined) return cached;
    }
    return await fn();
  } finally {
    await handle.release();
  }
}

/**
 * No-op `DistributedLock` used when `coalesce.lock` is not configured.
 * `acquire()` always reports `held: true` so the local in-process
 * coalescer remains the single point of single-flight.
 */
export const noopDistributedLock: DistributedLock = {
  async acquire() {
    return {
      held: true,
      release: async () => {},
    };
  },
};
