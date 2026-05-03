import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCache } from '../core/cache.js';
import { memoryStorage } from '../storage/memory.js';
import { multiTierStorage } from '../storage/multi-tier.js';
import { withSemantic } from '../semantic/layer.js';
import { customEmbeddings } from '../embeddings/custom.js';
import { defaultCostTracker, registerModel, unregisterModel } from '../cost/index.js';
import { wrapOpenAI } from '../adapters/openai/index.js';
import type { OpenAILike } from '../adapters/openai/index.js';
import { LangChainCache } from '../adapters/langchain/index.js';
import type { Cache, CacheRequest } from '../core/types.js';

let now = 1_000_000;
const clock = { now: () => now };

beforeEach(() => {
  now = 1_000_000;
});

const userMessage = (text: string): CacheRequest => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: text }],
});

describe('end-to-end exact-match caching', () => {
  it('should serve repeat requests from cache and report savings', async () => {
    const cache = createCache({
      storage: memoryStorage({ clock }),
      clock,
      ttlJitter: 0,
      costTracker: defaultCostTracker,
    });

    let fetchCount = 0;
    const fakeOpenAi = async (req: CacheRequest) =>
      cache.wrap(req, async () => {
        fetchCount += 1;
        return {
          model: req.model,
          choices: [{ message: { role: 'assistant', content: 'cached reply' } }],
          usage: { prompt_tokens: 10_000, completion_tokens: 5_000 },
        };
      });

    await fakeOpenAi(userMessage('hello'));
    await fakeOpenAi(userMessage('hello'));
    await fakeOpenAi(userMessage('hello'));

    expect(fetchCount).toBe(1);
    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
    expect(stats.savedUSD).toBeGreaterThan(0);
    expect(stats.byModel['gpt-4o']?.hits).toBe(2);
    await cache.dispose();
  });

  it('should differentiate requests by params', async () => {
    const cache = createCache({ storage: memoryStorage({ clock }), clock, ttlJitter: 0 });
    const fn = vi.fn().mockResolvedValue('ok');
    await cache.wrap({ ...userMessage('hi'), params: { temperature: 0 } }, fn);
    await cache.wrap({ ...userMessage('hi'), params: { temperature: 1 } }, fn);
    expect(fn).toHaveBeenCalledTimes(2);
    await cache.dispose();
  });

  it('should expire entries based on per-model TTL', async () => {
    const cache = createCache({
      storage: memoryStorage({ clock }),
      clock,
      ttlJitter: 0,
      perModelTTL: { 'gpt-4o': 5_000 },
    });
    const fn = vi.fn().mockResolvedValue('v');
    await cache.wrap(userMessage('hi'), fn);
    now += 10_000;
    await cache.wrap(userMessage('hi'), fn);
    expect(fn).toHaveBeenCalledTimes(2);
    await cache.dispose();
  });
});

describe('end-to-end multi-tier caching', () => {
  it('should backfill the upper tier from the lower tier on hit', async () => {
    const upper = memoryStorage({ clock });
    const lower = memoryStorage({ clock });
    const tier = multiTierStorage([upper, lower], { clock });
    const cache = createCache({ storage: tier, clock, ttlJitter: 0 });
    await cache.set(userMessage('hi'), 'v');
    // Drop the upper tier's copy by clearing it directly.
    await upper.clear();
    expect(await cache.get(userMessage('hi'))).toBe('v');
    expect(await upper.get(await keyOf(cache, userMessage('hi')))).toBeDefined();
    await cache.dispose();
  });
});

describe('end-to-end semantic caching', () => {
  it('should treat semantically similar requests as hits', async () => {
    const provider = customEmbeddings({
      name: 'mock',
      model: 'mock-1',
      dimensions: 2,
      embed: async (inputs) =>
        inputs.map((s) =>
          /weather/i.test(s) ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]),
        ),
    });
    const semantic = withSemantic({ embeddings: provider, threshold: 0.9 });
    const cache = createCache({
      storage: memoryStorage({ clock }),
      clock,
      ttlJitter: 0,
      semantic,
    });
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return 'sunny';
    };
    await cache.wrap(userMessage("what's the weather"), fn);
    await cache.flush();
    const out = await cache.wrap(userMessage('weather report please'), fn);
    expect(out).toBe('sunny');
    expect(calls).toBe(1);
    await cache.dispose();
  });
});

describe('end-to-end adapter integration', () => {
  it('should compose wrapOpenAI with a real cache and shared storage', async () => {
    const cache = createCache({ storage: memoryStorage({ clock }), clock, ttlJitter: 0 });
    const inner = vi.fn(async (params: Record<string, unknown>) => ({
      id: 'res',
      model: params['model'],
    }));
    const client = { chat: { completions: { create: inner } } };
    const wrapped = wrapOpenAI(client as unknown as OpenAILike, { cache });
    const params = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    await wrapped.chat.completions.create(params);
    await wrapped.chat.completions.create(params);
    expect(inner).toHaveBeenCalledTimes(1);
    await cache.dispose();
  });

  it('should compose LangChainCache against a shared cache', async () => {
    const cache = createCache({ storage: memoryStorage({ clock }), clock, ttlJitter: 0 });
    const lc = new LangChainCache({ cache });
    await lc.update('p', 'k', [{ text: 'cached' }]);
    expect(await lc.lookup('p', 'k')).toEqual([{ text: 'cached' }]);
    await cache.dispose();
  });
});

describe('end-to-end cost tracking', () => {
  it('should track per-model savings against registered pricing', async () => {
    registerModel('integration:test-model', { inputUSDPer1M: 100, outputUSDPer1M: 100 });
    try {
      const cache = createCache({
        storage: memoryStorage({ clock }),
        clock,
        ttlJitter: 0,
        costTracker: defaultCostTracker,
      });
      const req: CacheRequest = {
        model: 'integration:test-model',
        messages: [{ role: 'user', content: 'hi' }],
      };
      await cache.wrap(req, async () => ({
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }));
      await cache.wrap(req, async () => ({}));
      const snap = cache.stats();
      expect(snap.savedUSD).toBeCloseTo(200, 6);
      await cache.dispose();
    } finally {
      unregisterModel('integration:test-model');
    }
  });
});

describe('end-to-end stream caching', () => {
  it('should replay a captured stream byte-for-byte', async () => {
    const cache = createCache({ storage: memoryStorage({ clock }), clock, ttlJitter: 0 });
    const serializer = {
      id: 'integration-stream-v1',
      serialize: (chunks: readonly string[]) => JSON.stringify(chunks),
      deserialize: (data: string | Uint8Array) =>
        JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as readonly string[],
    };
    const upstream = (items: readonly string[]) =>
      new ReadableStream<string>({
        start(controller) {
          for (const item of items) controller.enqueue(item);
          controller.close();
        },
      });

    const drain = async (s: ReadableStream<string>): Promise<string[]> => {
      const reader = s.getReader();
      const out: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out.push(value);
      }
      return out;
    };

    const req = userMessage('hi');
    await drain(await cache.wrapStream(req, () => upstream(['a', 'b', 'c']), { serializer }));
    await cache.flush();
    const replayed = await drain(
      await cache.wrapStream(req, () => upstream(['x']), { serializer }),
    );
    expect(replayed).toEqual(['a', 'b', 'c']);
    await cache.dispose();
  });
});

async function keyOf(cache: Cache, request: CacheRequest): Promise<string> {
  // Round-trip through hashRequest to derive the storage key without
  // exposing the cache's internal builder.
  const { hashRequest } = await import('../core/key.js');
  return hashRequest(request);
}
