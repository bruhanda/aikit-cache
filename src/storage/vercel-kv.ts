import { StorageError } from '../errors/storage-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import type {
  CacheEntry,
  CacheStorage,
  InvalidationPattern,
  StorageCapabilities,
  TransformAtRest,
} from '../core/types.js';
import { utf8Decode, utf8Encode } from '../internal/encoding.js';

/**
 * Structural shape of a `@vercel/kv` client. The package is deprecated as
 * of 2026 — Upstash is the successor — but the adapter is kept for users
 * still on the legacy client.
 */
export interface VercelKVClient {
  set(key: string, value: string, opts?: { px?: number; ex?: number }): Promise<unknown>;
  get<T = string>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: number | string, opts?: { match?: string; count?: number }): Promise<[string, string[]]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
}

export interface VercelKVStorageOptions {
  readonly client: VercelKVClient;
  readonly keyPrefix?: string;
  readonly transformAtRest?: TransformAtRest;
}

const TAG_PREFIX = '__tag__:';
const KEY_TAGS_PREFIX = '__keytags__:';

/**
 * Vercel KV adapter. Wraps a `@vercel/kv` client; otherwise identical in
 * shape to `upstashStorage`.
 *
 * @param options Pre-constructed client and optional prefix / transform.
 * @returns A `CacheStorage` instance.
 */
export function vercelKVStorage(options: VercelKVStorageOptions): CacheStorage {
  const client = options.client;
  const prefix = options.keyPrefix ?? 'aikit:';
  const transform = options.transformAtRest;
  const capabilities: StorageCapabilities = Object.freeze({
    prefixScan: true,
    tagIndex: true,
    vectorSearch: false,
  });

  const fullKey = (key: string): string => `${prefix}${key}`;
  const tagKey = (tag: string): string => `${prefix}${TAG_PREFIX}${tag}`;
  const keyTagsKey = (key: string): string => `${prefix}${KEY_TAGS_PREFIX}${key}`;

  const encode = async (entry: CacheEntry<unknown>): Promise<string> => {
    const json = canonicalJSON(entry);
    if (!transform) return json;
    const bytes = utf8Encode(json);
    const out = await transform.encode(bytes);
    return `\x00${utf8Decode(out)}`;
  };

  const decode = async (raw: string): Promise<CacheEntry<unknown>> => {
    let json = raw;
    if (raw.startsWith('\x00') && transform) {
      const cipher = utf8Encode(raw.slice(1));
      const plain = await transform.decode(cipher);
      json = utf8Decode(plain);
    }
    return JSON.parse(json) as CacheEntry<unknown>;
  };

  const storage: CacheStorage = {
    name: 'vercel-kv',
    capabilities,

    async get(key) {
      try {
        const raw = await client.get<string>(fullKey(key));
        if (raw === null) return undefined;
        return await decode(raw);
      } catch (cause) {
        throw new StorageError('STORAGE_GET_FAILED', 'get', 'vercel-kv', `vercel KV GET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async set(key, entry, ttlMs) {
      try {
        const value = await encode(entry);
        await client.set(fullKey(key), value, { px: Math.max(1, Math.round(ttlMs)) });
        if (entry.tags && entry.tags.length > 0) {
          await client.sadd(keyTagsKey(key), ...entry.tags);
          for (const tag of entry.tags) await client.sadd(tagKey(tag), key);
        }
      } catch (cause) {
        throw new StorageError('STORAGE_SET_FAILED', 'set', 'vercel-kv', `vercel KV SET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async delete(key) {
      try {
        const removed = await client.del(fullKey(key));
        const tags = await client.smembers(keyTagsKey(key)).catch(() => [] as string[]);
        if (tags.length > 0) {
          await client.srem(keyTagsKey(key), ...tags);
          for (const tag of tags) await client.srem(tagKey(tag), key);
        }
        return removed > 0;
      } catch (cause) {
        throw new StorageError(
          'STORAGE_DELETE_FAILED',
          'delete',
          'vercel-kv',
          `vercel KV DEL failed: ${describe(cause)}`,
          { cause, key },
        );
      }
    },

    async invalidate(pattern: InvalidationPattern) {
      if ('key' in pattern) return (await storage.delete(pattern.key)) ? 1 : 0;
      if ('tag' in pattern) {
        const keys = await client.smembers(tagKey(pattern.tag));
        let removed = 0;
        for (const key of keys) if (await storage.delete(key)) removed += 1;
        return removed;
      }
      const matchPattern = 'prefix' in pattern ? `${prefix}${pattern.prefix}*` : `${prefix}*`;
      let cursor: string | number = '0';
      let removed = 0;
      do {
        const result = await client.scan(cursor, { match: matchPattern, count: 100 });
        cursor = result[0];
        for (const fullName of result[1]) {
          if (fullName.startsWith(`${prefix}${TAG_PREFIX}`) || fullName.startsWith(`${prefix}${KEY_TAGS_PREFIX}`)) continue;
          const stripped = fullName.slice(prefix.length);
          if ('predicate' in pattern) {
            const raw = await client.get<string>(fullName);
            if (raw === null) continue;
            try {
              const entry = await decode(raw);
              const view = {
                key: stripped,
                tags: entry.tags ?? [],
                createdAt: entry.createdAt,
                exp: entry.exp,
                meta: entry.meta ?? {},
              };
              if (pattern.predicate(view) && (await storage.delete(stripped))) removed += 1;
            } catch {
              // skip
            }
          } else if (await storage.delete(stripped)) removed += 1;
        }
      } while (String(cursor) !== '0');
      return removed;
    },

    async clear() {
      let cursor: string | number = '0';
      let removed = 0;
      do {
        const result = await client.scan(cursor, { match: `${prefix}*`, count: 200 });
        cursor = result[0];
        if (result[1].length > 0) {
          removed += await client.del(...result[1]);
        }
      } while (String(cursor) !== '0');
      return removed;
    },
  };

  return storage;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
