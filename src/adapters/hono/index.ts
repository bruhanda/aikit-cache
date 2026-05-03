import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import { extractCacheRequestFromBody } from '../_shared/extract.js';

/**
 * Minimal structural view of Hono's `Context`. We do not import `hono`.
 * The handler's typing remains compatible with `MiddlewareHandler<E>` from
 * the user's installed `hono` package because both shapes resolve to
 * `(c: Context, next: () => Promise<void>) => Promise<Response | void>`.
 */
export interface HonoContextLike {
  readonly req: {
    readonly method: string;
    readonly url: string;
    json(): Promise<unknown>;
    raw?: Request;
  };
  res: Response;
  json(value: unknown, status?: number): Response;
}

export type HonoNext = () => Promise<void>;

/**
 * Hono middleware that intercepts `/v1/chat/completions`-style POST routes
 * proxied to a backend. On cache hit, returns the cached response with no
 * downstream call. On miss, runs the next handler and stores the JSON body
 * of the resulting `Response` (read off `c.res` after `next()`).
 *
 * @param options Cache plus optional TTL and request extractor.
 * @returns Hono-compatible middleware function.
 *
 * @example
 * app.post('/v1/chat/completions', cacheMiddleware({ cache }), handler);
 */
export function cacheMiddleware(options: {
  readonly cache: Cache;
  readonly ttl?: number;
  readonly extractRequest?: (c: HonoContextLike) => CacheRequest | undefined | Promise<CacheRequest | undefined>;
}): (c: HonoContextLike, next: HonoNext) => Promise<Response | void> {
  if (!options?.cache) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'cacheMiddleware requires a `cache` option', { field: 'cache' });
  }
  const cache = options.cache;
  const extract = options.extractRequest ?? defaultExtract;

  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    let req: CacheRequest | undefined;
    try {
      req = await extract(c);
    } catch {
      return next();
    }
    if (!req) return next();

    const cached = await cache.get<unknown>(req);
    if (cached !== undefined) {
      const res = c.json(cached);
      res.headers.set('X-Cache', 'HIT');
      return res;
    }

    await next();

    const downstream = c.res;
    if (!downstream || !downstream.ok) return undefined;
    try {
      const body = (await downstream.clone().json()) as unknown;
      const setOpts: { ttl?: number } = {};
      if (options.ttl !== undefined) setOpts.ttl = options.ttl;
      await cache.set(req, body, setOpts);
    } catch {
      // non-JSON or already-consumed body — skip the write
    }
    return undefined;
  };
}

async function defaultExtract(c: HonoContextLike): Promise<CacheRequest | undefined> {
  const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  return extractCacheRequestFromBody(body);
}
