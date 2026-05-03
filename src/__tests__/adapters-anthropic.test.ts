import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicStreamSerializer, wrapAnthropic } from '../adapters/anthropic/index.js';
import type { AnthropicLike } from '../adapters/anthropic/index.js';
import { createCache } from '../core/cache.js';
import { memoryStorage } from '../storage/memory.js';
import { ConfigError } from '../errors/config-error.js';
import type { Cache } from '../core/types.js';

const newCache = (): Cache => createCache({ storage: memoryStorage(), ttlJitter: 0 });

const makeClient = () => ({
  messages: {
    create: vi.fn(async (params: Record<string, unknown>) => ({
      id: 'msg',
      model: params['model'],
      content: [{ type: 'text', text: 'hi' }],
    })),
    stream: vi.fn(async (_params: Record<string, unknown>) => {
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'message_stop' });
          controller.close();
        },
      });
    }),
  },
});

describe('anthropicStreamSerializer', () => {
  it('should round-trip stream events', () => {
    const data = anthropicStreamSerializer.serialize([{ type: 'message_stop' }]);
    expect(anthropicStreamSerializer.deserialize(data)).toEqual([{ type: 'message_stop' }]);
  });

  it('should accept Uint8Array on deserialize', () => {
    const data = new TextEncoder().encode('[]');
    expect(anthropicStreamSerializer.deserialize(data)).toEqual([]);
  });

  it('should expose stable id', () => {
    expect(anthropicStreamSerializer.id).toBe('anthropic-stream-v1');
  });
});

describe('wrapAnthropic', () => {
  let cache: Cache;
  beforeEach(() => {
    cache = newCache();
  });

  it('should reject when cache is missing', () => {
    expect(() => wrapAnthropic(makeClient() as never, {} as never)).toThrow(ConfigError);
  });

  it('should NOT mutate the original client', () => {
    const client = makeClient();
    const original = client.messages.create;
    wrapAnthropic(client as unknown as AnthropicLike, { cache });
    expect(client.messages.create).toBe(original);
  });

  it('should be idempotent', () => {
    const client = makeClient();
    const wrapped = wrapAnthropic(client as unknown as AnthropicLike, { cache });
    expect(wrapAnthropic(wrapped, { cache })).toBe(wrapped);
  });

  it('should cache messages.create on second call', async () => {
    const client = makeClient();
    const wrapped = wrapAnthropic(client as unknown as AnthropicLike, { cache });
    const params = {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    };
    await wrapped.messages.create(params);
    await wrapped.messages.create(params);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('should treat `system` as a hashable param', async () => {
    const client = makeClient();
    const wrapped = wrapAnthropic(client as unknown as AnthropicLike, { cache });
    const base = { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] };
    await wrapped.messages.create(base);
    await wrapped.messages.create({ ...base, system: 'You are a pirate' });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('should respect skip predicate', async () => {
    const client = makeClient();
    const wrapped = wrapAnthropic(client as unknown as AnthropicLike, {
      cache,
      skip: () => true,
    });
    await wrapped.messages.create({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'a' }] });
    await wrapped.messages.create({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'a' }] });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('should accept numeric ttl override', async () => {
    const client = makeClient();
    const wrapped = wrapAnthropic(client as unknown as AnthropicLike, { cache, ttl: 1000 });
    await wrapped.messages.create({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'a' }] });
  });

  it('should accept ttl callback', async () => {
    const client = makeClient();
    const wrapped = wrapAnthropic(client as unknown as AnthropicLike, {
      cache,
      ttl: () => 1000,
    });
    await wrapped.messages.create({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'a' }] });
  });

  it('should preserve namespace per wrapper', async () => {
    const client = makeClient();
    const cache2 = newCache();
    const a = wrapAnthropic(client as unknown as AnthropicLike, { cache, namespace: 'a' });
    const b = wrapAnthropic(client as unknown as AnthropicLike, { cache: cache2, namespace: 'b' });
    const params = { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] };
    await a.messages.create(params);
    await b.messages.create(params);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });
});
