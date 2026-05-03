import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import { extractCacheRequestFromBody } from '../_shared/extract.js';

/** Subset of `express.Request`. */
export interface ExpressRequestLike {
  readonly method: string;
  readonly body: unknown;
  readonly url: string;
}

/** Subset of `express.Response`. */
export interface ExpressResponseLike {
  json(body: unknown): unknown;
  send(body: unknown): unknown;
  status(code: number): ExpressResponseLike;
  setHeader?(name: string, value: string): unknown;
  statusCode?: number;
}

export type ExpressNext = (err?: unknown) => void;

/**
 * Express request-handler middleware. On cache hit, responds with the
 * cached JSON without calling `next()`. On miss, intercepts the
 * downstream handler's `res.json` / `res.send` so the JSON body is
 * captured and persisted before being forwarded to the client.
 *
 * @param options Cache plus optional TTL and request extractor.
 * @returns Express-compatible request handler.
 */
export function cacheMiddleware(options: {
  readonly cache: Cache;
  readonly ttl?: number;
  readonly extractRequest?: (req: ExpressRequestLike) => CacheRequest | undefined;
}): (req: ExpressRequestLike, res: ExpressResponseLike, next: ExpressNext) => void {
  if (!options?.cache) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'cacheMiddleware requires a `cache` option', { field: 'cache' });
  }
  const cache = options.cache;
  const extract = options.extractRequest ?? defaultExtract;

  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    let cacheReq: CacheRequest | undefined;
    try {
      cacheReq = extract(req);
    } catch {
      return next();
    }
    if (!cacheReq) return next();

    cache
      .get<unknown>(cacheReq)
      .then((cached) => {
        if (cached !== undefined) {
          res.setHeader?.('X-Cache', 'HIT');
          res.json(cached);
          return;
        }
        res.setHeader?.('X-Cache', 'MISS');

        const setOpts: { ttl?: number } = {};
        if (options.ttl !== undefined) setOpts.ttl = options.ttl;
        const persist = (body: unknown): void => {
          const status = res.statusCode ?? 200;
          if (status < 200 || status >= 300) return;
          void cache.set(cacheReq!, body, setOpts).catch(() => {});
        };

        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        res.json = (body: unknown) => {
          persist(body);
          return originalJson(body);
        };
        res.send = (body: unknown) => {
          if (typeof body === 'string') {
            try {
              persist(JSON.parse(body));
            } catch {
              // non-JSON body — skip
            }
          } else if (body !== undefined) {
            persist(body);
          }
          return originalSend(body);
        };

        next();
      })
      .catch(() => next());
  };
}

function defaultExtract(req: ExpressRequestLike): CacheRequest | undefined {
  return extractCacheRequestFromBody(req.body);
}
