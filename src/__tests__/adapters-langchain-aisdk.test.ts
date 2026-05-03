import { describe, expect, it, vi } from 'vitest';
import { LangChainCache } from '../adapters/langchain/index.js';
import { aiSdkStreamSerializer, cacheMiddleware as aiSdkMiddleware } from '../adapters/ai-sdk/index.js';
import { createCache } from '../core/cache.js';
import { memoryStorage } from '../storage/memory.js';
import { ConfigError } from '../errors/config-error.js';
import type { Cache } from '../core/types.js';

const newCache = (): Cache => createCache({ storage: memoryStorage(), ttlJitter: 0 });

describe('LangChainCache', () => {
  it('should reject when cache is missing', () => {
    expect(() => new LangChainCache({} as never)).toThrow(ConfigError);
  });

  it('should round-trip generations via lookup/update', async () => {
    const lc = new LangChainCache({ cache: newCache() });
    const generations = [{ text: 'hi' }];
    await lc.update('prompt', 'llmKey', generations);
    expect(await lc.lookup('prompt', 'llmKey')).toEqual(generations);
  });

  it('should return null for cache misses', async () => {
    const lc = new LangChainCache({ cache: newCache() });
    expect(await lc.lookup('absent', 'k')).toBeNull();
  });

  it('should isolate by namespace', async () => {
    const cache = newCache();
    const a = new LangChainCache({ cache, namespace: 'a' });
    const b = new LangChainCache({ cache, namespace: 'b' });
    await a.update('p', 'k', [{ text: 'value-a' }]);
    expect(await b.lookup('p', 'k')).toBeNull();
  });
});

describe('aiSdkStreamSerializer', () => {
  it('should round-trip stream parts', () => {
    const data = aiSdkStreamSerializer.serialize([{ type: 'text-delta', text: 'a' }]);
    expect(aiSdkStreamSerializer.deserialize(data)).toEqual([{ type: 'text-delta', text: 'a' }]);
  });

  it('should accept Uint8Array input', () => {
    expect(aiSdkStreamSerializer.deserialize(new TextEncoder().encode('[]'))).toEqual([]);
  });

  it('should expose stable id', () => {
    expect(aiSdkStreamSerializer.id).toBe('ai-sdk-stream-v1');
  });
});

describe('ai-sdk cacheMiddleware', () => {
  it('should reject when cache is missing', () => {
    expect(() => aiSdkMiddleware({} as never)).toThrow(ConfigError);
  });

  it('should expose middlewareVersion v3', () => {
    const mw = aiSdkMiddleware({ cache: newCache() });
    expect(mw.middlewareVersion).toBe('v3');
  });

  it('should call doGenerate on miss and cache the result', async () => {
    const cache = newCache();
    const mw = aiSdkMiddleware({ cache });
    const doGenerate = vi.fn(async () => ({ text: 'hi' }));
    await mw.wrapGenerate!({
      doGenerate,
      params: { messages: [{ role: 'user', content: 'hi' }] },
      model: { modelId: 'gpt-4o' },
    });
    await mw.wrapGenerate!({
      doGenerate,
      params: { messages: [{ role: 'user', content: 'hi' }] },
      model: { modelId: 'gpt-4o' },
    });
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it('should respect skip predicate', async () => {
    const cache = newCache();
    const mw = aiSdkMiddleware({ cache, skip: () => true });
    const doGenerate = vi.fn(async () => ({ text: 'hi' }));
    await mw.wrapGenerate!({
      doGenerate,
      params: { messages: [] },
      model: { modelId: 'gpt-4o' },
    });
    await mw.wrapGenerate!({
      doGenerate,
      params: { messages: [] },
      model: { modelId: 'gpt-4o' },
    });
    expect(doGenerate).toHaveBeenCalledTimes(2);
  });

  it('should support a namespace', async () => {
    const cache = newCache();
    const mw = aiSdkMiddleware({ cache, namespace: 'ns', ttl: 100 });
    const doGenerate = vi.fn(async () => ({ text: 'hi' }));
    await mw.wrapGenerate!({
      doGenerate,
      params: { messages: [{ role: 'user', content: 'hi' }] },
      model: { modelId: 'gpt-4o' },
    });
    expect(doGenerate).toHaveBeenCalled();
  });

  it('should fall back to prompt input when messages is missing', async () => {
    const cache = newCache();
    const mw = aiSdkMiddleware({ cache });
    const doGenerate = vi.fn(async () => ({ text: 'hi' }));
    await mw.wrapGenerate!({
      doGenerate,
      params: { prompt: 'hi' },
      model: { modelId: 'gpt-4o' },
    });
    await mw.wrapGenerate!({
      doGenerate,
      params: { prompt: 'hi' },
      model: { modelId: 'gpt-4o' },
    });
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it('should wrap and replay streams', async () => {
    const cache = newCache();
    const mw = aiSdkMiddleware({ cache });
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', text: 'a' });
          controller.close();
        },
      }),
    }));
    const first = await mw.wrapStream!({
      doStream,
      params: { messages: [{ role: 'user', content: 'hi' }] },
      model: { modelId: 'gpt-4o' },
    });
    // Drain the first stream so the cache write completes.
    const reader = first.stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await cache.flush();

    const second = await mw.wrapStream!({
      doStream,
      params: { messages: [{ role: 'user', content: 'hi' }] },
      model: { modelId: 'gpt-4o' },
    });
    const out: Array<unknown> = [];
    const r2 = second.stream.getReader();
    for (;;) {
      const { value, done } = await r2.read();
      if (done) break;
      out.push(value);
    }
    expect(out).toEqual([{ type: 'text-delta', text: 'a' }]);
    expect(doStream).toHaveBeenCalledTimes(1);
  });

  it('should respect skip predicate on streams', async () => {
    const cache = newCache();
    const mw = aiSdkMiddleware({ cache, skip: () => true });
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    }));
    await mw.wrapStream!({
      doStream,
      params: { messages: [] },
      model: { modelId: 'gpt-4o' },
    });
    expect(doStream).toHaveBeenCalled();
  });
});
