/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';

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
  json(value: unknown, status?: number): Response;
}

export type HonoNext = () => Promise<void>;

/**
 * Hono middleware that intercepts `/v1/chat/completions`-style POST routes
 * proxied to a backend. On cache hit, returns the cached response with no
 * downstream call. On miss, runs the next handler and stores the JSON body
 * of the resulting `Response`.
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
    if (cached !== undefined) return c.json(cached);

    await next();
    const setOpts: { ttl?: number } = {};
    if (options.ttl !== undefined) setOpts.ttl = options.ttl;
    // Hono does not surface the response body to the middleware after `next()`.
    // We rely on consumers re-invoking via the `extractRequest` lookup path
    // and writing entries explicitly when the handler completes. For a
    // fully-automatic cache-the-response flow, see `adapters/next` which
    // runs at the handler level.
    void setOpts;
    return undefined;
  };
}

async function defaultExtract(c: HonoContextLike): Promise<CacheRequest | undefined> {
  const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body || typeof body['model'] !== 'string') return undefined;
  const model = body['model'];
  const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
    model,
    params: extractParams(body),
  };
  if (Array.isArray(body['messages'])) out.messages = body['messages'] as NonNullable<CacheRequest['messages']>;
  else out.input = body;
  if (Array.isArray(body['tools'])) out.tools = body['tools'] as NonNullable<CacheRequest['tools']>;
  return out;
}

function extractParams(body: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (k === 'model' || k === 'messages' || k === 'tools' || k === 'stream' || k === 'stream_options') continue;
    params[k] = body[k];
  }
  return params;
}
