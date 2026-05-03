import { StorageError } from '../errors/storage-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import { utf8Decode, utf8Encode } from '../internal/encoding.js';
import { retry } from '../internal/retry.js';
import type {
  CacheEntry,
  CacheStorage,
  DistributedLock,
  InvalidationPattern,
  StorageCapabilities,
  TransformAtRest,
} from '../core/types.js';

/**
 * Structural view of an `@upstash/redis` client. Only the methods we touch
 * are typed; richer SDK shapes still satisfy this interface structurally.
 */
export interface UpstashClient {
  set(key: string, value: string, opts?: { px?: number; ex?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: number | string, opts?: { match?: string; count?: number }): Promise<[string, string[]]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  eval?(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export type UpstashStorageOptions =
  | {
      readonly url: string;
      readonly token: string;
      readonly fetch?: typeof fetch;
      readonly keyPrefix?: string;
      readonly transformAtRest?: TransformAtRest;
    }
  | {
      readonly client: UpstashClient;
      readonly keyPrefix?: string;
      readonly transformAtRest?: TransformAtRest;
    };

const TAG_PREFIX = '__tag__:';
const KEY_TAGS_PREFIX = '__keytags__:';

/**
 * Upstash Redis (REST) storage adapter — edge-safe (no `node:net`).
 * Accepts either a pre-constructed `@upstash/redis` client OR `{ url, token }`
 * which uses bare `fetch()` against the REST API.
 *
 * @param options Either a `client` or `{ url, token }` REST credentials.
 * @returns A `CacheStorage` instance.
 */
export function upstashStorage(options: UpstashStorageOptions): CacheStorage {
  const prefix = options.keyPrefix ?? 'aikit:';
  const transform = options.transformAtRest;
  const client: UpstashClient = 'client' in options ? options.client : restClient(options.url, options.token, options.fetch);

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
    name: 'upstash',
    capabilities,

    async get(key) {
      try {
        const raw = await retry(() => client.get(fullKey(key)));
        if (raw === null) return undefined;
        return await decode(raw);
      } catch (cause) {
        throw new StorageError('STORAGE_GET_FAILED', 'get', 'upstash', `upstash GET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async set(key, entry, ttlMs) {
      try {
        const value = await encode(entry);
        await retry(() => client.set(fullKey(key), value, { px: Math.max(1, Math.round(ttlMs)) }));
        if (entry.tags && entry.tags.length > 0) {
          await client.sadd(keyTagsKey(key), ...entry.tags);
          for (const tag of entry.tags) await client.sadd(tagKey(tag), key);
        }
      } catch (cause) {
        throw new StorageError('STORAGE_SET_FAILED', 'set', 'upstash', `upstash SET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async delete(key) {
      try {
        const removed = await retry(() => client.del(fullKey(key)));
        const tags = await client.smembers(keyTagsKey(key)).catch(() => [] as string[]);
        if (tags.length > 0) {
          await client.srem(keyTagsKey(key), ...tags);
          for (const tag of tags) await client.srem(tagKey(tag), key);
        }
        return removed > 0;
      } catch (cause) {
        throw new StorageError('STORAGE_DELETE_FAILED', 'delete', 'upstash', `upstash DEL failed: ${describe(cause)}`, {
          cause,
          key,
        });
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

/**
 * Upstash REST `DistributedLock`. Uses `SET ... NX PX` and a Lua
 * compare-and-delete. Edge-safe.
 *
 * @param options REST credentials and optional key prefix.
 * @returns A `DistributedLock` for `coalesce.lock`.
 */
export function upstashLock(options: {
  readonly url: string;
  readonly token: string;
  readonly keyPrefix?: string;
  readonly fetch?: typeof fetch;
}): DistributedLock {
  const prefix = options.keyPrefix ?? 'aikit:lock:';
  const client = restClient(options.url, options.token, options.fetch);
  const releaseScript = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
  return {
    async acquire(key, opts = {}) {
      const ttlMs = Math.max(1_000, opts.ttlMs ?? 30_000);
      const waitMs = opts.waitMs ?? 0;
      const lockKey = `${prefix}${key}`;
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const deadline = Date.now() + waitMs;
      while (true) {
        const set = await fetchUpstash(options.url, options.token, options.fetch, ['SET', lockKey, token, 'PX', String(ttlMs), 'NX']);
        if (set === 'OK') {
          return {
            held: true,
            release: async () => {
              try {
                if (client.eval) await client.eval(releaseScript, [lockKey], [token]);
                else await fetchUpstash(options.url, options.token, options.fetch, ['EVAL', releaseScript, '1', lockKey, token]);
              } catch {
                // best effort
              }
            },
          };
        }
        if (Date.now() >= deadline) return { held: false, release: async () => {} };
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    },
  };
}

function restClient(url: string, token: string, customFetch?: typeof fetch): UpstashClient {
  const f = customFetch ?? fetch;
  const exec = async <T>(command: readonly string[]): Promise<T> => fetchUpstash(url, token, f, command) as Promise<T>;
  return {
    async set(key, value, opts) {
      const cmd = ['SET', key, value];
      if (opts?.px !== undefined) cmd.push('PX', String(Math.round(opts.px)));
      else if (opts?.ex !== undefined) cmd.push('EX', String(Math.round(opts.ex)));
      return exec<unknown>(cmd);
    },
    async get(key) {
      return exec<string | null>(['GET', key]);
    },
    async del(...keys) {
      if (keys.length === 0) return 0;
      return exec<number>(['DEL', ...keys]);
    },
    async scan(cursor, opts) {
      const cmd = ['SCAN', String(cursor)];
      if (opts?.match) cmd.push('MATCH', opts.match);
      if (opts?.count !== undefined) cmd.push('COUNT', String(opts.count));
      const result = await exec<[string, string[]]>(cmd);
      return result;
    },
    async sadd(key, ...members) {
      if (members.length === 0) return 0;
      return exec<number>(['SADD', key, ...members]);
    },
    async smembers(key) {
      return exec<string[]>(['SMEMBERS', key]);
    },
    async srem(key, ...members) {
      if (members.length === 0) return 0;
      return exec<number>(['SREM', key, ...members]);
    },
    async eval(script, keys, args) {
      return exec<unknown>(['EVAL', script, String(keys.length), ...keys, ...args]);
    },
  };
}

async function fetchUpstash(
  url: string,
  token: string,
  customFetch: typeof fetch | undefined,
  command: readonly string[],
): Promise<unknown> {
  const f = customFetch ?? fetch;
  const res = await f(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error(`upstash REST ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(json.error);
  return json.result ?? null;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
