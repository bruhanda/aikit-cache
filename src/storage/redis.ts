import { StorageError } from '../errors/storage-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import { utf8Decode, utf8Encode } from '../internal/encoding.js';
import type {
  CacheEntry,
  CacheStorage,
  DistributedLock,
  InvalidationPattern,
  StorageCapabilities,
  TransformAtRest,
} from '../core/types.js';

/**
 * Minimal structural view of an `ioredis`-shaped client. We do not import
 * `ioredis` itself — users supply a pre-constructed client.
 */
export interface RedisLikeClient {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string | number, ...args: unknown[]): Promise<[string, string[]]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export interface RedisStorageOptions {
  readonly client: RedisLikeClient;
  /** Key prefix prepended to every cache key. Default `'aikit:'`. */
  readonly keyPrefix?: string;
  readonly transformAtRest?: TransformAtRest;
}

const TAG_PREFIX = '__tag__:';
const KEY_TAGS_PREFIX = '__keytags__:';

/**
 * Redis-backed `CacheStorage`. Accepts any `ioredis`-shaped client; uses
 * `SET key val PX ttl` for writes, `SCAN`+`DEL` for prefix invalidation,
 * and Redis sets for tag-based invalidation (entry → tags index in
 * `__keytags__:<key>`, tag → keys index in `__tag__:<tag>`).
 *
 * @param options Pre-constructed client and optional key prefix / encryption hook.
 * @returns A `CacheStorage` instance.
 *
 * @example
 * import IORedis from 'ioredis';
 * const redis = new IORedis(process.env.REDIS_URL!);
 * const storage = redisStorage({ client: redis });
 */
export function redisStorage(options: RedisStorageOptions): CacheStorage {
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

  return {
    name: 'redis',
    capabilities,

    async get(key) {
      try {
        const raw = await client.get(fullKey(key));
        if (raw === null) return undefined;
        return await decode(raw);
      } catch (cause) {
        throw new StorageError('STORAGE_GET_FAILED', 'get', 'redis', `redis GET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async set(key, entry, ttlMs) {
      try {
        const value = await encode(entry);
        await client.set(fullKey(key), value, 'PX', Math.max(1, Math.round(ttlMs)));
        if (entry.tags && entry.tags.length > 0) {
          await client.sadd(keyTagsKey(key), ...entry.tags);
          for (const tag of entry.tags) await client.sadd(tagKey(tag), key);
        }
      } catch (cause) {
        throw new StorageError('STORAGE_SET_FAILED', 'set', 'redis', `redis SET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async delete(key) {
      try {
        const removed = await client.del(fullKey(key));
        const tags = await client.smembers(keyTagsKey(key));
        if (tags.length > 0) {
          await client.srem(keyTagsKey(key), ...tags);
          for (const tag of tags) await client.srem(tagKey(tag), key);
        }
        return removed > 0;
      } catch (cause) {
        throw new StorageError('STORAGE_DELETE_FAILED', 'delete', 'redis', `redis DEL failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async invalidate(pattern: InvalidationPattern) {
      try {
        if ('key' in pattern) return (await this.delete(pattern.key)) ? 1 : 0;
        if ('tag' in pattern) {
          const keys = await client.smembers(tagKey(pattern.tag));
          let removed = 0;
          for (const key of keys) if (await this.delete(key)) removed += 1;
          return removed;
        }
        if ('prefix' in pattern) {
          const matchPattern = `${prefix}${pattern.prefix}*`;
          let cursor = '0';
          let removed = 0;
          do {
            const result = await client.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
            cursor = result[0];
            for (const fullName of result[1]) {
              const stripped = fullName.slice(prefix.length);
              if (await this.delete(stripped)) removed += 1;
            }
          } while (cursor !== '0');
          return removed;
        }
        let cursor = '0';
        let removed = 0;
        do {
          const result = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = result[0];
          for (const fullName of result[1]) {
            if (fullName.startsWith(`${prefix}${TAG_PREFIX}`) || fullName.startsWith(`${prefix}${KEY_TAGS_PREFIX}`)) continue;
            const stripped = fullName.slice(prefix.length);
            const raw = await client.get(fullName);
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
              if (pattern.predicate(view) && (await this.delete(stripped))) removed += 1;
            } catch {
              // skip undecodable entry
            }
          }
        } while (cursor !== '0');
        return removed;
      } catch (cause) {
        if (cause instanceof StorageError) throw cause;
        throw new StorageError(
          'STORAGE_INVALIDATE_FAILED',
          'invalidate',
          'redis',
          `redis invalidate failed: ${describe(cause)}`,
          { cause },
        );
      }
    },

    async clear() {
      let cursor = '0';
      let removed = 0;
      do {
        const result = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = result[0];
        if (result[1].length > 0) {
          removed += await client.del(...result[1]);
        }
      } while (cursor !== '0');
      return removed;
    },
  };
}

const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Redis-backed `DistributedLock` using `SET key val NX PX ttl` plus a Lua
 * compare-and-delete on release. Suitable for sharing single-flight
 * coalescing across multi-pod deployments.
 *
 * @param client Pre-constructed `ioredis`-shaped client.
 * @param opts Optional `keyPrefix` for the lock namespace.
 * @returns A `DistributedLock` ready to pass into `coalesce.lock`.
 */
export function redisLock(
  client: RedisLikeClient,
  opts: { readonly keyPrefix?: string } = {},
): DistributedLock {
  const prefix = opts.keyPrefix ?? 'aikit:lock:';
  return {
    async acquire(key, options = {}) {
      const ttlMs = Math.max(1_000, options.ttlMs ?? 30_000);
      const waitMs = options.waitMs ?? 0;
      const lockKey = `${prefix}${key}`;
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const deadline = Date.now() + waitMs;
      while (true) {
        const ok = await client.set(lockKey, token, 'PX', ttlMs, 'NX');
        if (ok) {
          return {
            held: true,
            release: async () => {
              try {
                await client.eval(RELEASE_SCRIPT, 1, lockKey, token);
              } catch {
                // best effort
              }
            },
          };
        }
        if (Date.now() >= deadline) {
          return { held: false, release: async () => {} };
        }
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    },
  };
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
