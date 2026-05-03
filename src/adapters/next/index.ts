import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import { extractCacheRequestFromBody } from '../_shared/extract.js';

export type NextRouteHandler = (request: Request) => Response | Promise<Response>;

/**
 * Wrap a Next.js Route Handler so its JSON output is automatically cached.
 *
 * Caching only kicks in when the request body parses as `{ model, ... }`
 * (the universal LLM-style shape). Non-JSON or shape-incompatible requests
 * pass through unchanged.
 *
 * Note: in static-export builds the cache layer still runs, but writes to
 * read-only edge caches simply no-op so production behaves identically.
 *
 * @param handler The Route Handler `(req: Request) => Response`.
 * @param options Cache plus optional TTL and custom request extractor.
 * @returns The wrapped Route Handler with caching.
 *
 * @example
 * export const POST = withCache(async (req: Request) => {
 *   const body = await req.json();
 *   return Response.json(await openai.chat.completions.create(body));
 * }, { cache, ttl: 3_600_000 });
 */
export function withCache<H extends NextRouteHandler>(
  handler: H,
  options: {
    readonly cache: Cache;
    readonly ttl?: number;
    readonly extractRequest?: (req: Request) => Promise<CacheRequest | undefined> | CacheRequest | undefined;
  },
): H {
  if (!options?.cache) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'withCache requires a `cache` option', { field: 'cache' });
  }
  const cache = options.cache;
  const extract = options.extractRequest ?? defaultExtract;

  const wrapped: NextRouteHandler = async (request) => {
    if (request.method !== 'POST') return handler(request);

    const clone = request.clone();
    let req: CacheRequest | undefined;
    try {
      req = await extract(clone);
    } catch {
      return handler(request);
    }
    if (!req) return handler(request);

    const cached = await cache.get<unknown>(req);
    if (cached !== undefined) return Response.json(cached, { headers: { 'X-Cache': 'HIT' } });

    const response = await handler(request);
    if (!response.ok) return response;

    try {
      const responseClone = response.clone();
      const body = (await responseClone.json()) as unknown;
      const setOpts: { ttl?: number } = {};
      if (options.ttl !== undefined) setOpts.ttl = options.ttl;
      await cache.set(req, body, setOpts);
    } catch {
      // non-JSON or already-consumed body — skip the write
    }
    return response;
  };
  return wrapped as H;
}

async function defaultExtract(request: Request): Promise<CacheRequest | undefined> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  return extractCacheRequestFromBody(body);
}
