/**
 * advanced-usage.ts — production-shaped demo of @aikit/cache.
 *
 * Run: npm start
 *
 * What it shows:
 *   - multi-tier storage (in-process L1 + a stub "remote" L2)
 *   - per-model TTL, sliding TTL, jitter
 *   - opt-in cost tracker with custom pricing — savings reported in $
 *   - semantic layer with a deterministic mock embedding provider, so
 *     paraphrases of the same question hit the cache
 *   - tag-based programmatic invalidation
 *   - event subscriptions (hit / miss / coalesce)
 *   - in-flight single-flight: 50 concurrent identical calls = 1 upstream
 *   - cache.stats() with savedUSD, embeddingCostUSD, byModel breakdown
 *
 * The fake LLM returns an OpenAI-shaped `usage` block so the cost tracker
 * picks up token counts automatically — the same code path that runs in
 * production with real OpenAI / Anthropic responses.
 *
 * No API keys are required.
 */
import { createCache } from '@aikit/cache';
import { memoryStorage, multiTierStorage } from '@aikit/cache/storage';
import { defaultCostTracker, registerModel } from '@aikit/cache/cost';
import { withSemantic } from '@aikit/cache/semantic';
import { customEmbeddings } from '@aikit/cache/embeddings';

interface ChatCompletion {
  readonly id: string;
  readonly model: string;
  readonly choices: readonly { readonly message: { readonly role: 'assistant'; readonly content: string } }[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

let upstreamCalls = 0;
async function fakeChat(model: string, prompt: string): Promise<ChatCompletion> {
  upstreamCalls += 1;
  await sleep(300);
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens = 256;
  return {
    id: `cmpl_${upstreamCalls}`,
    model,
    choices: [{ message: { role: 'assistant', content: `[${model}] reply to: ${prompt}` } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

registerModel('mock-embed-1', { inputUSDPer1M: 0.02, outputUSDPer1M: 0 });
registerModel('gpt-4o', { inputUSDPer1M: 2.5, outputUSDPer1M: 10 });
registerModel('claude-sonnet-4-6', { inputUSDPer1M: 3, outputUSDPer1M: 15 });

const storage = multiTierStorage([
  memoryStorage({ max: 100 }),
  memoryStorage({ max: 10_000 }),
]);

const embeddings = customEmbeddings({
  name: 'mock',
  model: 'mock-embed-1',
  dimensions: 16,
  embed: async (inputs) =>
    inputs.map((text) => {
      const v = new Float32Array(16);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        v[hash(word) % 16] += 1;
      }
      return normalize(v);
    }),
});

const cache = createCache({
  storage,
  ttl: { default: 60_000, sliding: true, maxAgeMs: 600_000 },
  perModelTTL: { 'gpt-4o': 30_000, 'claude-sonnet-4-6': 120_000 },
  ttlJitter: 0.1,
  namespace: 'demo',
  costTracker: defaultCostTracker,
  semantic: withSemantic({
    embeddings,
    threshold: 0.8,
    topK: 5,
    costTracker: defaultCostTracker,
  }),
  coalesce: true,
  onError: 'silent',
});

let verbose = true;
cache.on('hit', (e) => {
  if (verbose) console.log(`  hit (${e.from}${e.similarity ? `, sim=${e.similarity.toFixed(2)}` : ''})`);
});
cache.on('miss', (e) => {
  if (verbose) console.log(`  miss (${e.reason})`);
});
cache.on('coalesce', (e) => console.log(`  coalesced ${e.waiters} waiters`));

const ask = (model: string, prompt: string): Promise<ChatCompletion> =>
  cache.wrap(
    { model, messages: [{ role: 'user', content: prompt }] },
    () => fakeChat(model, prompt),
    { tags: [`model:${model}`] },
  );

console.log('1. exact-match');
await ask('gpt-4o', 'How do I cancel a subscription?');
await ask('gpt-4o', 'How do I cancel a subscription?');

console.log('\n2. semantic-match (paraphrase)');
await ask('gpt-4o', 'How can I cancel my subscription?');
await ask('gpt-4o', 'cancel subscription please');

console.log('\n3. single-flight coalescing — 50 concurrent identical calls');
upstreamCalls = 0;
verbose = false;
const concurrent = await Promise.all(
  Array.from({ length: 50 }, () => ask('claude-sonnet-4-6', 'novel question for coalesce demo')),
);
verbose = true;
console.log(`  upstream calls: ${upstreamCalls} (expected 1)`);
console.log(`  responses: ${concurrent.length} (all identical: ${concurrent.every((c) => c.id === concurrent[0]!.id)})`);

console.log('\n4. tag-based invalidation');
const removed = await cache.invalidate({ tag: 'model:gpt-4o' });
console.log(`  invalidated ${removed} entries tagged model:gpt-4o`);

console.log('\n5. stats');
const stats = cache.stats();
console.log({
  hits: stats.hits,
  misses: stats.misses,
  coalesced: stats.coalesced,
  hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
  savedTokens: stats.savedTokens,
  savedUSD: `$${stats.savedUSD.toFixed(6)}`,
  embeddingCostUSD: `$${stats.embeddingCostUSD.toFixed(6)}`,
  netSavedUSD: `$${stats.netSavedUSD.toFixed(6)}`,
  byModel: Object.fromEntries(
    Object.entries(stats.byModel).map(([m, s]) => [
      m,
      { hits: s.hits, savedUSD: `$${s.savedUSD.toFixed(6)}` },
    ]),
  ),
});

await cache.dispose();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}
