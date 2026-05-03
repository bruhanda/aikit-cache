import { StorageError } from '../errors/storage-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import { utf8Decode, utf8Encode } from '../internal/encoding.js';
import type {
  CacheEntry,
  CacheStorage,
  InvalidationPattern,
  StorageCapabilities,
  TransformAtRest,
} from '../core/types.js';

/**
 * Structural shape of a Cloudflare Workers `KVNamespace`. We do not import
 * `@cloudflare/workers-types` at runtime — users supply the bound namespace.
 */
export interface KVNamespaceLike {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' }): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: ReadonlyArray<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * Subset of Cloudflare's `ExecutionContext` used by the adapter to keep
 * Workers alive long enough for background `put()` writes to resolve.
 */
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CloudflareKVStorageOptions {
  readonly keyPrefix?: string;
  readonly ctx?: CloudflareExecutionContext;
  readonly transformAtRest?: TransformAtRest;
  /**
   * Cloudflare KV's expirationTtl has a 60-second minimum. Setting `false`
   * skips the rounding-up safeguard. Default `true` (round up to 60).
   */
  readonly enforceMinimumTtl?: boolean;
}

/**
 * Cloudflare Workers KV adapter. Edge-safe (no `node:*` imports).
 *
 * Writes can be wrapped in `ctx.waitUntil(...)` so the Worker stays alive
 * long enough for the background put() to resolve — without `ctx`, a
 * handler that returns immediately can have its write killed by the
 * runtime, leaving the next caller with a silent miss.
 *
 * @param kv The bound `KVNamespace` from the Worker environment.
 * @param options Optional `keyPrefix`, `ctx`, `transformAtRest`.
 * @returns A `CacheStorage` instance.
 */
export function cloudflareKVStorage(
  kv: KVNamespaceLike,
  options: CloudflareKVStorageOptions = {},
): CacheStorage {
  const prefix = options.keyPrefix ?? 'aikit:';
  const transform = options.transformAtRest;
  const enforceMin = options.enforceMinimumTtl !== false;
  let warnedMinTtl = false;

  const capabilities: StorageCapabilities = Object.freeze({
    prefixScan: true,
    tagIndex: false,
    vectorSearch: false,
    maxValueBytes: 25 * 1024 * 1024,
  });

  const fullKey = (key: string): string => `${prefix}${key}`;

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
    name: 'cloudflare-kv',
    capabilities,

    async get(key) {
      try {
        const raw = await kv.get(fullKey(key), { type: 'text' });
        if (raw === null) return undefined;
        return await decode(raw);
      } catch (cause) {
        throw new StorageError('STORAGE_GET_FAILED', 'get', 'cloudflare-kv', `KV GET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async set(key, entry, ttlMs) {
      try {
        const value = await encode(entry);
        const ttlSeconds = Math.ceil(Math.max(1, ttlMs) / 1000);
        let expirationTtl = ttlSeconds;
        if (enforceMin && ttlSeconds < 60) {
          if (!warnedMinTtl) {
            warnedMinTtl = true;
            // Cloudflare KV rejects TTLs under 60 seconds. We round up
            // silently from then on, but warn once so users debugging
            // "why is my 5s TTL acting like 60s" find the answer fast.
            (globalThis as { console?: Console }).console?.warn?.(
              `[aikit-cache] Cloudflare KV requires expirationTtl >= 60s; rounding ${ttlSeconds}s up to 60s. Set enforceMinimumTtl: false to opt out.`,
            );
          }
          expirationTtl = 60;
        }
        const tags = entry.tags;
        const putOpts =
          tags && tags.length > 0
            ? { expirationTtl, metadata: { tags } }
            : { expirationTtl };
        const op = kv.put(fullKey(key), value, putOpts);
        if (options.ctx) options.ctx.waitUntil(op);
        await op;
      } catch (cause) {
        throw new StorageError('STORAGE_SET_FAILED', 'set', 'cloudflare-kv', `KV PUT failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async delete(key) {
      try {
        await kv.delete(fullKey(key));
        return true;
      } catch (cause) {
        throw new StorageError(
          'STORAGE_DELETE_FAILED',
          'delete',
          'cloudflare-kv',
          `KV DELETE failed: ${describe(cause)}`,
          { cause, key },
        );
      }
    },

    async invalidate(pattern: InvalidationPattern) {
      if ('key' in pattern) return (await this.delete(pattern.key)) ? 1 : 0;
      const matchPrefix = 'prefix' in pattern ? `${prefix}${pattern.prefix}` : prefix;
      let cursor: string | undefined;
      let removed = 0;
      do {
        const listOpts: { prefix?: string; cursor?: string; limit?: number } = {
          prefix: matchPrefix,
          limit: 1000,
        };
        if (cursor !== undefined) listOpts.cursor = cursor;
        const result = await kv.list(listOpts);
        for (const { name, metadata } of result.keys) {
          const stripped = name.slice(prefix.length);
          if ('tag' in pattern) {
            const tags = (metadata as { tags?: string[] } | undefined)?.tags ?? [];
            if (tags.includes(pattern.tag)) {
              await kv.delete(name);
              removed += 1;
            }
            continue;
          }
          if ('predicate' in pattern) {
            const raw = await kv.get(name, { type: 'text' });
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
              if (pattern.predicate(view)) {
                await kv.delete(name);
                removed += 1;
              }
            } catch {
              // skip
            }
            continue;
          }
          await kv.delete(name);
          removed += 1;
        }
        cursor = result.list_complete ? undefined : result.cursor;
      } while (cursor !== undefined);
      return removed;
    },

    async clear() {
      let cursor: string | undefined;
      let removed = 0;
      do {
        const listOpts: { prefix?: string; cursor?: string; limit?: number } = {
          prefix,
          limit: 1000,
        };
        if (cursor !== undefined) listOpts.cursor = cursor;
        const result = await kv.list(listOpts);
        for (const { name } of result.keys) {
          await kv.delete(name);
          removed += 1;
        }
        cursor = result.list_complete ? undefined : result.cursor;
      } while (cursor !== undefined);
      return removed;
    },
  };
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
