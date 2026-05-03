/**
 * basic-usage.ts — minimal demo of @aikit/cache.
 *
 * Run: npm start
 *
 * What it shows:
 *   - createCache() with the in-memory LRU storage adapter
 *   - cache.wrap() returning a fresh value on miss and a cached value on hit
 *   - measurable speedup on the second call
 *   - cache.stats() reporting hits / misses / hit rate
 *
 * No API keys are required. We mock the LLM call so the example is
 * deterministic and runnable in any environment.
 */
import { createCache } from '@aikit/cache';
import { memoryStorage } from '@aikit/cache/storage';

interface ChatCompletion {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

async function fakeLLM(prompt: string): Promise<ChatCompletion> {
  await sleep(400);
  return {
    id: `cmpl_${Math.random().toString(36).slice(2, 10)}`,
    model: 'gpt-4o',
    content: `Mock reply to: "${prompt}"`,
    usage: { inputTokens: prompt.length, outputTokens: 32 },
  };
}

const cache = createCache({
  storage: memoryStorage({ max: 1_000 }),
  ttl: { default: 60_000 },
});

async function ask(prompt: string): Promise<{ value: ChatCompletion; ms: number }> {
  const start = Date.now();
  const value = await cache.wrap(
    { model: 'gpt-4o', messages: [{ role: 'user', content: prompt }] },
    () => fakeLLM(prompt),
  );
  return { value, ms: Date.now() - start };
}

const a = await ask('What is the capital of France?');
console.log(`miss → ${a.ms} ms — ${a.value.content}`);

const b = await ask('What is the capital of France?');
console.log(`hit  → ${b.ms} ms — ${b.value.content}`);

const c = await ask('Who wrote The Iliad?');
console.log(`miss → ${c.ms} ms — ${c.value.content}`);

const stats = cache.stats();
console.log('\nstats:', {
  hits: stats.hits,
  misses: stats.misses,
  hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
});

await cache.dispose();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
