/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';

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
}

export type ExpressNext = (err?: unknown) => void;

/**
 * Express request-handler middleware. On cache hit, responds with the
 * cached JSON without calling `next()`. On miss, calls `next()` and
 * leaves the downstream handler responsible for sending the response.
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
        next();
      })
      .catch(() => next());
  };
}

function defaultExtract(req: ExpressRequestLike): CacheRequest | undefined {
  const body = req.body;
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b['model'] !== 'string') return undefined;
  const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
    model: b['model'],
    params: extractParams(b),
  };
  if (Array.isArray(b['messages'])) out.messages = b['messages'] as NonNullable<CacheRequest['messages']>;
  else out.input = b;
  if (Array.isArray(b['tools'])) out.tools = b['tools'] as NonNullable<CacheRequest['tools']>;
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
