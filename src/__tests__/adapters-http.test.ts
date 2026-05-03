import { describe, expect, it, vi } from 'vitest';
import { cacheMiddleware as honoMiddleware, type HonoContextLike } from '../adapters/hono/index.js';
import {
  cacheMiddleware as expressMiddleware,
  type ExpressRequestLike,
  type ExpressResponseLike,
} from '../adapters/express/index.js';
import { withCache } from '../adapters/next/index.js';
import { createCache } from '../core/cache.js';
import { memoryStorage } from '../storage/memory.js';
import { ConfigError } from '../errors/config-error.js';
import { extractCacheRequestFromBody } from '../adapters/_shared/extract.js';
import type { Cache, CacheRequest } from '../core/types.js';

const newCache = (): Cache => createCache({ storage: memoryStorage(), ttlJitter: 0 });

const cacheRequestFor = (body: Record<string, unknown>): CacheRequest =>
  extractCacheRequestFromBody(body)!;

describe('Hono cacheMiddleware', () => {
  it('should reject when cache is missing', () => {
    expect(() => honoMiddleware({} as never)).toThrow(ConfigError);
  });

  it('should pass through non-POST requests', async () => {
    const cache = newCache();
    const mw = honoMiddleware({ cache });
    const next = vi.fn(async () => undefined);
    const c: HonoContextLike = {
      req: { method: 'GET', url: 'http://x', json: async () => ({}) },
      res: new Response('{}'),
      json: (v) => Response.json(v),
    };
    await mw(c, next);
    expect(next).toHaveBeenCalled();
  });

  it('should serve from cache on hit and add X-Cache: HIT', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    await cache.set(cacheRequestFor(body), { reply: 'cached' });
    const mw = honoMiddleware({ cache });
    const next = vi.fn(async () => undefined);
    const c: HonoContextLike = {
      req: { method: 'POST', url: '/', json: async () => body },
      res: new Response('{}'),
      json: (v) => Response.json(v),
    };
    const res = (await mw(c, next)) as Response;
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(next).not.toHaveBeenCalled();
  });

  it('should write to cache on miss when downstream produces JSON', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const mw = honoMiddleware({ cache });
    const downstreamResponse = Response.json({ reply: 'fresh' });
    const c: HonoContextLike = {
      req: { method: 'POST', url: '/', json: async () => body },
      res: downstreamResponse,
      json: (v) => Response.json(v),
    };
    const next = vi.fn(async () => {
      c.res = downstreamResponse;
    });
    await mw(c, next);
    const cached = await cache.get(cacheRequestFor(body));
    expect(cached).toEqual({ reply: 'fresh' });
  });

  it('should pass through when extract throws', async () => {
    const cache = newCache();
    const mw = honoMiddleware({
      cache,
      extractRequest: () => {
        throw new Error('extract boom');
      },
    });
    const next = vi.fn(async () => undefined);
    const c: HonoContextLike = {
      req: { method: 'POST', url: '/', json: async () => ({}) },
      res: new Response('{}'),
      json: (v) => Response.json(v),
    };
    await mw(c, next);
    expect(next).toHaveBeenCalled();
  });

  it('should pass through when extract returns undefined', async () => {
    const cache = newCache();
    const mw = honoMiddleware({ cache });
    const next = vi.fn(async () => undefined);
    const c: HonoContextLike = {
      req: { method: 'POST', url: '/', json: async () => ({}) },
      res: new Response('{}'),
      json: (v) => Response.json(v),
    };
    await mw(c, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('Express cacheMiddleware', () => {
  const buildRes = (): ExpressResponseLike & { written?: unknown; headers: Record<string, string>; statusCode: number } => {
    const res: ExpressResponseLike & { written?: unknown; headers: Record<string, string>; statusCode: number } = {
      headers: {},
      statusCode: 200,
      json(body: unknown) {
        res.written = body;
        return res as unknown;
      },
      send(body: unknown) {
        res.written = body;
        return res as unknown;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    };
    return res;
  };

  it('should reject when cache is missing', () => {
    expect(() => expressMiddleware({} as never)).toThrow(ConfigError);
  });

  it('should pass through non-POST', () => {
    const cache = newCache();
    const mw = expressMiddleware({ cache });
    const next = vi.fn();
    const req: ExpressRequestLike = { method: 'GET', body: {}, url: '/' };
    mw(req, buildRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('should pass through when extract returns undefined', () => {
    const cache = newCache();
    const mw = expressMiddleware({ cache });
    const next = vi.fn();
    const req: ExpressRequestLike = { method: 'POST', body: {}, url: '/' };
    mw(req, buildRes(), next);
    setTimeout(() => expect(next).toHaveBeenCalled(), 0);
  });

  it('should serve cache hit with X-Cache: HIT header', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    await cache.set(cacheRequestFor(body), { reply: 'cached' });
    const mw = expressMiddleware({ cache });
    const res = buildRes();
    const next = vi.fn();
    mw({ method: 'POST', body, url: '/' } as ExpressRequestLike, res, next);
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(res.written).toEqual({ reply: 'cached' });
    expect(res.headers['X-Cache']).toBe('HIT');
    expect(next).not.toHaveBeenCalled();
  });

  it('should persist downstream JSON on miss', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const mw = expressMiddleware({ cache });
    const res = buildRes();
    const next = vi.fn(() => {
      res.json({ reply: 'fresh' });
    });
    mw({ method: 'POST', body, url: '/' } as ExpressRequestLike, res, next);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(await cache.get(cacheRequestFor(body))).toEqual({ reply: 'fresh' });
  });

  it('should NOT persist on non-2xx status', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const mw = expressMiddleware({ cache });
    const res = buildRes();
    res.statusCode = 500;
    const next = vi.fn(() => {
      res.json({ error: 'boom' });
    });
    mw({ method: 'POST', body, url: '/' } as ExpressRequestLike, res, next);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(await cache.get(cacheRequestFor(body))).toBeUndefined();
  });

  it('should pass through when extractRequest throws', () => {
    const cache = newCache();
    const next = vi.fn();
    const mw = expressMiddleware({
      cache,
      extractRequest: () => {
        throw new Error('boom');
      },
    });
    mw({ method: 'POST', body: {}, url: '/' } as ExpressRequestLike, buildRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('Next withCache', () => {
  it('should reject when cache is missing', () => {
    expect(() => withCache(async () => new Response(), {} as never)).toThrow(ConfigError);
  });

  it('should pass through non-POST', async () => {
    const cache = newCache();
    const handler = vi.fn(async (_req: Request) => new Response('ok'));
    const wrapped = withCache(handler, { cache });
    const req = new Request('http://x', { method: 'GET' });
    await wrapped(req);
    expect(handler).toHaveBeenCalled();
  });

  it('should serve cache hit with X-Cache: HIT', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    await cache.set(cacheRequestFor(body), { reply: 'cached' });
    const handler = vi.fn(async (_req: Request) => new Response('downstream', { status: 200 }));
    const wrapped = withCache(handler, { cache });
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
    const res = await wrapped(req);
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(handler).not.toHaveBeenCalled();
  });

  it('should persist downstream JSON on miss', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const handler = vi.fn(async (_req: Request) => Response.json({ reply: 'fresh' }));
    const wrapped = withCache(handler, { cache });
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
    await wrapped(req);
    expect(await cache.get(cacheRequestFor(body))).toEqual({ reply: 'fresh' });
  });

  it('should pass through when body extract returns undefined', async () => {
    const cache = newCache();
    const handler = vi.fn(async (_req: Request) => new Response('ok'));
    const wrapped = withCache(handler, { cache });
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ no: 'model' }) });
    await wrapped(req);
    expect(handler).toHaveBeenCalled();
  });

  it('should pass through when extract throws', async () => {
    const cache = newCache();
    const handler = vi.fn(async (_req: Request) => new Response('ok'));
    const wrapped = withCache(handler, {
      cache,
      extractRequest: async () => {
        throw new Error('boom');
      },
    });
    const req = new Request('http://x', { method: 'POST', body: '{}' });
    await wrapped(req);
    expect(handler).toHaveBeenCalled();
  });

  it('should NOT cache non-OK responses', async () => {
    const cache = newCache();
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }] };
    const handler = vi.fn(async (_req: Request) => new Response('boom', { status: 500 }));
    const wrapped = withCache(handler, { cache });
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
    await wrapped(req);
    expect(await cache.get(cacheRequestFor(body))).toBeUndefined();
  });
});
