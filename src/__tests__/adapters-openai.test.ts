import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openAIStreamSerializer, wrapOpenAI } from '../adapters/openai/index.js';
import type { OpenAILike } from '../adapters/openai/index.js';
import { createCache } from '../core/cache.js';
import { memoryStorage } from '../storage/memory.js';
import { ConfigError } from '../errors/config-error.js';
import type { Cache } from '../core/types.js';

const newCache = (): Cache => createCache({ storage: memoryStorage(), ttlJitter: 0 });

const makeFakeClient = () => {
  const calls: { name: string; params: unknown }[] = [];
  return {
    calls,
    chat: {
      completions: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          calls.push({ name: 'chat', params });
          return { id: 'res', model: params['model'], choices: [{ message: { role: 'assistant', content: 'hi' } }] };
        }),
      },
    },
    embeddings: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        calls.push({ name: 'embeddings', params });
        return { data: [{ embedding: [0.1, 0.2] }] };
      }),
    },
    responses: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        calls.push({ name: 'responses', params });
        return { output: 'r' };
      }),
    },
  };
};

describe('openAIStreamSerializer', () => {
  it('should round-trip stream chunks', () => {
    const data = openAIStreamSerializer.serialize([{ id: '1' }]);
    const back = openAIStreamSerializer.deserialize(data);
    expect(back).toEqual([{ id: '1' }]);
  });

  it('should accept Uint8Array input on deserialize', () => {
    const bytes = new TextEncoder().encode('[]');
    const back = openAIStreamSerializer.deserialize(bytes);
    expect(back).toEqual([]);
  });

  it('should expose stable id', () => {
    expect(openAIStreamSerializer.id).toBe('openai-stream-v1');
  });
});

describe('wrapOpenAI', () => {
  let cache: Cache;
  beforeEach(() => {
    cache = newCache();
  });

  it('should reject when cache is missing', () => {
    expect(() => wrapOpenAI(makeFakeClient() as never, {} as never)).toThrow(ConfigError);
  });

  it('should NOT mutate the original client', async () => {
    const client = makeFakeClient();
    const original = client.chat.completions.create;
    wrapOpenAI(client as unknown as OpenAILike, { cache });
    expect(client.chat.completions.create).toBe(original);
  });

  it('should be idempotent — wrapping twice returns the original wrapper', () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache });
    const again = wrapOpenAI(wrapped, { cache });
    expect(again).toBe(wrapped);
  });

  it('should cache chat.completions.create on second call', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache });
    const params = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    await wrapped.chat.completions.create(params);
    await wrapped.chat.completions.create(params);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('should pass non-stream calls through wrap', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache, namespace: 'ns' });
    const params = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 };
    const out = await wrapped.chat.completions.create(params);
    expect(out).toMatchObject({ model: 'gpt-4o' });
  });

  it('should respect skip predicate', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, {
      cache,
      skip: (req) => Boolean((req as { stream?: boolean })?.stream),
    });
    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }], stream: false });
    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }], stream: false });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('should support per-call ttl callback', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, {
      cache,
      ttl: (req) => (((req as { model?: string })?.model === 'gpt-4o') ? 1000 : 60_000),
    });
    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }] });
    expect(client.chat.completions.create).toHaveBeenCalled();
  });

  it('should support numeric ttl', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache, ttl: 1000 });
    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a' }] });
  });

  it('should cache embeddings.create by input', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache });
    await wrapped.embeddings!.create({ model: 'text-embedding-3-small', input: 'hi' });
    await wrapped.embeddings!.create({ model: 'text-embedding-3-small', input: 'hi' });
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
  });

  it('should cache responses.create by input', async () => {
    const client = makeFakeClient();
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache });
    await wrapped.responses!.create({ model: 'gpt-4o', input: 'hi' });
    await wrapped.responses!.create({ model: 'gpt-4o', input: 'hi' });
    expect(client.responses.create).toHaveBeenCalledTimes(1);
  });

  it('should preserve non-create methods on each surface', () => {
    const client = {
      ...makeFakeClient(),
      somethingElse: 'preserved',
    };
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache });
    expect((wrapped as unknown as { somethingElse: string }).somethingElse).toBe('preserved');
  });

  it('should allow two wrapOpenAI calls with different namespaces', async () => {
    const client = makeFakeClient();
    const cache2 = newCache();
    const a = wrapOpenAI(client as unknown as OpenAILike, { cache, namespace: 'a' });
    const b = wrapOpenAI(client as unknown as OpenAILike, { cache: cache2, namespace: 'b' });
    await a.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    await b.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    // Both should hit the upstream once each because they live in different
    // namespaces / caches.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it('should NOT expose embeddings or responses proxy when client lacks them', () => {
    const minimal = {
      chat: { completions: { create: vi.fn(async () => ({ ok: true })) } },
    };
    const wrapped = wrapOpenAI(minimal as unknown as OpenAILike, { cache });
    expect((wrapped as unknown as { embeddings?: unknown }).embeddings).toBeUndefined();
    expect((wrapped as unknown as { responses?: unknown }).responses).toBeUndefined();
  });
});
