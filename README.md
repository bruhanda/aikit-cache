# @aikit/cache

[![npm version](https://img.shields.io/npm/v/@aikit/cache.svg)](https://www.npmjs.com/package/@aikit/cache)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@aikit/cache?label=minzip)](https://bundlephobia.com/package/@aikit/cache)
[![license](https://img.shields.io/npm/l/@aikit/cache.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/@aikit/cache.svg)](https://www.typescriptlang.org/)

Zero-dependency, type-safe LLM response cache for Node.js, Bun, Deno, browsers, and edge runtimes (Cloudflare Workers, Vercel Edge).

> **The problem.** LLM API calls are slow and expensive, ~31% of corporate prompts are semantically identical, and the JavaScript ecosystem has no production-grade equivalent of Python's GPTCache. Generic Redis only handles exact-match. Managed gateways lock you in. LangChain caches require LangChain. Vercel AI SDK middleware has no semantic mode and no cost tracking. `@aikit/cache` fills that gap with one library that runs everywhere.

## Features

- **Exact-match cache** by canonical request hash (key-order-independent, whitespace-normalized).
- **Semantic cache** (optional) via pluggable embeddings (OpenAI / Cohere / Voyage / custom) with cosine similarity threshold.
- **Streaming-aware replay** — atomic capture (nothing cached on upstream error) with optional cadence preservation.
- **In-flight single-flight coalescing** — 50 concurrent identical requests collapse to one upstream call. Pluggable distributed lock for multi-pod deployments.
- **Per-model / per-namespace TTL**, sliding TTL with `maxAgeMs` cap, configurable jitter to break thundering herds.
- **Programmatic invalidation** by exact `key`, `prefix`, `tag`, or `predicate`.
- **Dollar-denominated savings tracker** — opt-in `defaultCostTracker` ships pricing for 100+ models; `stats().savedUSD` and per-model breakdown out of the box.
- **Pluggable storage** — in-memory LRU, Redis, Upstash, Cloudflare KV, Vercel KV, SQLite, Postgres + pgvector, plus `multiTierStorage` for L1+L2.
- **Drop-in framework adapters** — OpenAI, Anthropic, Vercel AI SDK, LangChain.js, Hono, Express, Next.js. SDK return types are preserved verbatim through `Proxy` wrappers.
- **Type-safe end to end** — `cache.wrap<T>(req, fn)` infers `T` from `fn`, no `any` widening at the cache boundary, `Result<T, CacheError>` for non-throwing variants.
- **Graceful degradation** — storage failures never block the live LLM call; errors are surfaced via the `'error'` event.
- **Tree-shakeable subpaths** — root is zero-dep (~8 KB minzip). Optional features ship as `@aikit/cache/storage/redis`, `@aikit/cache/cost`, etc.

## Quick Start

```ts
import { createCache } from '@aikit/cache';
import { memoryStorage } from '@aikit/cache/storage';

const cache = createCache({ storage: memoryStorage({ max: 10_000 }) });

const reply = await cache.wrap(
  { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
  () => openai.chat.completions.create({ model: 'gpt-4o', messages }),
);
```

That's it. Identical requests now return from cache; concurrent ones coalesce; storage failures fall through to the live call.

## Installation

```bash
npm install @aikit/cache
```

Storage backends, embedding providers, and SDK adapters use **optional peer dependencies**, so install only what you use:

```bash
# Redis storage
npm install ioredis
# Upstash storage / lock
npm install @upstash/redis
# SQLite storage
npm install better-sqlite3
# Postgres + pgvector
npm install pg
# OpenAI / Anthropic / AI SDK / LangChain adapters
npm install openai @anthropic-ai/sdk ai @langchain/core
```

## API Reference

### `createCache(options)`

Construct an `LLMCache` from a storage adapter and optional features.

```ts
import { createCache } from '@aikit/cache';

const cache = createCache({
  storage: memoryStorage(),
  ttl: { default: 3_600_000, sliding: true, maxAgeMs: 86_400_000 },
  perModelTTL: { 'gpt-4o': 86_400_000 },
  ttlJitter: 0.1,
  namespace: 'prod',
  coalesce: true,
  onError: 'silent',
});
```

Returns a `Cache` (aliased as `LLMCache`) with the methods below.

### `cache.wrap<T>(request, fn, options?)`

Cache the result of `fn()` keyed by the canonical hash of `request`. Returns the cached or freshly-computed value, typed exactly as `fn`.

```ts
const completion = await cache.wrap(
  { model: 'gpt-4o', messages, params: { temperature: 0 } },
  () => openai.chat.completions.create({ model: 'gpt-4o', messages, temperature: 0 }),
  { ttl: 3_600_000, tags: ['user:42'] },
);
```

`WrapOptions`:

- `ttl?: number` — override the resolved TTL (ms).
- `tags?: readonly string[]` — for tag-based invalidation.
- `skipLookup?: boolean` — force-refresh past the cache.
- `skipWrite?: boolean` — read-through but don't store.
- `ignoreFields?: readonly string[]` — fields excluded from the canonical hash. Defaults exclude `['id', 'request_id', 'metadata']`.
- `usage?: TokenUsage` — manual usage record (auto-extracted from OpenAI/Anthropic shapes by default).
- `signal?: AbortSignal`.

### `cache.wrapStream<TChunk>(request, fn, options)`

Cache a streaming response. Returns a `ReadableStream<TChunk>` either way: misses tee the upstream so the consumer reads chunks live while the cache accumulates them in the background; hits replay from the stored array. **Nothing is cached if the upstream errors mid-stream.**

```ts
import { openAIStreamSerializer } from '@aikit/cache/adapters/openai';

const stream = await cache.wrapStream(
  { model: 'gpt-4o', messages },
  () => openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true }),
  { serializer: openAIStreamSerializer, chunkDelayMs: 'preserve' },
);
```

`WrapStreamOptions` extends `WrapOptions` with:

- `serializer: ChunkSerializer<TChunk>` — required. Stable `id` is checked on replay.
- `chunkDelayMs?: 'preserve' | 'instant' | number` — replay cadence.

### `cache.tryWrap` / `cache.tryWrapStream`

Non-throwing mirrors that return `Result<T, CacheError>`. Live errors from `fn()` still propagate — they're provider failures, not cache failures.

```ts
const result = await cache.tryWrap(req, fn);
if (isErr(result)) console.warn('cache layer error:', result.error.code);
else console.log('value:', result.value);
```

### `cache.get` / `cache.set` / `cache.delete`

Low-level read/write. `get` returns `undefined` for misses; `set` stores under the canonical hash; `delete` returns `true` if anything was removed.

```ts
await cache.set(req, value, { ttl: 60_000, tags: ['agent:tool-call'] });
const hit = await cache.get<MyResponse>(req);
await cache.delete(req);
```

### `cache.invalidate(pattern)`

Programmatic invalidation. Storage adapters route to the most efficient backend operation (Redis `SCAN`+`DEL`, KV bulk delete, in-memory iterate).

```ts
await cache.invalidate({ key: 'sha256:...' });
await cache.invalidate({ prefix: 'sha256:abc' });
await cache.invalidate({ tag: 'user:42' });
await cache.invalidate({ predicate: (e) => e.createdAt < cutoff });
```

### `cache.clear()`

Clear the namespace. Returns the count of removed entries.

### `cache.stats()` / `cache.resetStats()`

Snapshot of hits, misses, hit rate, errors, coalesced requests, saved input/output tokens, **savedUSD**, embedding cost, **netSavedUSD**, and a `byModel` breakdown. Frozen — safe to log.

```ts
const s = cache.stats();
console.log(`hit rate ${(s.hitRate * 100).toFixed(1)}%, saved $${s.netSavedUSD.toFixed(2)}`);
```

### `cache.on(event, listener)`

Subscribe to `hit`, `miss`, `set`, `evict`, `error`, `coalesce`. Returns a synchronous unsubscribe.

```ts
const off = cache.on('hit', (e) => log.debug({ key: e.key, from: e.from, sim: e.similarity }));
```

### `cache.flush()` / `cache.dispose()`

`flush()` awaits every pending background write — call it before returning a `Response` from a serverless edge handler. `dispose()` flushes, drains coalescing, releases the storage, and removes listeners.

### Storage adapters — `@aikit/cache/storage`

```ts
import {
  memoryStorage,            // in-process LRU
  multiTierStorage,         // L1 + L2 composition
  LRU,                      // raw LRU primitive
} from '@aikit/cache/storage';

import { redisStorage, redisLock } from '@aikit/cache/storage/redis';
import { upstashStorage, upstashLock } from '@aikit/cache/storage/upstash';
import { cloudflareKVStorage } from '@aikit/cache/storage/cloudflare-kv';
import { vercelKVStorage } from '@aikit/cache/storage/vercel-kv';
import { sqliteStorage } from '@aikit/cache/storage/sqlite';
import { postgresStorage } from '@aikit/cache/storage/postgres';
```

Multi-tier example:

```ts
const storage = multiTierStorage([
  memoryStorage({ max: 1_000 }),
  redisStorage({ client: new IORedis(process.env.REDIS_URL!) }),
]);
```

### Cost tracker — `@aikit/cache/cost`

```ts
import { createCache } from '@aikit/cache';
import {
  defaultCostTracker,   // pricing snapshot for 100+ models
  registerModel,        // add custom pricing
  estimateRequestUSD,
  builtInPricing,
  PRICING_SNAPSHOT_DATE,
} from '@aikit/cache/cost';

registerModel('my-finetune', { inputUSDPer1M: 0.5, outputUSDPer1M: 1.5 });

const cache = createCache({ storage, costTracker: defaultCostTracker });
```

Opt-in keeps the root subpath free of the multi-KB pricing table.

### Semantic layer — `@aikit/cache/semantic`

```ts
import { createCache } from '@aikit/cache';
import { withSemantic } from '@aikit/cache/semantic';
import { openaiEmbeddings } from '@aikit/cache/embeddings/openai';

const cache = createCache({
  storage,
  semantic: withSemantic({
    embeddings: openaiEmbeddings({ apiKey: process.env.OPENAI_API_KEY! }),
    threshold: 0.95,
    topK: 5,
  }),
});
```

On exact-match miss, the canonical text is embedded and matched against the vector index. If the highest-scoring candidate has cosine similarity ≥ `threshold`, its cached value is returned; otherwise `fn()` runs and the result is indexed under both the exact hash and the embedding.

### Embeddings — `@aikit/cache/embeddings`

```ts
import { openaiEmbeddings } from '@aikit/cache/embeddings/openai';
import { cohereEmbeddings } from '@aikit/cache/embeddings/cohere';
import { voyageEmbeddings } from '@aikit/cache/embeddings/voyage';
import { customEmbeddings, withBatching } from '@aikit/cache/embeddings';

const provider = withBatching(
  customEmbeddings({ name: 'local', model: 'bge-small', dimensions: 384, embed }),
  { maxBatch: 32, maxDelayMs: 25 },
);
```

### Errors — `@aikit/cache/errors`

Every thrown error extends `CacheError` with a stable `code` literal union. Discriminate via `instanceof`:

```ts
import {
  CacheError,
  ConfigError,
  StorageError,
  EmbeddingError,
  StreamError,
  InvalidationError,
  CostError,
} from '@aikit/cache/errors';
```

## Framework Guides

### Next.js

```ts
// app/api/chat/route.ts
import { createCache } from '@aikit/cache';
import { upstashStorage } from '@aikit/cache/storage/upstash';
import { withCache } from '@aikit/cache/adapters/next';

const cache = createCache({
  storage: upstashStorage({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! }),
});

export const POST = withCache(
  async (req) => {
    const body = await req.json();
    const reply = await openai.chat.completions.create(body);
    return Response.json(reply);
  },
  { cache, ttl: 3_600_000 },
);
```

`withCache` only caches when the body parses as `{ model, ... }`. Other shapes pass through unchanged.

### Express

```ts
import express from 'express';
import { cacheMiddleware } from '@aikit/cache/adapters/express';

const app = express();
app.use(express.json());
app.post('/v1/chat/completions', cacheMiddleware({ cache, ttl: 3_600_000 }), handler);
```

The middleware intercepts `res.json` / `res.send` to capture the JSON body before it ships to the client. Sets `X-Cache: HIT|MISS`.

### Hono

```ts
import { Hono } from 'hono';
import { cacheMiddleware } from '@aikit/cache/adapters/hono';

const app = new Hono();
app.post('/v1/chat/completions', cacheMiddleware({ cache }), handler);
```

Works on Bun, Node, Cloudflare Workers, and Vercel Edge. On Workers, pass `ctx.waitUntil(cache.flush())` from the outer handler to keep background writes alive across early termination.

### OpenAI SDK

```ts
import OpenAI from 'openai';
import { wrapOpenAI } from '@aikit/cache/adapters/openai';

const openai = wrapOpenAI(new OpenAI(), { cache, ttl: 3_600_000 });

// Same SDK return types — autocompletion and `instanceof OpenAI` keep working:
const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages });
```

Intercepts `chat.completions.create` (stream + non-stream), `embeddings.create`, and `responses.create`.

### Anthropic SDK

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from '@aikit/cache/adapters/anthropic';

const claude = wrapAnthropic(new Anthropic(), { cache });
const msg = await claude.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages });
```

Intercepts `messages.create` (stream + non-stream) and `messages.stream`.

### Vercel AI SDK

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { cacheMiddleware } from '@aikit/cache/adapters/ai-sdk';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: cacheMiddleware({ cache, ttl: 3_600_000 }),
});

const { text } = await generateText({ model, prompt: 'Hello' });
```

Implements both `wrapGenerate` and `wrapStream` of the v3 middleware contract.

### LangChain.js

```ts
import { ChatOpenAI } from '@langchain/openai';
import { LangChainCache } from '@aikit/cache/adapters/langchain';

const llm = new ChatOpenAI({ cache: new LangChainCache({ cache }) });
```

Drop-in replacement for `RedisCache` / `UpstashRedisCache` with no LangChain runtime dependency.

## Configuration Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `storage` | `CacheStorage` | **required** | Pluggable backend. |
| `ttl` | `{ default; sliding?; maxAgeMs? }` | `{ default: 3_600_000 }` | TTL policy. `sliding` re-stamps `exp` on each hit, capped by `maxAgeMs`. |
| `perModelTTL` | `Record<string, number>` | – | Override TTL by `model` string. |
| `perNamespaceTTL` | `Record<string, number>` | – | Override TTL by namespace. |
| `ttlJitter` | `number` ∈ [0, 1] | `0.1` | Multiplicative jitter. `0` to disable. |
| `namespace` | `string` | – | Global key prefix. |
| `keyPolicy` | `(req) => string` | – | Multi-tenant namespace derivation. Empty return throws to refuse silent global-key fallback. |
| `costTracker` | `CostTracker` | – | Opt-in via `defaultCostTracker` from `@aikit/cache/cost`. |
| `coalesce` | `boolean \| { lock?, abortPolicy? }` | `true` | In-flight single-flight. Pass `lock: redisLock(...)` for multi-pod. |
| `semantic` | `SemanticLayer` | – | Embedding-based fallback lookup. |
| `onError` | `'silent' \| 'throw'` | `'silent'` | Cache-layer failure policy. Live `fn()` errors always throw. |
| `clock` | `{ now(): number }` | `Date` | Inject for deterministic tests. |
| `rng` | `() => number` | `Math.random` | TTL jitter RNG. |
| `fetch` | `typeof fetch` | global | Custom fetch. |

## TypeScript Features

- **`wrap<T>` infers `T` from `fn`'s return type** — no `unknown` widening, no manual generic at call sites.
- **`Proxy`-based SDK wrappers preserve the exact input type** — `wrapOpenAI(client)` returns the same type as `client`. SDK return types (`ChatCompletion`, `Stream<ChatCompletionChunk>`, etc.) flow through unchanged.
- **Callbacks typed against the user's installed SDK version** — `skip` and `ttl` callbacks see the SDK's concrete request shape (`Parameters<TClient['chat']['completions']['create']>[0]`).
- **Strict typed events** — `cache.on('hit', e => ...)` infers the payload variant by event name.
- **`Result<T, CacheError>` discriminated union** — `isOk` / `isErr` narrow without `try`/`catch` for cache-layer failures.
- **Stable `code` literal unions on errors** — discriminate at compile time without parsing messages.
- **`exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`** — strict everywhere; missing optional fields are `undefined`, not `T | undefined | absent`.

## Comparison

| Feature | `@aikit/cache` | GPTCache | LangChain `RedisCache` | Vercel AI SDK middleware | Helicone | Portkey | Plain Redis |
|---|---|---|---|---|---|---|---|
| Exact-match cache | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Semantic match | ✓ | ✓ | partial | ✗ | ✓ | enterprise | ✗ |
| Streaming-aware replay | ✓ | ✗ | partial | ✗ | ✓ | ✓ | ✗ |
| Single-flight coalescing | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| Per-model TTL | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | manual |
| $-denominated savings | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| Edge runtimes (CF / Vercel) | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Self-hosted | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Zero npm `dependencies` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a |
| Framework-agnostic | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| TypeScript-native | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Active maintenance | ✓ | ✗ (since 2024-08) | ✓ | ✓ | ✓ | ✓ | ✓ |

**Positioning:**

- **vs GPTCache** — JS/TS-native, actively maintained, zero-dep, first-class cost tracking.
- **vs LangChain `RedisCache`** — no LangChain coupling, semantic match out of the box, single-flight coalescing.
- **vs Vercel AI SDK middleware** — adds semantic match, per-model TTL, cost tracking, multi-tier storage, and works outside the AI SDK.
- **vs Helicone / Portkey** — self-hosted, no recurring SaaS bill, no vendor lock-in, full transparency.
- **vs raw Redis / Upstash** — automatic canonical hashing, per-model strategies, atomic streaming capture, and a savings dashboard for free.
- **vs provider prompt caching (Anthropic / OpenAI)** — cross-provider, durable beyond a session, semantic FAQ matching, observable metrics.

## Contributing

Issues and pull requests welcome — please open an issue first for larger changes so we can align on scope. Local development:

```bash
git clone https://github.com/j09822475-dev/aikit-cache.git
cd aikit-cache
npm install
npm run lint && npm run typecheck && npm test
npm run build
```

The `prepublishOnly` hook runs the full lint → typecheck → test → build → `publint` → `attw` → `size-limit` chain to keep release artifacts sound.

## License

[MIT](./LICENSE) © Vasyl Bruhanda
