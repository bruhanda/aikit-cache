import type {
  CacheEntry,
  CacheStorage,
  InvalidationPattern,
  StorageCapabilities,
  VectorRecord,
  VectorSearchHit,
} from '../core/types.js';

/**
 * Compose multiple `CacheStorage` tiers into a read-through, write-through
 * cache. Reads try each tier in order; on an L_n hit, every L_<n cache is
 * back-filled with the same envelope and TTL. Writes go to every tier in
 * parallel.
 *
 * Ideal pattern: `[memoryStorage(), upstashStorage(...)]` so the in-process
 * L1 absorbs hot keys and the L2 survives across cold starts.
 *
 * @param tiers Non-empty array of storage backends ordered closest-first.
 * @returns A composite `CacheStorage`.
 * @throws {Error} when `tiers` is empty.
 *
 * @example
 * const cache = createCache({
 *   storage: multiTierStorage([memoryStorage({ max: 1_000 }), upstashStorage(...)]),
 * });
 */
export function multiTierStorage(
  tiers: readonly [CacheStorage, ...CacheStorage[]],
): CacheStorage {
  if (tiers.length === 0) throw new Error('multiTierStorage requires at least one tier');

  const tierList = [...tiers];
  const capabilities: StorageCapabilities = mergeCapabilities(tierList);

  const storage: CacheStorage = {
    name: `multi-tier(${tierList.map((t) => t.name).join(',')})`,
    capabilities,

    async get(key) {
      for (let i = 0; i < tierList.length; i++) {
        const entry = await tierList[i]!.get(key);
        if (entry !== undefined) {
          if (i > 0) {
            const ttlMs = Math.max(0, entry.exp - Date.now());
            for (let j = 0; j < i; j++) {
              await safeSet(tierList[j]!, key, entry, ttlMs);
            }
          }
          return entry;
        }
      }
      return undefined;
    },

    async set(key, entry, ttlMs) {
      await Promise.all(tierList.map((t) => t.set(key, entry, ttlMs)));
    },

    async delete(key) {
      const results = await Promise.all(tierList.map((t) => t.delete(key)));
      return results.some(Boolean);
    },

    async invalidate(pattern: InvalidationPattern) {
      const results = await Promise.all(tierList.map((t) => t.invalidate(pattern)));
      return results.reduce((a, b) => a + b, 0);
    },

    async clear() {
      const results = await Promise.all(tierList.map((t) => t.clear()));
      return results.reduce((a, b) => a + b, 0);
    },
  };

  if (capabilities.vectorSearch) {
    storage.vectorSearch = async (query, topK, namespace) => {
      const candidates: VectorSearchHit[] = [];
      const seen = new Set<string>();
      for (const tier of tierList) {
        if (!tier.vectorSearch) continue;
        const hits = await tier.vectorSearch(query, topK, namespace);
        for (const hit of hits) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          candidates.push(hit);
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates.slice(0, topK);
    };

    storage.vectorUpsert = async (records: readonly VectorRecord[]) => {
      await Promise.all(tierList.filter((t) => t.vectorUpsert).map((t) => t.vectorUpsert!(records)));
    };

    storage.vectorDelete = async (ids: readonly string[]) => {
      const results = await Promise.all(
        tierList.filter((t) => t.vectorDelete).map((t) => t.vectorDelete!(ids)),
      );
      return results.reduce((a, b) => a + b, 0);
    };
  }

  storage.dispose = async () => {
    await Promise.all(tierList.filter((t) => t.dispose).map((t) => t.dispose!()));
  };

  return storage;
}

async function safeSet(
  storage: CacheStorage,
  key: string,
  entry: CacheEntry<unknown>,
  ttlMs: number,
): Promise<void> {
  try {
    await storage.set(key, entry, ttlMs);
  } catch {
    // Backfill failures are non-fatal — the upstream tier still served the read.
  }
}

function mergeCapabilities(tiers: readonly CacheStorage[]): StorageCapabilities {
  let prefixScan = true;
  let tagIndex = true;
  let vectorSearch = false;
  let maxValueBytes: number | undefined;

  for (const tier of tiers) {
    const caps = tier.capabilities;
    if (!caps?.prefixScan) prefixScan = false;
    if (!caps?.tagIndex) tagIndex = false;
    if (caps?.vectorSearch) vectorSearch = true;
    if (caps?.maxValueBytes !== undefined) {
      maxValueBytes = maxValueBytes === undefined ? caps.maxValueBytes : Math.min(maxValueBytes, caps.maxValueBytes);
    }
  }

  const out: StorageCapabilities = {
    prefixScan,
    tagIndex,
    vectorSearch,
    ...(maxValueBytes !== undefined ? { maxValueBytes } : {}),
  };
  return Object.freeze(out);
}
