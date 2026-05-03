# @aikit/cache — Architecture Plan

> Zero-dep, type-safe LLM response cache for Node.js, Bun, Deno, browsers, and edge runtimes.
> Exact-match + optional semantic cache, in-flight single-flight coalescing, per-model TTL,
> streaming-aware replay, programmatic invalidation, dollar-denominated savings tracking,
> pluggable storage (memory / Redis / Upstash / Cloudflare KV / SQLite) and pluggable
> embedding providers. Drop-in adapters for OpenAI, Anthropic, Vercel AI SDK, LangChain.js,
> Hono, Express, and Next.js Route Handlers.

---

## 0. Design Principles

1. **Zero runtime dependencies.** The core ships with no `dependencies` and runs in Node 18+, Bun, Deno, browsers, Vercel Edge Runtime, and Cloudflare Workers. Storage backends and embedding providers are `peerDependencies` with `optional: true` and only loaded inside subpath adapters.
2. **Type-safety as the headline feature.** `cache.wrap<T>(req, fn)` infers `T` from `fn`'s return type — the cached value, the live value, and the value users get back are all the same `T`, no `unknown` widening at the cache boundary. Storage and embedding adapters are typed end-to-end via generics.
3. **Composition, not inheritance.** No deep class hierarchies; the library is built around plain data structures (`CacheRequest`, `CacheEntry`, `CacheStorage`, `EmbeddingProvider`) and free functions. Builders are syntactic sugar over these structures.
4. **Local-first, edge-first.** Nothing in the core touches `node:fs`, `node:crypto`, or `Buffer`. Web Crypto (`SubtleCrypto.digest`) is the only crypto primitive used (universal across Node 18+, Bun, Deno, browsers, Vercel Edge, Cloudflare Workers). Node-only adapters (`storage/sqlite`) are isolated in their own subpath behind a lazy import.
5. **Tree-shakeable subpaths.** `semantic`, `cost`, `storage/*`, `embeddings/*`, `adapters/*` are independent entry points. A user importing only `createCache` should not pull semantic search, embeddings SDKs, or cost tables into their bundle.
6. **Provider-agnostic core.** The core never imports OpenAI / Anthropic / Vercel AI SDK / LangChain types. Adapters live in dedicated subpaths and use `import type` only.
7. **Deterministic by default.** Cache keys are deterministic functions of the canonicalized request (no clocks, no `Math.random()` in the hashing path). The same `(model, messages, params)` always hashes to the same key across processes, machines, and library versions (with explicit version-bump ceremony when the canonical form changes — see §9.1).
8. **Errors are typed and discriminable.** All thrown errors extend `CacheError` with a `code` literal union. Boundary functions (`get`, `set`, embeddings) that can predictably fail return a `Result<T, E>` instead of throwing — `wrap()` itself never lets a cache failure block the underlying API call (graceful-degradation default).
9. **Bundle discipline.** Hard size budget enforced via `size-limit` in CI, measured **minified + gzip** to match ecosystem norms (size-limit's `preset-small-lib` default). Core ≤ 8 KB min+gz hard cap, 6 KB target. Semantic search lives in opt-in `./semantic` so the 80% exact-match case stays small.
10. **Graceful degradation over hard failure.** If the storage layer is down, `wrap()` logs a one-time warning, executes the underlying function, and returns the live value. A flaky cache must never bring down the LLM call path. Errors are surfaced via the `on('error', …)` hook for observability.

---

## 1. Project Structure

```
aikit-cache/
├── PLAN.md                             # this document
├── README.md                           # written after implementation
├── LICENSE                             # MIT
├── package.json                        # exports map, scripts, peerDeps
├── tsconfig.json                       # strict TS, ESNext, bundler module resolution
├── tsconfig.build.json                 # extends tsconfig, "noEmit": false, excludes tests
├── tsup.config.ts                      # multi-entry ESM build with .d.ts
├── vitest.config.ts                    # node + workers pools, typecheck enabled
├── .gitignore
├── .npmignore                          # excludes tests/, examples/, *.test-d.ts
├── .eslintrc.cjs                       # @typescript-eslint, no-unused-vars, etc.
├── .prettierrc                         # 2-space, single-quote, trailing commas
│
├── src/
│   ├── index.ts                        # public root barrel — re-exports the core API
│   │
│   ├── core/
│   │   ├── cache.ts                    # `createCache()` factory + `LLMCache<T>` interface
│   │   ├── key.ts                      # `hashRequest()` — canonical SHA-256 over (model, messages, params)
│   │   ├── canonical.ts                # canonicalize a request for stable hashing (sort keys, normalize whitespace, drop ignored fields)
│   │   ├── ttl.ts                      # TTL strategy resolution (per-model, per-namespace, sliding window, jitter)
│   │   ├── coalesce.ts                 # in-flight single-flight deduplication map
│   │   ├── invalidate.ts               # invalidation by key / prefix / tag
│   │   ├── stream.ts                   # streaming cache + replay (ReadableStream<TChunk> tee + simulated playback)
│   │   ├── stats.ts                    # `CacheStats` accumulator — hits, misses, saved tokens, saved USD
│   │   ├── envelope.ts                 # versioned wire format `CacheEntry<T>` (`{ v, value, exp, tags?, meta? }`)
│   │   ├── events.ts                   # tiny typed event bus — `'hit' | 'miss' | 'set' | 'evict' | 'error'`
│   │   └── types.ts                    # core types: `CacheRequest`, `CacheEntry`, `CacheOptions`, `WrapOptions`
│   │
│   ├── semantic/
│   │   ├── index.ts                    # public barrel — `withSemantic()`, `SemanticOptions`
│   │   ├── layer.ts                    # `SemanticLayer<T>` — wraps a `LLMCache` with embedding-based lookup
│   │   ├── similarity.ts               # cosine similarity, normalize-to-unit-length, top-k selection
│   │   ├── memory-index.ts             # in-memory linear-scan ANN fallback (for ≤10k vectors)
│   │   ├── store-adapter.ts            # bridges to vector-search-capable `CacheStorage` adapters (Upstash Vector, Redis Search)
│   │   └── types.ts                    # `EmbeddingProvider`, `VectorRecord`, `SemanticHit`, `SemanticOptions`
│   │
│   ├── cost/
│   │   ├── index.ts                    # public barrel — `estimateSavings`, `pricing`, `registerModel`
│   │   ├── pricing.ts                  # frozen per-model price table (Apr 2026 snapshot)
│   │   ├── pricing-registry.ts         # mutable registry for custom / private models
│   │   ├── tracker.ts                  # `CostTracker` — accumulates per-model savings, exports `CostSavings` view
│   │   └── types.ts                    # `ModelPricing`, `CostSavings`, `TokenUsage`
│   │
│   ├── storage/
│   │   ├── index.ts                    # universal barrel — `memoryStorage()`, `multiTierStorage()`
│   │   ├── memory.ts                   # in-memory LRU with byte-size accounting, optional persistence callback
│   │   ├── lru.ts                      # zero-dep doubly-linked-list LRU (~600 B min+gz)
│   │   ├── multi-tier.ts               # `multiTierStorage([l1, l2])` — read-through L1, write-through L2 with backfill
│   │   ├── redis.ts                    # ioredis adapter (Node-only, peer dep)
│   │   ├── upstash.ts                  # @upstash/redis REST adapter (edge-safe, peer dep)
│   │   ├── cloudflare-kv.ts            # Cloudflare Workers KV adapter
│   │   ├── vercel-kv.ts                # Vercel KV adapter (uses @vercel/kv shape, peer dep)
│   │   ├── sqlite.ts                   # better-sqlite3 adapter (Node-only, peer dep, lazy import)
│   │   ├── postgres.ts                 # Postgres + pgvector adapter (Node-only, peer dep `pg` or `postgres`, lazy import)
│   │   └── types.ts                    # `CacheStorage`, `BatchOps`, `VectorCapabilities`, `TransformAtRest`, `DistributedLock`
│   │
│   ├── embeddings/
│   │   ├── index.ts                    # public barrel — `customEmbeddings()` (bring-your-own function), `EmbeddingProvider` type
│   │   ├── openai.ts                   # OpenAI embeddings (peer dep `openai`)
│   │   ├── cohere.ts                   # Cohere embeddings (peer dep `cohere-ai`)
│   │   ├── voyage.ts                   # Voyage AI embeddings (REST, no SDK)
│   │   ├── batched.ts                  # `withBatching(provider, { maxBatchSize, flushMs })` — request coalescing for embeddings
│   │   └── types.ts                    # `EmbeddingProvider`, `EmbeddingResult`, `BatchedEmbeddingOptions`
│   │
│   ├── adapters/
│   │   ├── openai/
│   │   │   ├── index.ts                # `wrapOpenAI(client, { cache })` — proxies `chat.completions.create` and `embeddings.create`
│   │   │   └── types.ts                # local re-typed view of OpenAI shapes (no SDK runtime import)
│   │   ├── anthropic/
│   │   │   ├── index.ts                # `wrapAnthropic(client, { cache })` — proxies `messages.create` (incl. streaming)
│   │   │   └── types.ts
│   │   ├── ai-sdk/
│   │   │   ├── index.ts                # `cacheMiddleware({ cache })` → `LanguageModelV3Middleware` for `wrapLanguageModel`
│   │   │   └── types.ts
│   │   ├── langchain/
│   │   │   ├── index.ts                # `LangChainCache` extends `BaseCache` from `@langchain/core/caches`
│   │   │   └── types.ts
│   │   ├── hono/
│   │   │   └── index.ts                # `cacheMiddleware({ cache })` Hono middleware for /v1/chat/completions-style routes
│   │   ├── express/
│   │   │   └── index.ts                # `cacheMiddleware({ cache })` Express request middleware
│   │   └── next/
│   │       └── index.ts                # `withCache(routeHandler, { cache })` Next.js Route Handler wrapper
│   │
│   ├── errors/
│   │   ├── index.ts                    # public barrel — concrete error classes
│   │   ├── base.ts                     # abstract `CacheError extends Error` + `ErrorCode` literal union
│   │   ├── storage-error.ts            # storage-layer failures (network, parse, capacity)
│   │   ├── embedding-error.ts          # embedding provider failures
│   │   ├── stream-error.ts             # streaming replay corruption / mid-stream upstream failure
│   │   ├── invalidation-error.ts       # invalidation pattern failures
│   │   ├── config-error.ts             # invalid options at `createCache()` time
│   │   └── cost-error.ts               # cost tracker / pricing failures
│   │
│   ├── types/
│   │   ├── result.ts                   # `Result<T, E>` discriminated union helper
│   │   ├── chat.ts                     # provider-neutral `ChatMessage`, `ChatRequest`, `ChatResponse`
│   │   ├── stream.ts                   # `Chunk`, `StreamShape`, `ChunkSerializer<T>`
│   │   └── prettify.ts                 # `Prettify<T>` mapped-type identity for hover ergonomics
│   │
│   └── internal/
│       ├── invariant.ts                # `invariant(cond, msg)` throws `CacheError` code `INVARIANT`
│       ├── clock.ts                    # injectable `Clock` (default `Date.now`) for deterministic TTL tests
│       ├── encoding.ts                 # `toBase64Url(bytes)`, `fromBase64Url(s)`, UTF-8 helpers
│       ├── digest.ts                   # `sha256Hex(input: string | Uint8Array): Promise<string>` over Web Crypto
│       ├── canonical-json.ts           # deterministic JSON serializer (sorted keys, no undefined, escaped)
│       ├── deep-equal.ts               # structural equality for invalidation predicates
│       └── retry.ts                    # tiny exponential backoff with jitter for storage transient failures
│
├── tests/
│   ├── core/
│   │   ├── cache.test.ts
│   │   ├── key.test.ts
│   │   ├── canonical.test.ts
│   │   ├── coalesce.test.ts
│   │   ├── invalidate.test.ts
│   │   ├── stream.test.ts
│   │   ├── stats.test.ts
│   │   ├── ttl.test.ts
│   │   └── envelope.test.ts
│   ├── semantic/
│   │   ├── layer.test.ts
│   │   ├── similarity.test.ts
│   │   └── memory-index.test.ts
│   ├── cost/
│   │   ├── tracker.test.ts
│   │   ├── pricing.test.ts
│   │   └── savings.test.ts
│   ├── storage/
│   │   ├── memory.test.ts
│   │   ├── lru.test.ts
│   │   ├── multi-tier.test.ts
│   │   ├── redis.test.ts               # uses ioredis-mock
│   │   ├── upstash.test.ts             # mocks fetch
│   │   ├── cloudflare-kv.test.ts       # KVNamespace fake
│   │   ├── sqlite.test.ts              # node-only, skipped in edge pool
│   │   └── postgres.test.ts            # node-only, uses pglite for in-memory pgvector
│   ├── embeddings/
│   │   ├── openai.test.ts              # mocks fetch
│   │   ├── cohere.test.ts              # mocks fetch
│   │   ├── voyage.test.ts              # mocks fetch
│   │   ├── batched.test.ts
│   │   └── custom.test.ts
│   ├── adapters/
│   │   ├── openai.test.ts
│   │   ├── anthropic.test.ts
│   │   ├── ai-sdk.test.ts
│   │   ├── langchain.test.ts
│   │   ├── hono.test.ts
│   │   ├── express.test.ts
│   │   └── next.test.ts
│   ├── errors/
│   │   └── errors.test.ts
│   ├── types/                          # `vitest --typecheck` files (assert TS types)
│   │   ├── wrap-infer.test-d.ts
│   │   ├── storage-generic.test-d.ts
│   │   ├── semantic-generic.test-d.ts
│   │   └── adapter-result.test-d.ts
│   ├── e2e/
│   │   ├── exact-then-semantic.test.ts
│   │   ├── coalesce-burst.test.ts
│   │   ├── stream-replay.test.ts
│   │   ├── multi-tier-failover.test.ts
│   │   └── cost-tracking-end-to-end.test.ts
│   ├── edge/                           # workers-pool, edge-safety smoke tests
│   │   ├── core.edge.test.ts
│   │   ├── upstash.edge.test.ts
│   │   └── cloudflare-kv.edge.test.ts
│   └── helpers/
│       ├── fixtures.ts
│       ├── mock-fetch.ts
│       ├── fake-storage.ts             # in-memory CacheStorage with controllable latency / failures
│       └── fake-clock.ts
│
├── examples/
│   ├── 01-basic-exact-match.ts
│   ├── 02-coalesce-burst.ts
│   ├── 03-semantic-cache.ts
│   ├── 04-streaming-cache.ts
│   ├── 05-cost-tracking.ts
│   ├── 06-with-openai.ts
│   ├── 07-with-anthropic.ts
│   ├── 08-with-vercel-ai-sdk.ts
│   ├── 09-with-langchain.ts
│   ├── 10-multi-tier-storage.ts
│   ├── 11-cloudflare-workers.ts        # CF Workers KV
│   ├── 12-vercel-edge-route.ts         # Next.js Route Handler
│   ├── 13-hono-gateway.ts
│   └── 14-invalidation-by-tag.ts
│
└── benchmarks/
    ├── hash.bench.ts                   # canonical + sha256 throughput
    ├── lookup.bench.ts                 # exact-match end-to-end
    ├── coalesce.bench.ts               # burst-of-N concurrent wrap() calls
    ├── stream-replay.bench.ts          # cached stream replay overhead vs network
    └── semantic.bench.ts               # cosine search over 1k / 10k vectors
```

### File-by-file responsibility

| Path | Responsibility |
|---|---|
| `src/index.ts` | Root barrel — re-exports `createCache`, `CacheError` base, `Result`, `isOk`, `isErr`, core types (`CacheRequest`, `CacheEntry`, `CacheOptions`, `WrapOptions`, `Cache`, `LLMCache` alias, `Chunk`). Does NOT re-export semantic/cost/storage/embeddings/adapters (forces tree-shakeable subpath imports). |
| `src/core/cache.ts` | `createCache(options)` factory. Returns the immutable `Cache` interface (aliased as `LLMCache`) implementing `wrap`, `wrapStream`, `tryWrap`, `tryWrapStream`, `get`, `set`, `delete`, `invalidate`, `clear`, `stats`, `resetStats`, `on`, `flush`, `dispose`. Wires the storage, coalescing map (with optional `DistributedLock`), cost tracker, event bus, and TTL resolver. Constructor validation throws `ConfigError`. |
| `src/core/key.ts` | `hashRequest(req, opts?)` — async SHA-256 over the canonical serialization. Returns a base64url-encoded 256-bit digest plus the namespace prefix (`<namespace>:<model>:<digest>`). The function shape is `Promise<string>` because `SubtleCrypto.digest` is async; documented as a non-issue inside the already-async `wrap()` flow. |
| `src/core/canonical.ts` | `canonicalize(req)` — produces a deterministic UTF-8 string for hashing. Sorts object keys recursively, normalizes whitespace inside content where requested, strips `WrapOptions.ignoreFields` (default: `['id', 'request_id', 'metadata']` — the entire `metadata` subtree is dropped, not just nested timestamps), validates `messages` XOR `input`, and drops streaming/non-determinism flags. Pure, sync. |
| `src/core/ttl.ts` | `resolveTTL({ model, namespace, override })` — picks the longest matching rule from `perModelTTL` → `perNamespaceTTL` → `default`. Adds optional ±10% jitter to prevent thundering-herd expiry. |
| `src/core/coalesce.ts` | `Coalescer<K, V>` — single-flight map. `dedupe(key, fn)` returns the in-flight `Promise<V>` if any caller is already computing `key`, otherwise calls `fn()`, stores the promise, and clears it after settle (via `.finally`). Resolution-order safe across rapid call/release/call cycles. |
| `src/core/invalidate.ts` | Pattern matchers for `{ key }`, `{ prefix }`, `{ tag }`, `{ predicate }`, plus `clear()`. Maps each pattern to the storage adapter's most-efficient operation (Redis `SCAN`+`DEL`, KV bulk delete, in-memory iterate). |
| `src/core/stream.ts` | `wrapStream(req, fn)` returns `ReadableStream<TChunk>`. On miss, tees the upstream stream via `ReadableStream.tee()`: one branch flows to the consumer, the other accumulates chunks; on upstream `close`, the accumulated array is serialized and stored. On hit, replays from a serialized array via a simulated `ReadableStream` with optional `chunkDelayMs` to mimic original cadence. Pluggable `ChunkSerializer<TChunk>`. |
| `src/core/stats.ts` | `CacheStats` — atomic counters per total + per model. `snapshot()` returns a frozen view: `{ hits, misses, hitRate, errors, savedTokens, savedUSD, byModel, since, until }`. |
| `src/core/envelope.ts` | Versioned wire format. `CacheEntry<T> = { v: 1; value: T; exp: number; createdAt: number; tags?: string[]; meta?: { serializerId?: string; [k: string]: unknown }; usage?: TokenUsage }`. Streaming entries set `meta.serializerId` (a stable string declared by the `ChunkSerializer`); replay refuses if the configured serializer's id doesn't match (`STREAM_REPLAY_FAILED`) — explicit miss instead of silently feeding garbage to a wrong deserializer. Loaders that see `v !== 1` treat the entry as missing (forward-compat for v0.2 schema bumps). |
| `src/core/events.ts` | `EventBus<E>` — `on(event, listener): () => void` (sync unsubscribe). Events: `'hit' \| 'miss' \| 'set' \| 'evict' \| 'error' \| 'coalesce'`. Errors thrown inside listeners are caught and re-emitted as `'error'` to prevent listener crashes from killing the cache. |
| `src/semantic/layer.ts` | `SemanticLayer<T>` — wraps a base `LLMCache<T>`. On miss, embeds the canonical representation of the request, performs cosine search across the storage's vector index (or in-memory linear scan), returns the highest-similarity hit above `threshold`. Falls through to the underlying `wrap()` on no match. |
| `src/semantic/similarity.ts` | `cosineSimilarity(a, b)` (assumes pre-normalized vectors), `normalize(v)`, `topK(scores, k)`. SIMD-friendly tight loop, ~50 LOC. |
| `src/semantic/memory-index.ts` | `MemoryVectorIndex` — Map<id, Float32Array> with linear-scan search. Acceptable up to ~10k vectors (sub-50ms). For larger collections, use a vector-capable storage adapter (Upstash Vector, Redis Search, pgvector). |
| `src/semantic/store-adapter.ts` | Detects `storage.capabilities.vectorSearch === true` and delegates ANN to the storage adapter. Falls back to `MemoryVectorIndex` otherwise. |
| `src/cost/pricing.ts` | Frozen per-model price table (`gpt-4o`, `gpt-4o-mini`, `gpt-5-2`, `gpt-5-4`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `text-embedding-3-small`, etc.). Tagged with `pricingDate` so estimates carry provenance. |
| `src/cost/pricing-registry.ts` | Mutable registry for custom models (`registerModel`, `unregisterModel`, `listModels`). |
| `src/cost/tracker.ts` | `CostTracker` — on every cache hit, looks up the entry's stored `usage` against the pricing table and accumulates `savedTokens` and `savedUSD`. Provides per-model breakdown. |
| `src/storage/memory.ts` | `memoryStorage({ max, maxBytes?, sizeOf? })` — LRU eviction; default `sizeOf` uses JSON-byte-length heuristic. Sync `get`/`set` exposed under an async `Promise`-returning facade for protocol consistency. |
| `src/storage/lru.ts` | Zero-dep LRU. Doubly-linked list + Map. `get`, `set`, `delete`, `clear`, `keys`, `size`. ~600 B min+gz. |
| `src/storage/multi-tier.ts` | `multiTierStorage([l1, l2])` — read tries L1 then L2; on L2 hit, backfills L1 with the value and L2's TTL. Writes go to all tiers in parallel. Ideal pattern: in-process `memoryStorage` (L1) + Upstash KV (L2). |
| `src/storage/redis.ts` | `redisStorage({ client })` — accepts an `ioredis.Redis`-shaped client (peer dep). `set` uses `SETEX`, `delete` uses `DEL`, `invalidate({ prefix })` uses non-blocking `SCAN`. Tag invalidation uses Redis sets (`tag:<tag>` → set of keys). |
| `src/storage/upstash.ts` | `upstashStorage({ url, token })` or `upstashStorage({ client })` — REST-only, edge-safe. |
| `src/storage/cloudflare-kv.ts` | `cloudflareKVStorage(KVNamespace)` — uses `KV.get`/`put`/`delete`/`list` with TTL passed via `expirationTtl`. |
| `src/storage/vercel-kv.ts` | `vercelKVStorage({ client })` — for `@vercel/kv` shape. |
| `src/storage/sqlite.ts` | `sqliteStorage({ database })` — Node-only. Lazy `await import('better-sqlite3')`. Uses a single table `cache (key TEXT PRIMARY KEY, value BLOB, exp INTEGER, tags TEXT)` and prepared statements. |
| `src/storage/postgres.ts` | `postgresStorage({ client, vectorColumn? })` — Node-only. Accepts a `pg`/`postgres`-shaped client (peer dep). Schema: `cache (key TEXT PK, value BYTEA, exp BIGINT, tags TEXT[])`, optional `embedding vector(N)` column when `vectorColumn` is set. With pgvector enabled, advertises `capabilities.vectorSearch === true` and routes ANN queries to `<-> ` cosine distance — the most popular vector store in the JS RAG stack (Supabase) and the missing entry in the v0.1 storage map. |
| `src/embeddings/openai.ts` | `openaiEmbeddings({ apiKey, model?, fetch?, baseUrl? })`. Default model `text-embedding-3-small`. Auto-batches a single `embed([])` call up to 2048 inputs (OpenAI hard limit). |
| `src/embeddings/cohere.ts` | `cohereEmbeddings({ apiKey, model?, inputType? })`. |
| `src/embeddings/voyage.ts` | `voyageEmbeddings({ apiKey, model? })` — REST, no SDK required. |
| `src/embeddings/batched.ts` | `withBatching(provider, { maxBatchSize, flushMs })` — coalesces concurrent `embed([…])` calls into one batched request, returns per-input promises. |
| `src/adapters/openai/index.ts` | `wrapOpenAI(client, { cache, namespace? })` — returns a `Proxy<OpenAI>` that intercepts `chat.completions.create` (including `stream: true`) and `embeddings.create`. Cache key includes the full request; `usage` is recorded on every uncached call for downstream savings math. |
| `src/adapters/anthropic/index.ts` | `wrapAnthropic(client, { cache })` — Proxy wrapping `messages.create` and `messages.stream`. |
| `src/adapters/ai-sdk/index.ts` | `cacheMiddleware({ cache, namespace? })` returns a `LanguageModelV3Middleware` consumed by `wrapLanguageModel(model, { middleware })`. Hooks `wrapGenerate` (exact-match cache) and `wrapStream` (cached replay via `simulateReadableStream`). |
| `src/adapters/langchain/index.ts` | `LangChainCache` extends `BaseCache` from `@langchain/core/caches`. Implements `lookup(prompt, llmKey)` and `update(prompt, llmKey, value)`. |
| `src/adapters/hono/index.ts` | `cacheMiddleware({ cache })` Hono middleware that intercepts `/v1/chat/completions`-style POST routes proxied to a backend. |
| `src/adapters/express/index.ts` | Express equivalent. |
| `src/adapters/next/index.ts` | `withCache(handler, { cache })` wraps a Route Handler `(req: Request) => Response`. |
| `src/errors/base.ts` | `abstract class CacheError extends Error { abstract readonly code: ErrorCode; ... }`. `ErrorCode` is a literal union of all error codes. |
| `src/errors/*-error.ts` | Concrete subclasses. Each carries structured context (e.g. `StorageError.operation: 'get' \| 'set' \| 'delete'`). |
| `src/types/chat.ts` | Provider-neutral `ChatMessage`, `ChatRequest`, `ChatResponse` shapes used by adapters. Importing the root barrel does not pull these unless used. |
| `src/types/stream.ts` | `Chunk<T>` discriminated union (`'text-delta' \| 'tool-call' \| 'finish' \| 'error'`), `ChunkSerializer<T>`. |
| `src/internal/digest.ts` | `sha256Hex(input)` and `sha256Bytes(input)` over `globalThis.crypto.subtle.digest('SHA-256', …)`. Falls back with a clear `ConfigError(WEB_CRYPTO_UNAVAILABLE)` if `globalThis.crypto?.subtle` is absent (impossible on supported runtimes, kept as a defensive guard). |
| `src/internal/canonical-json.ts` | `canonicalJSON(value)` — recursive serializer with sorted object keys, `undefined` removed, `NaN`/`Infinity` rejected with `INVARIANT`, no trailing whitespace. ~80 LOC, no deps. |
| `src/internal/clock.ts` | `Clock` interface (`now(): number`). Default uses `Date.now`. Tests inject a `FakeClock` to advance time deterministically. |
| `src/internal/retry.ts` | `retry(fn, { attempts, baseMs })` — exponential backoff with full jitter, used by storage adapters' transient-error handling. |

---

## 2. Public API Design

> All snippets below are **runnable user code**. They illustrate the final public surface. JSDoc comments are reproduced verbatim from the planned source so the reader can audit the contract.

### 2.1 The `createCache()` factory

> **Secure-defaults checklist** (see §9.12 for the full list).
>
> - **`namespace` (or `keyPolicy`) is required when storage is shared.** Multi-tenant SaaS sharing a Redis between tenants and forgetting `namespace` is a data-leak vector. The recommended pattern is `keyPolicy: (req) => `tenant:${req.metadata.tenantId}`` so the segregation lives in one place and cannot be forgotten on a single call site.
> - **`transformAtRest` for sensitive data.** Cached LLM responses can contain PII; enable the `transformAtRest` hook (see §2.2) for AES-GCM-with-KMS when the storage is shared with non-LLM systems or audited under SOC 2 / HIPAA.
> - **`onError: 'silent'` is the default**, by design — a flaky cache must not bring down the LLM call path. Wire `cache.on('error', …)` to your metrics so silent fall-throughs are still visible.

```ts
import { createCache } from '@aikit/cache';
import { memoryStorage } from '@aikit/cache/storage';

const cache = createCache({
  storage: memoryStorage({ max: 10_000, maxBytes: 50 * 1024 * 1024 }),
  ttl: { default: 3_600_000 },                 // 1 hour
  perModelTTL: {                               // override per model
    'gpt-4o': 86_400_000,                      //   24 hours
    'claude-opus-4-6': 3_600_000,
  },
  perNamespaceTTL: {
    'embeddings': 30 * 86_400_000,             //   30 days for embeddings
  },
  costTracking: true,                          // enable saved-USD math (default true)
  coalesce: true,                              // single-flight dedup (default true)
  namespace: 'support-bot',                    // optional prefix mixed into every key
  onError: 'silent',                           // 'silent' (default) | 'throw'
});
```

```ts
/**
 * Create an LLM response cache with pluggable storage, semantic layer, cost
 * tracking, in-flight coalescing, and per-model TTL. The returned `LLMCache`
 * is fully type-safe — `wrap<T>(req, fn)` infers `T` from `fn`, no
 * `Record<string, unknown>` widening at the cache boundary.
 *
 * The cache **never blocks the underlying LLM call** on a storage failure.
 * If `get` / `set` throws, the live `fn()` result is returned and the error
 * is surfaced via the `'error'` event (or thrown if `onError: 'throw'`).
 *
 * @example
 * const cache = createCache({ storage: memoryStorage({ max: 10_000 }) });
 *
 * const reply = await cache.wrap({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hi' }],
 *   params: { temperature: 0 },
 * }, () => openai.chat.completions.create({ ... }));
 */
export function createCache(options: CacheOptions): Cache;

export interface CacheOptions {
  /** Storage backend. Required. Use `memoryStorage()` for a quick start. */
  readonly storage: CacheStorage;

  /** TTL policy. `default` is required; per-model / per-namespace are optional overrides. */
  readonly ttl?: TTLPolicy;

  /** Per-model TTL overrides (ms). Highest specificity wins. */
  readonly perModelTTL?: Readonly<Record<string, number>>;

  /** Per-namespace TTL overrides (ms). */
  readonly perNamespaceTTL?: Readonly<Record<string, number>>;

  /** Default ±10% jitter on TTL to prevent thundering-herd expiry. Set `0` to disable. */
  readonly ttlJitter?: number;

  /**
   * Namespace mixed into every cache key. Required in any deployment
   * where the storage backend is shared across tenants, features, or
   * environments (`prod`/`staging`); strongly recommended otherwise.
   *
   * Forgetting `namespace` on a Redis shared between two tenants is a
   * classic data-leak path. For multi-tenant SaaS prefer `keyPolicy`,
   * which lets you derive the namespace from the request itself (e.g. a
   * tenant id pulled from `request.metadata.tenantId`) so it cannot be
   * forgotten on a single call site.
   */
  readonly namespace?: string;

  /**
   * Programmatic namespace derivation per request. Wins over `namespace`
   * and `CacheRequest.namespace`. Use this in multi-tenant deployments
   * to enforce that every key is bucketed by tenant — the cache will
   * throw `CONFIG_INVALID_NAMESPACE` if `keyPolicy` returns an empty
   * string, so a missing tenant id fails loudly instead of silently
   * mixing data across tenants.
   *
   * @example
   * keyPolicy: (req) => {
   *   const tenant = req.metadata?.tenantId;
   *   if (typeof tenant !== 'string') throw new Error('tenantId required');
   *   return `tenant:${tenant}`;
   * }
   */
  readonly keyPolicy?: (request: CacheRequest) => string;

  /** Track saved tokens / dollars per model. Default `true`. */
  readonly costTracking?: boolean;

  /**
   * Single-flight in-flight request deduplication. When 50 callers ask for
   * the same key concurrently, only the first calls `fn()`; the other 49
   * await its result. Default `true`.
   *
   * Pass an object to configure:
   *   - `lock` — pluggable distributed lock to share single-flight ACROSS
   *     processes (50-pod deployments otherwise fan a burst into 50
   *     concurrent `fn()` calls; the in-process map only dedupes within
   *     one Node/Worker instance). Default: an in-process no-op lock.
   *     Ship-with-the-lib implementations: `redisLock(client)` from
   *     `./storage/redis`, `upstashLock({ url, token })` from
   *     `./storage/upstash`. The interface is ~10 LOC so users can BYO.
   *   - `abortPolicy` — see `WrapOptions.signal`. Default `'leader-only'`.
   */
  readonly coalesce?: boolean | {
    readonly lock?: DistributedLock;
    readonly abortPolicy?: 'leader-only' | 'shared';
  };

  /**
   * Optional semantic layer. See `@aikit/cache/semantic`.
   *
   * @example
   * import { withSemantic } from '@aikit/cache/semantic';
   * import { openaiEmbeddings } from '@aikit/cache/embeddings/openai';
   *
   * createCache({
   *   storage: ...,
   *   semantic: withSemantic({
   *     embeddings: openaiEmbeddings({ apiKey: env.OPENAI_API_KEY }),
   *     threshold: 0.94,
   *   }),
   * });
   */
  readonly semantic?: SemanticLayer;

  /**
   * Behavior on cache-layer errors (storage timeout, embedding failure, …).
   *   - `'silent'` (default): execute `fn()` and return live result. Error emitted via `on('error', …)`.
   *   - `'throw'`: rethrow as `CacheError`.
   *
   * Live LLM API errors thrown by `fn()` are **always** propagated.
   */
  readonly onError?: 'silent' | 'throw';

  /** Inject a clock for deterministic testing. Default `Date.now`. */
  readonly clock?: Clock;

  /** Inject a fetch implementation for storage / embedding adapters that need it. */
  readonly fetch?: typeof fetch;
}

export interface TTLPolicy {
  /** Default TTL in ms. Required. */
  readonly default: number;
  /** Optional sliding window: refresh `exp` on every hit. Default `false`. */
  readonly sliding?: boolean;
  /** Maximum age beyond which a sliding entry will not be refreshed (ms). */
  readonly maxAgeMs?: number;
}

/**
 * Pluggable distributed mutex used to share single-flight coalescing across
 * processes. The contract is intentionally narrow — `acquire()` should
 * resolve when the lock is held (or rejected on timeout); the returned
 * `release()` must be safe to call multiple times.
 *
 * Implementations ship under `./storage/redis` (`redisLock(client)`) and
 * `./storage/upstash` (`upstashLock({ url, token })`). The default lock
 * inside `createCache` is an in-process no-op — single-flight still works
 * within one runtime, but multi-pod deployments fall back to per-pod
 * coalescing unless a real lock is supplied.
 */
export interface DistributedLock {
  /**
   * Acquire the lock for `key`. Implementations should set a TTL on the
   * underlying lock entry equal to a reasonable upper bound on `fn()`'s
   * duration (e.g. 30 s) so a crashed leader doesn't deadlock the cluster.
   */
  acquire(key: string, opts?: { readonly waitMs?: number; readonly ttlMs?: number }): Promise<{
    readonly held: boolean;
    readonly release: () => Promise<void>;
  }>;
}
```

The returned `LLMCache`:

```ts
/**
 * The runtime cache object. Construct via `createCache(...)`.
 *
 * `wrap<T>` is the headline method. `wrapStream<T>` adds streaming. The
 * primitive `get`/`set`/`delete` are exposed for advanced uses (custom
 * adapters, manual cache warming).
 *
 * **Naming.** The interface is exported as both `Cache` (canonical) and
 * `LLMCache` (alias, for npm SEO and to communicate intent at the call
 * site). Use whichever reads better — half the use cases (tool-call dedup,
 * embedding cache, RAG retrieval cache) are not strictly "LLM" responses,
 * so `Cache` ages better; `LLMCache` is the discoverable name.
 */
export interface Cache {
  /**
   * Cache the result of `fn()` keyed by the canonical hash of `request`.
   *
   * Behavior:
   *   1. Compute the cache key (`hashRequest(request)`).
   *   2. If a non-expired entry exists, return its `value` (cache hit).
   *   3. Else, if a coalescing entry is in-flight for the same key, await it.
   *   4. Else, call `fn()`, store the result with the resolved TTL, return it.
   *
   * Storage failures fall through silently (default) — the live `fn()` result
   * is always returned. Live API errors thrown by `fn()` are propagated.
   *
   * Generic in `T` so the cached value is typed end-to-end. No `unknown`
   * widening: the value `wrap` returns has the exact type of `fn`'s resolution.
   *
   * @example
   * const reply = await cache.wrap({
   *   model: 'gpt-4o',
   *   messages: [{ role: 'user', content: 'Hello' }],
   * }, () => openai.chat.completions.create({ ... }));
   * //  ^? ChatCompletion — typed exactly as fn returns
   */
  wrap<T>(request: CacheRequest, fn: () => Promise<T>, options?: WrapOptions): Promise<T>;

  /**
   * Cache a streaming response. Returns a `ReadableStream<TChunk>` either
   * way:
   *   - Cache miss: tees the upstream stream so the consumer reads chunks
   *     in real-time while the cache accumulates them in the background. On
   *     stream `close`, the accumulated array is serialized and stored.
   *   - Cache hit: replays the stored chunks through a simulated readable
   *     stream, with optional `chunkDelayMs` to approximate the original
   *     network cadence.
   *
   * If `fn()` throws or the upstream errors mid-stream, **nothing is cached**
   * — partial outputs are not persisted.
   *
   * @example
   * const stream = await cache.wrapStream({ model: 'gpt-4o', messages },
   *   () => openai.chat.completions.create({ ..., stream: true }),
   *   { serializer: openAIStreamSerializer, chunkDelayMs: 'preserve' },
   * );
   * for await (const chunk of stream) { ... }
   */
  wrapStream<TChunk>(
    request: CacheRequest,
    fn: () => Promise<ReadableStream<TChunk>> | ReadableStream<TChunk>,
    options: WrapStreamOptions<TChunk>,
  ): Promise<ReadableStream<TChunk>>;

  /**
   * Non-throwing mirror of `wrap()`. Returns a `Result<T, CacheError>`
   * instead of letting cache-layer errors throw, regardless of the
   * `onError` setting. Live errors thrown by `fn()` are still propagated
   * (they are wrapped into `Result.err` so callers don't have to mix
   * try/catch with discriminated-union handling).
   *
   * Useful when `onError: 'throw'` is enabled globally but a specific call
   * site wants graceful handling.
   */
  tryWrap<T>(request: CacheRequest, fn: () => Promise<T>, options?: WrapOptions): Promise<Result<T, CacheError>>;

  /** Non-throwing mirror of `wrapStream()`. */
  tryWrapStream<TChunk>(
    request: CacheRequest,
    fn: () => Promise<ReadableStream<TChunk>> | ReadableStream<TChunk>,
    options: WrapStreamOptions<TChunk>,
  ): Promise<Result<ReadableStream<TChunk>, CacheError>>;

  /**
   * Low-level get. Returns the cached value if a non-expired entry exists,
   * else `undefined`. Does NOT trigger coalescing (use `wrap` for that).
   */
  get<T = unknown>(request: CacheRequest): Promise<T | undefined>;

  /**
   * Low-level set. Stores `value` keyed by the canonical hash of `request`.
   * Optional `tags` enable later invalidation by tag.
   */
  set<T>(request: CacheRequest, value: T, options?: SetOptions): Promise<void>;

  /** Delete a single cached entry by request. Returns `true` if anything was removed. */
  delete(request: CacheRequest): Promise<boolean>;

  /**
   * Programmatic invalidation.
   *
   *   - `{ key }`         — delete a single key (already-hashed).
   *   - `{ prefix }`      — delete every key with the given prefix (e.g. `'gpt-4o:'`).
   *   - `{ tag }`         — delete every entry tagged with `tag`.
   *   - `{ predicate }`   — delete every entry for which `predicate(entry)` returns `true`.
   *
   * Returns the count of removed entries. Storage adapters use the most
   * efficient operation available (Redis SCAN+DEL, KV bulk delete, in-memory iterate).
   */
  invalidate(pattern: InvalidationPattern): Promise<number>;

  /** Clear the entire namespace. Use with care. Returns the count of removed entries. */
  clear(): Promise<number>;

  /** Snapshot of the cache statistics. Frozen, safe to log / serialize. */
  stats(): CacheStatsSnapshot;

  /** Reset stats counters to zero. Does not affect stored entries. */
  resetStats(): void;

  /** Subscribe to cache events. Returns a synchronous unsubscribe function. */
  on<E extends CacheEventName>(event: E, listener: CacheEventListener<E>): () => void;

  /**
   * Await every pending background write (e.g. streaming-capture writes
   * that the cache fires-and-forgets, Cloudflare KV writes scheduled via
   * `ctx.waitUntil()`). Edge handlers should call this before returning a
   * `Response` if they need writes to be durable across early termination.
   *
   * Cheap to call and idempotent — resolves immediately if there's
   * nothing in flight.
   */
  flush(): Promise<void>;

  /**
   * Async cleanup — `flush()`es pending writes, drains in-flight coalescing
   * entries, awaits storage `dispose()`, removes event listeners. After
   * `dispose()`, the cache throws `ConfigError(CACHE_DISPOSED)` on every
   * method.
   */
  dispose(): Promise<void>;
}

/**
 * Alias of {@link Cache}. Re-exported under both names so existing
 * `LLMCache`-typed call sites keep working and so the npm package surfaces
 * the discoverable LLM-flavored name. New code should prefer `Cache` —
 * tool-call dedup / embedding cache / RAG retrieval cache are not strictly
 * "LLM" responses but live on the same primitive.
 */
export type LLMCache = Cache;
```

The request shape:

```ts
/**
 * A provider-neutral description of an LLM request. The library hashes a
 * canonical form of this object — sorted keys, normalized whitespace,
 * `WrapOptions.ignoreFields` removed — so two semantically identical
 * requests with different key orders or non-deterministic metadata produce
 * the same cache key.
 *
 * Exactly one of `messages` (chat-shaped requests) OR `input` (everything
 * else: embeddings, audio, image gen, agent tool-call payloads, OpenAI
 * `responses.create`, …) must be supplied. The canonicalizer hashes
 * whichever is provided, so adapters never need to smuggle non-message
 * data through `params` (which would defeat invalidation by-prefix and
 * by-tag patterns).
 *
 * Fields beyond `model` / `messages` / `input` / `params` are optional —
 * the canonical form always includes them when present, so passing
 * `{ model, messages, params: { temperature: 0 } }` and
 * `{ model, messages, params: { temperature: 0, top_p: 1 } }` produce
 * DIFFERENT keys (a deliberate choice — different params can produce
 * different completions).
 */
export interface CacheRequest {
  readonly model: string;
  /** Chat-shaped requests. Mutually exclusive with `input`. */
  readonly messages?: readonly ChatMessage[];
  /**
   * Non-chat payloads — embeddings inputs, audio buffers (base64), image
   * prompts, agent tool-call args, anything that isn't a chat conversation.
   * Hashed via the same canonicalizer as `messages`. Mutually exclusive
   * with `messages` (passing both throws `CACHE_INVALID_OPTIONS`).
   */
  readonly input?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Optional namespace that overrides `CacheOptions.namespace` for this call. */
  readonly namespace?: string;
  /** Optional tools / functions; included in the hash. */
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  /**
   * Free-form metadata. Excluded from the hash by default — the entire
   * `metadata` subtree is in `WrapOptions.ignoreFields`'s default. Useful
   * for cost tracking, request IDs, trace spans, anything that should ride
   * along with the entry without affecting the cache key.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WrapOptions {
  /** Override TTL for this call (ms). */
  readonly ttl?: number;
  /** Tags attached to the cache entry; usable later via `invalidate({ tag })`. */
  readonly tags?: readonly string[];
  /** Skip the cache lookup (always call `fn`); still stores the result. */
  readonly skipLookup?: boolean;
  /** Skip the cache write (lookup-only). */
  readonly skipWrite?: boolean;
  /** Override which request fields to ignore when computing the hash. */
  readonly ignoreFields?: readonly string[];
  /** Override the cost-tracking `usage` recorded for this call. */
  readonly usage?: TokenUsage;
  /**
   * Optional `AbortSignal` forwarded into `fn()` and observed by the cache.
   *
   * Semantics with single-flight coalescing on (the default):
   *
   *   - **Leader aborts** (the caller whose `fn()` is actually running):
   *     by default (`coalesce.abortPolicy: 'leader-only'`), the leader's
   *     promise rejects with `AbortError`, every waiter ALSO rejects (they
   *     have no upstream call to fall back to). The next caller after
   *     rejection performs a fresh call. Set `coalesce.abortPolicy: 'shared'`
   *     to instead promote the first remaining waiter to leader and let it
   *     issue a fresh `fn()` call (best-effort; the original signal is
   *     dropped).
   *   - **Waiter aborts** (a non-leader caller): the waiter's promise
   *     rejects with `AbortError`. The leader's `fn()` continues; other
   *     waiters are unaffected.
   *
   * Documented in §9.3.
   */
  readonly signal?: AbortSignal;
}

export interface SetOptions {
  readonly ttl?: number;
  readonly tags?: readonly string[];
  readonly usage?: TokenUsage;
}

export interface WrapStreamOptions<TChunk> extends WrapOptions {
  /** Required: how to serialize / deserialize the chunks. */
  readonly serializer: ChunkSerializer<TChunk>;
  /**
   *   - `'preserve'` — replay chunks at the same inter-chunk delays as captured (recorded during the live miss).
   *   - `'instant'`  — flush all chunks as fast as the consumer reads.
   *   - `number`     — uniform delay (ms) between every chunk.
   * Default `'instant'`.
   */
  readonly chunkDelayMs?: 'preserve' | 'instant' | number;
}

export interface ChunkSerializer<TChunk> {
  /**
   * Stable, unique identifier for this serializer's wire format
   * (e.g. `'openai-stream-v1'`, `'anthropic-stream-v1'`,
   * `'ai-sdk-stream-v1'`). Stamped onto every cached streaming envelope's
   * `meta.serializerId`; on replay, the cache refuses to deserialize an
   * entry whose stored id does not match the configured serializer's id
   * (returns `STREAM_REPLAY_FAILED`). Without this, two serializers that
   * happen to consume the same wire shape (both JSON arrays, say) would
   * silently feed garbage into the wrong deserializer.
   */
  readonly id: string;
  serialize(chunks: readonly TChunk[]): string | Uint8Array;
  deserialize(data: string | Uint8Array): readonly TChunk[];
}

export type InvalidationPattern =
  | { readonly key: string }
  | { readonly prefix: string }
  | { readonly tag: string }
  | { readonly predicate: (entry: CacheEntryView) => boolean };

export interface CacheEntryView {
  readonly key: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly exp: number;
  readonly meta: Readonly<Record<string, unknown>>;
}

export type CacheEventName = 'hit' | 'miss' | 'set' | 'evict' | 'error' | 'coalesce';

export type CacheEventListener<E extends CacheEventName> =
  E extends 'hit'      ? (e: { key: string; from: 'exact' | 'semantic'; similarity?: number; entry: CacheEntryView }) => void :
  E extends 'miss'     ? (e: { key: string; reason: 'not-found' | 'expired' }) => void :
  E extends 'set'      ? (e: { key: string; ttl: number; bytes?: number }) => void :
  E extends 'evict'    ? (e: { key: string; reason: 'capacity' | 'ttl' | 'manual' }) => void :
  E extends 'error'    ? (e: { error: CacheError; operation: string }) => void :
  E extends 'coalesce' ? (e: { key: string; waiters: number }) => void :
  never;
```

> **DX note.** `wrap<T>` does not expose `T` as an explicit generic in autocomplete — TypeScript infers it from `fn`'s return type. Users never write `cache.wrap<ChatCompletion>(…)` unless they want to widen / narrow on purpose.

### 2.2 Storage adapters — `@aikit/cache/storage*`

```ts
import { createCache } from '@aikit/cache';
import { memoryStorage, multiTierStorage } from '@aikit/cache/storage';
import { upstashStorage } from '@aikit/cache/storage/upstash';

// Single-tier in-memory (recommended for serverless instances)
const cacheA = createCache({ storage: memoryStorage({ max: 10_000 }) });

// Multi-tier: in-process L1 + Upstash L2
const l1 = memoryStorage({ max: 1_000 });
const l2 = upstashStorage({ url: env.UPSTASH_URL, token: env.UPSTASH_TOKEN });
const cacheB = createCache({
  storage: multiTierStorage([l1, l2]),
  ttl: { default: 3_600_000 },
});
```

The `CacheStorage` contract:

```ts
/**
 * Bring-your-own storage. Implement these six async methods and you have a
 * fully-featured backend. The library never assumes synchronous semantics.
 *
 * Implementations should:
 *   - return `undefined` for missing keys (never throw).
 *   - throw a `StorageError` (or any `Error` — wrapped automatically) for
 *     transient failures; the cache layer applies graceful degradation.
 *   - honor the TTL passed to `set()` precisely (best-effort; KV stores with
 *     coarse TTL granularity should round up, not down).
 */
export interface CacheStorage {
  readonly name: string;

  /** Optional capability flags negotiated by features that need them. */
  readonly capabilities?: StorageCapabilities;

  get(key: string): Promise<CacheEntry<unknown> | undefined>;
  set(key: string, entry: CacheEntry<unknown>, ttlMs: number): Promise<void>;
  delete(key: string): Promise<boolean>;

  /** Optional: bulk operations. Falls back to N x single ops if absent. */
  mget?(keys: readonly string[]): Promise<ReadonlyArray<CacheEntry<unknown> | undefined>>;
  mset?(entries: ReadonlyArray<{ key: string; entry: CacheEntry<unknown>; ttlMs: number }>): Promise<void>;
  mdelete?(keys: readonly string[]): Promise<number>;

  /** Required: the most efficient pattern-delete the backend supports. */
  invalidate(pattern: InvalidationPattern): Promise<number>;

  /** Required: drop everything in this storage's namespace. */
  clear(): Promise<number>;

  /** Optional: vector search for semantic layer. Required if `capabilities.vectorSearch === true`. */
  vectorSearch?(query: Float32Array, topK: number, namespace?: string): Promise<readonly VectorSearchHit[]>;
  vectorUpsert?(records: readonly VectorRecord[]): Promise<void>;
  vectorDelete?(ids: readonly string[]): Promise<number>;

  /** Optional: async teardown. */
  dispose?(): Promise<void>;
}

export interface StorageCapabilities {
  /** Backend supports atomic SCAN+DEL by prefix. */
  readonly prefixScan?: boolean;
  /** Backend supports tag-based invalidation efficiently (e.g. Redis sets). */
  readonly tagIndex?: boolean;
  /** Backend supports vector search (Upstash Vector, Redis Search, pgvector). */
  readonly vectorSearch?: boolean;
  /** Maximum value size in bytes (the cache will skip oversized writes with a warning). */
  readonly maxValueBytes?: number;
}

export interface VectorRecord {
  readonly id: string;
  readonly vector: Float32Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface VectorSearchHit {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

Built-in storages:

```ts
// @aikit/cache/storage  (universal barrel)
export function memoryStorage(options?: MemoryStorageOptions): CacheStorage;
export function multiTierStorage(tiers: readonly [CacheStorage, ...CacheStorage[]]): CacheStorage;

export interface MemoryStorageOptions {
  /** Maximum number of entries; LRU evicts oldest. Default 1000. */
  readonly max?: number;
  /** Maximum total bytes (sums via `sizeOf`); LRU evicts oldest. Default unlimited. */
  readonly maxBytes?: number;
  /** Custom byte-size estimator. Default: JSON length of the entry. */
  readonly sizeOf?: (entry: CacheEntry<unknown>) => number;
  /** Optional callback fired on eviction (before the entry is dropped). */
  readonly onEvict?: (key: string, reason: 'capacity' | 'ttl') => void;
}

// @aikit/cache/storage/redis
export function redisStorage(options: {
  readonly client: RedisLikeClient;
  readonly keyPrefix?: string;
  readonly transformAtRest?: TransformAtRest;
}): CacheStorage;
/** Redis-backed `DistributedLock` using `SET key val NX PX ttl` + Lua release. */
export function redisLock(client: RedisLikeClient, opts?: { readonly keyPrefix?: string }): DistributedLock;

// @aikit/cache/storage/upstash
export function upstashStorage(options:
  | { readonly url: string; readonly token: string; readonly fetch?: typeof fetch; readonly keyPrefix?: string; readonly transformAtRest?: TransformAtRest }
  | { readonly client: UpstashClient; readonly keyPrefix?: string; readonly transformAtRest?: TransformAtRest }
): CacheStorage;
/** Upstash REST `DistributedLock` (edge-safe). */
export function upstashLock(options: { readonly url: string; readonly token: string; readonly keyPrefix?: string }): DistributedLock;

// @aikit/cache/storage/cloudflare-kv
export function cloudflareKVStorage(
  kv: KVNamespace,
  options?: {
    readonly keyPrefix?: string;
    /**
     * Cloudflare `ExecutionContext` from the request handler. When present,
     * KV `put()` writes are wrapped in `ctx.waitUntil(...)` so the Worker
     * doesn't terminate before the write resolves. Without this, a write
     * issued during a request handler that returns immediately can be
     * killed by the runtime, and the next caller will silent-miss.
     *
     * In Workers code:
     *
     * ```ts
     * export default {
     *   fetch(req, env, ctx) {
     *     const cache = createCache({
     *       storage: cloudflareKVStorage(env.KV, { ctx }),
     *     });
     *     // ... handler logic, then return Response (writes are durable
     *     // because ctx.waitUntil keeps the Worker alive long enough)
     *   }
     * };
     * ```
     *
     * If you can't (or don't want to) thread `ctx` through, call
     * `await cache.flush()` before returning the `Response` — `flush()`
     * awaits every pending background write directly. See `LLMCache.flush`.
     */
    readonly ctx?: ExecutionContext;
    readonly transformAtRest?: TransformAtRest;
  },
): CacheStorage;

// @aikit/cache/storage/vercel-kv
export function vercelKVStorage(options: {
  readonly client: VercelKVClient;
  readonly keyPrefix?: string;
  readonly transformAtRest?: TransformAtRest;
}): CacheStorage;

// @aikit/cache/storage/sqlite
export function sqliteStorage(options: {
  readonly database: SqliteDatabase;
  readonly tableName?: string;
  readonly transformAtRest?: TransformAtRest;
}): CacheStorage;

// @aikit/cache/storage/postgres
/**
 * Postgres + pgvector storage adapter. Stores entries in a `cache` table
 * (TEXT key, BYTEA value, BIGINT exp, TEXT[] tags) with prepared
 * statements; if the `vector` extension is enabled and `vectorColumn` is
 * set, advertises `capabilities.vectorSearch === true` so the semantic
 * layer routes ANN queries to `<-> ` cosine distance instead of falling
 * back to in-process `MemoryVectorIndex`.
 *
 * Edge runtimes: not supported (uses `pg`/`postgres` driver, Node-only).
 */
export function postgresStorage(options: {
  readonly client: PostgresLikeClient;
  readonly tableName?: string;
  readonly vectorColumn?: { readonly name: string; readonly dimensions: number };
  readonly transformAtRest?: TransformAtRest;
}): CacheStorage;
```

#### Encryption / transform at rest

Every shipped storage adapter accepts an optional `transformAtRest` hook:

```ts
/**
 * Optional encode/decode pair applied immediately before `set()` and
 * immediately after `get()`. Used to AES-GCM-encrypt cache values with
 * a KMS key, gzip-compress large payloads, or apply any other byte-level
 * transformation without forking the storage adapter.
 *
 * Round-trip is `decode(encode(entryBytes)) === entryBytes`. The cache
 * layer never inspects the bytes; it only round-trips them through this
 * pair when persisting / loading.
 *
 * Cached LLM responses can contain PII. Audit teams will ask
 * "is the value encrypted at rest?" and `transformAtRest` is the answer.
 */
export interface TransformAtRest {
  encode(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decode(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
```

The hook is per-adapter rather than core-wide so adapters that have a native at-rest encryption story (e.g. enterprise Redis with TLS + disk encryption) don't pay any byte-shuffling cost; consumers opt in only on the storages they care about.

### 2.3 Semantic cache — `@aikit/cache/semantic`

> **Honesty about the trade-off.** Embedding every miss costs tokens and
> latency (≈ $0.02 per 1M input tokens for `text-embedding-3-small`,
> ≈ 30–80 ms p50 round-trip). It pays off when your **semantic hit rate**
> exceeds the embedding overhead — typically true for FAQ-style chatbots,
> RAG retrievals, and customer-support copilots, and rarely true for
> long unique prompts. Measure first; the library exposes `stats().savedUSD`
> minus `stats().embeddingCostUSD` so you can see the net effect.

```ts
import { createCache } from '@aikit/cache';
import { withSemantic } from '@aikit/cache/semantic';
import { upstashStorage } from '@aikit/cache/storage/upstash';
import { openaiEmbeddings } from '@aikit/cache/embeddings/openai';

const cache = createCache({
  storage: upstashStorage({ url, token }),    // Upstash supports vector search
  semantic: withSemantic({
    embeddings: openaiEmbeddings({
      apiKey: env.OPENAI_API_KEY,
      model: 'text-embedding-3-small',
    }),
    threshold: 0.95,                          // cosine similarity in [0, 1]; default; opt-in 0.92–0.94 for FAQ-style bots
    topK: 5,                                  // pull top-5 then re-rank by recency
    onlyOnMiss: true,                         // skip semantic on exact hits (default)
    extractText: (req) =>                     // optional: customize what gets embedded
      req.messages.filter(m => m.role === 'user').map(m => m.content).join('\n'),
  }),
});
```

```ts
/**
 * Wrap a cache with an embedding-based semantic lookup layer.
 *
 * On `wrap()` cache miss, the request is embedded and matched against the
 * vector index. If the highest-scoring candidate has cosine similarity ≥
 * `threshold`, its cached value is returned. Otherwise, fall through to
 * `fn()` and (on success) the live result is stored under both the exact
 * hash AND the embedding vector for future semantic matches.
 */
export function withSemantic(options: SemanticOptions): SemanticLayer;

export interface SemanticOptions {
  /** Required: how to compute embeddings. */
  readonly embeddings: EmbeddingProvider;
  /**
   * Cosine similarity threshold in `[0, 1]`. Default `0.95`.
   *
   * The default is intentionally above the historical "sweet spot" of
   * 0.92–0.94: a confidently-wrong cached answer to a slightly-different
   * question is the worst possible UX failure here — much worse than a
   * cache miss. 0.92–0.94 is opt-in for FAQ-style bots where a small
   * false-positive rate is acceptable; values below 0.92 are documented
   * as a foot-gun.
   */
  readonly threshold?: number;
  /** Top-K candidates fetched from the vector index. Default `5`. */
  readonly topK?: number;
  /** If true (default), skip semantic lookup when an exact match already hits. */
  readonly onlyOnMiss?: boolean;
  /**
   * Custom function deciding what string to embed. The default joins
   * `user`-role messages' string content.
   *
   * **Multimodal safety.** If a message's content is an array containing
   * non-text parts (vision images, audio, file refs — common in GPT-4o
   * Vision and Claude with images), the default `extractText` THROWS
   * `EmbeddingError(EMBEDDING_REQUEST_FAILED)` rather than silently
   * embedding only the caller's text caption. Silent text-only fallback
   * would conflate visually-different requests under a single cache key
   * and serve confidently-wrong answers across them. Callers that DO
   * want vision-aware semantic caching must supply an explicit
   * `extractText` that incorporates a hash of each non-text part:
   *
   * @example
   * extractText: (req) => {
   *   const parts: string[] = [];
   *   for (const m of req.messages ?? []) {
   *     for (const p of asArray(m.content)) {
   *       if (p.type === 'text') parts.push(p.text);
   *       else if (p.type === 'image') parts.push(`<image:${sha256(p.url)}>`);
   *     }
   *   }
   *   return parts.join('\n');
   * }
   */
  readonly extractText?: (request: CacheRequest) => string;
  /** Vector namespace passed to storage adapters that support it. Default: cache namespace. */
  readonly vectorNamespace?: string;
  /**
   * Re-ranker applied to candidates above `threshold` before picking a winner.
   * Default: argmax by similarity. Useful for breaking ties by recency.
   */
  readonly rerank?: (candidates: readonly SemanticCandidate[]) => SemanticCandidate | undefined;
}

export interface SemanticCandidate {
  readonly key: string;
  readonly similarity: number;
  readonly entry: CacheEntryView;
}

export interface SemanticLayer {
  /** Internal — used by `createCache` to install the layer. Do not call directly. */
  readonly _install: (cache: LLMCache, storage: CacheStorage) => void;
}
```

The `EmbeddingProvider` contract:

```ts
/**
 * A pluggable embedding source. Implementations should:
 *   - normalize vectors to unit length (cosine similarity assumes this).
 *   - support batched calls efficiently (called with up to 64 inputs at once).
 *   - throw `EmbeddingError` (or any `Error` — wrapped automatically) on failure.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(inputs: readonly string[]): Promise<readonly Float32Array[]>;
}

// Bring-your-own:
export function customEmbeddings(options: {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  readonly embed: (inputs: readonly string[]) => Promise<readonly Float32Array[] | readonly number[][]>;
}): EmbeddingProvider;
```

Built-in embedding providers (each in its own subpath):

```ts
// @aikit/cache/embeddings/openai
export function openaiEmbeddings(options: {
  readonly apiKey: string;
  readonly model?: 'text-embedding-3-small' | 'text-embedding-3-large' | 'text-embedding-ada-002' | (string & {});
  readonly dimensions?: number;       // for text-embedding-3-* dimension reduction
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}): EmbeddingProvider;

// @aikit/cache/embeddings/cohere
export function cohereEmbeddings(options: {
  readonly apiKey: string;
  readonly model?: 'embed-v4.0' | 'embed-multilingual-v3.0' | (string & {});
  readonly inputType?: 'search_query' | 'search_document' | 'classification' | 'clustering';
  readonly fetch?: typeof fetch;
}): EmbeddingProvider;

// @aikit/cache/embeddings/voyage
export function voyageEmbeddings(options: {
  readonly apiKey: string;
  readonly model?: 'voyage-3' | 'voyage-3-lite' | 'voyage-code-3' | (string & {});
  readonly fetch?: typeof fetch;
}): EmbeddingProvider;

// @aikit/cache/embeddings  (also exports)
export function withBatching(provider: EmbeddingProvider, options?: {
  readonly maxBatchSize?: number;     // default 32
  readonly flushMs?: number;          // default 10
}): EmbeddingProvider;
```

### 2.4 Cost tracking — `@aikit/cache/cost`

```ts
import { createCache } from '@aikit/cache';
import { registerModel, estimateRequestUSD } from '@aikit/cache/cost';

registerModel('internal-llama-70b', { inputUSDPer1M: 0.5, outputUSDPer1M: 1.5 });

const cache = createCache({ storage, costTracking: true });

await cache.wrap({ model: 'gpt-4o', messages, params: { temperature: 0 } },
  async () => {
    const r = await openai.chat.completions.create({ model: 'gpt-4o', messages });
    return r;
  },
  // Optional explicit usage record — most adapters derive this automatically.
  { usage: { inputTokens: 120, outputTokens: 240 } },
);

// After ~1000 hits across mixed models:
console.log(cache.stats());
// {
//   hits: 687, misses: 313, hitRate: 0.687,
//   savedTokens: { input: 82_440, output: 164_880 },
//   savedUSD: 4.534,
//   embeddingCostUSD: 0.014,
//   netSavedUSD: 4.520,
//   byModel: {
//     'gpt-4o':           { hits: 412, savedUSD: 3.211 },
//     'claude-opus-4-6':  { hits: 275, savedUSD: 1.323 },
//   },
//   since: 1735689600000, until: 1735776000000,
// }
```

```ts
/**
 * Record the per-1M-token price for a model. Called once at app startup
 * for any custom or private model. Built-in models are pre-registered
 * (see `pricing.ts`).
 */
export function registerModel(model: string, pricing: ModelPricing): void;
export function unregisterModel(model: string): boolean;
export function listModels(): readonly string[];
export function getPricing(model: string): ModelPricing | undefined;

/**
 * Estimate the dollar cost of a single (request, response) pair.
 * Used internally by `CostTracker` and exported for one-off estimates.
 */
export function estimateRequestUSD(args: {
  readonly model: string;
  readonly usage: TokenUsage;
}): number;

export interface ModelPricing {
  readonly inputUSDPer1M: number;
  readonly outputUSDPer1M: number;
  /** Optional discounted rate for cached input under prompt-caching. */
  readonly cachedInputUSDPer1M?: number;
  /** Pricing snapshot date (ISO 8601). Set by `registerModel` if omitted. */
  readonly pricingDate?: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Optional: tokens read from provider-side prompt cache (Anthropic / OpenAI). */
  readonly cachedInputTokens?: number;
}

export interface CostSavings {
  readonly hits: number;
  readonly savedTokens: { readonly input: number; readonly output: number };
  readonly savedUSD: number;
}

export interface CacheStatsSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;            // [0, 1]
  readonly errors: number;
  readonly coalesced: number;          // number of waiters absorbed by single-flight
  readonly savedTokens: { readonly input: number; readonly output: number };
  readonly savedUSD: number;
  readonly embeddingCostUSD: number;
  readonly netSavedUSD: number;        // savedUSD − embeddingCostUSD
  readonly byModel: Readonly<Record<string, CostSavings>>;
  readonly since: number;              // ms since epoch when stats started accumulating
  readonly until: number;              // ms since epoch at snapshot time
}
```

### 2.5 Streaming — `cache.wrapStream`

```ts
import { createCache } from '@aikit/cache';
import { memoryStorage } from '@aikit/cache/storage';
import { openAIStreamSerializer } from '@aikit/cache/adapters/openai';
import OpenAI from 'openai';

const openai = new OpenAI();
const cache  = createCache({ storage: memoryStorage({ max: 1_000 }) });

const stream = await cache.wrapStream(
  { model: 'gpt-4o', messages: [{ role: 'user', content: 'Tell a story' }], params: { stream: true } },
  () => openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true }),
  { serializer: openAIStreamSerializer, chunkDelayMs: 'preserve' },
);

for await (const part of stream) {
  process.stdout.write(part.choices[0]?.delta?.content ?? '');
}
```

```ts
/**
 * Provider-specific chunk serializers shipped with adapters.
 *
 * Streaming caching captures every chunk emitted by the upstream stream and
 * stores them as a JSON-serializable array. On replay, chunks are emitted
 * through a fresh `ReadableStream` to make the consumer code identical to a
 * live call.
 *
 * `chunkDelayMs: 'preserve'` records inter-chunk timestamps during the live
 * miss and reproduces them on replay (within ±5 ms). `'instant'` flushes
 * everything as fast as the consumer reads. A numeric value applies a uniform
 * delay between chunks.
 */
export const openAIStreamSerializer:    ChunkSerializer<OpenAIStreamChunk>;
export const anthropicStreamSerializer: ChunkSerializer<AnthropicStreamEvent>;
export const aiSdkStreamSerializer:     ChunkSerializer<AiSdkStreamPart>;
```

> **Atomicity guarantee.** Nothing is written to the cache until the upstream
> stream emits its `close` / `done` event. If the upstream errors mid-stream,
> the partial chunks are dropped and the next caller will perform a fresh
> live call. There is no "incomplete cached stream" state.

### 2.6 Adapters — `@aikit/cache/adapters/*`

#### OpenAI

```ts
import OpenAI from 'openai';
import { createCache } from '@aikit/cache';
import { wrapOpenAI } from '@aikit/cache/adapters/openai';
import { memoryStorage } from '@aikit/cache/storage';

const openai = wrapOpenAI(new OpenAI(), {
  cache: createCache({ storage: memoryStorage({ max: 10_000 }) }),
  // Optional: scope to a sub-namespace per feature
  namespace: 'support-bot',
});

const reply = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
// → identical second call hits the cache, no network round-trip
```

```ts
/**
 * Wrap an OpenAI client with caching. Returns a `Proxy` with the **exact
 * same type** as the input client, so existing code keeps working — replace
 * the constructor and you're done. The Proxy preserves the SDK's
 * parameter and return types verbatim (no `any` widening, no re-typed
 * shapes), so `client.chat.completions.create({...})` still autocompletes
 * its params and returns `ChatCompletion`, not `unknown`.
 *
 * Intercepted methods:
 *   - `chat.completions.create({ stream: false })` → exact-match cache.
 *   - `chat.completions.create({ stream: true })`  → streaming cache via `wrapStream`.
 *   - `embeddings.create()`                        → exact-match cache (uses `CacheRequest.input`).
 *   - `responses.create({ stream?: })`             → both cache modes (uses `CacheRequest.input`).
 *
 * Unintercepted methods pass through unchanged.
 */
export function wrapOpenAI<TClient extends OpenAILike>(
  client: TClient,
  options: WrapClientOptions<TClient>,
): TClient;

/**
 * Structural subtype that captures the surface we proxy. The `(...args: any[]) => any`
 * shape is intentional — it lets the user's installed `openai` package's
 * concrete types flow through via structural subtyping without us
 * re-typing any return shape (which would leak `any` into the user's
 * call sites). The Proxy returns `ReturnType<TClient['chat']['completions']['create']>`
 * verbatim.
 */
export type OpenAILike = {
  chat: { completions: { create: (...args: any[]) => any } };
  embeddings?: { create: (...args: any[]) => any };
  responses?: { create: (...args: any[]) => any };
};

/**
 * Generic in `TClient` so that `skip` / `ttl` callbacks see the precise
 * request shape the user's SDK accepts (`ChatCompletionCreateParams` etc.),
 * not a `Record<string, unknown>` widening that loses autocomplete.
 */
export interface WrapClientOptions<TClient extends OpenAILike = OpenAILike> {
  readonly cache: LLMCache;
  /** Sub-namespace mixed into the cache key (in addition to the cache's global namespace). */
  readonly namespace?: string;
  /**
   * Skip caching for requests where this returns true. Typed against the
   * client's actual request shape so `req.tools` autocompletes:
   *
   * @example
   * skip: (req) => req.tools != null
   */
  readonly skip?: <TReq extends Parameters<TClient['chat']['completions']['create']>[0]>(request: TReq) => boolean;
  /** TTL override per request. */
  readonly ttl?: number | (<TReq extends Parameters<TClient['chat']['completions']['create']>[0]>(request: TReq) => number);
}
```

#### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from '@aikit/cache/adapters/anthropic';

const anthropic = wrapAnthropic(new Anthropic(), { cache });

await anthropic.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello Claude' }],
});
```

#### Vercel AI SDK middleware

```ts
import { openai } from '@ai-sdk/openai';
import { generateText, wrapLanguageModel } from 'ai';
import { cacheMiddleware } from '@aikit/cache/adapters/ai-sdk';

const cached = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: cacheMiddleware({ cache, ttl: 3_600_000 }),
});

const { text } = await generateText({
  model: cached,
  prompt: 'Hello',
});
```

```ts
/**
 * Vercel AI SDK middleware that adds caching to any `LanguageModelV3`.
 * Implements both `wrapGenerate` (exact-match) and `wrapStream` (replay
 * via `simulateReadableStream`-style emission).
 */
export function cacheMiddleware(options: {
  readonly cache: LLMCache;
  readonly namespace?: string;
  readonly ttl?: number;
  readonly skip?: (params: LanguageModelV3CallOptions) => boolean;
}): LanguageModelV3Middleware;
```

#### LangChain.js

```ts
import { ChatOpenAI } from '@langchain/openai';
import { LangChainCache } from '@aikit/cache/adapters/langchain';

const llm = new ChatOpenAI({
  model: 'gpt-4o',
  cache: new LangChainCache({ cache, namespace: 'lc' }),
});
```

```ts
/** Drop-in replacement for `RedisCache` / `UpstashRedisCache`. */
export class LangChainCache extends BaseCache {
  constructor(options: { cache: LLMCache; namespace?: string });
  override lookup(prompt: string, llmKey: string): Promise<Generation[] | null>;
  override update(prompt: string, llmKey: string, value: Generation[]): Promise<void>;
}
```

#### Hono / Express / Next.js

```ts
import { Hono } from 'hono';
import { cacheMiddleware } from '@aikit/cache/adapters/hono';

const app = new Hono();
app.post('/v1/chat/completions',
  cacheMiddleware({ cache, ttl: 3_600_000 }),
  async (c) => {
    const body = await c.req.json();
    const reply = await openai.chat.completions.create(body);
    return c.json(reply);
  },
);
```

```ts
// @aikit/cache/adapters/hono
export function cacheMiddleware<E extends HonoEnv = HonoEnv>(options: {
  readonly cache: LLMCache;
  readonly ttl?: number;
  readonly extractRequest?: (c: Context<E>) => CacheRequest | undefined;
}): MiddlewareHandler<E>;

// @aikit/cache/adapters/express
export function cacheMiddleware(options: {
  readonly cache: LLMCache;
  readonly ttl?: number;
}): RequestHandler;

// @aikit/cache/adapters/next
export function withCache<H extends NextRouteHandler>(handler: H, options: {
  readonly cache: LLMCache;
  readonly ttl?: number;
}): H;
```

### 2.7 Result helper for predictable failures

```ts
import { type Result, isOk, isErr } from '@aikit/cache';

const r: Result<MyResp, CacheError> = await cache.tryWrap(req, fn);
if (isErr(r)) console.error(r.error.code, r.error.message);
```

```ts
export type Result<T, E> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E };

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true;  value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;
```

`LLMCache` exposes a `tryWrap()` mirror of `wrap()` that returns a `Result` instead of throwing. (Note: with the default `onError: 'silent'`, `wrap()` itself will not throw on cache failures; `tryWrap()` is for callers who set `onError: 'throw'` and still want a non-throwing surface.)

---

## 3. Internal Architecture

### 3.1 Module dependency graph

```
                       ┌──────────────┐
                       │  src/index   │   ← root barrel
                       └──────┬───────┘
                              │
                              ▼
                       ┌──────────────┐
                       │  core/*      │   ← cache, key, canonical, coalesce, stream, stats, ttl, events
                       └──┬─────┬─────┘
                          │     │
        ┌─────────────────┘     └─────────────────────┐
        ▼                                             ▼
  ┌──────────────┐                              ┌──────────────┐
  │  types/*     │                              │  internal/*  │
  │ (TS only)    │                              │  digest, json│
  └──────────────┘                              └──────────────┘
                                                       ▲
                                                       │
   ┌─────────────────┬─────────────────────────────────┴───────┬─────────────────┐
   │                 │                                         │                 │
   ▼                 ▼                                         ▼                 ▼
┌──────────┐   ┌────────────┐                          ┌─────────────┐   ┌──────────────┐
│ errors/* │   │  cost/*    │                          │ semantic/*  │   │  storage/*   │
└──────────┘   └────────────┘                          └──────┬──────┘   └──────┬───────┘
   ▲                                                         │                 │
   │                                                         ▼                 ▼
   │                                                  ┌─────────────┐   ┌──────────────┐
   │                                                  │embeddings/* │   │  (8 backends)│
   │                                                  └─────────────┘   └──────────────┘
   │                                                                          ▲
   │            ┌────────────┐                                                │
   └────────────┤ adapters/* │◀───────────────────────────────────────────────┘
                └────────────┘
```

**Strict layering rules:**

- `internal/*` and `types/*` have **zero dependencies on other src modules**.
- `core/*` may depend on `internal/*`, `types/*`, `errors/*`. **No** dependency on cost / semantic / storage / embeddings / adapters.
- `errors/*` depends only on `types/*`.
- `cost/*`, `storage/*`, `embeddings/*` may depend on `core/*` and `errors/*`. **No** mutual dependencies (storage doesn't import embeddings, embeddings doesn't import storage; semantic glues them together).
- `semantic/*` may depend on `core/*`, `errors/*`, `embeddings/*`, and the storage `CacheStorage` shape. **Not** on specific storage backends.
- `adapters/*` may depend on `core/*`, `errors/*`, `cost/*` (for usage extraction). **No** dependency on semantic / storage / embeddings (adapters shape provider data, not cache plumbing).

A test in `tests/internal/dependency-graph.test.ts` will programmatically scan `src/` and assert these boundaries (regex over `import` statements).

### 3.2 Data flow — `wrap()` happy path

```
            cache.wrap(request, fn)
                    │
                    ▼
         canonicalize(request)            (sync; sorted keys, ignored fields removed)
                    │
                    ▼
         hashRequest(canonical)           (async SHA-256 via Web Crypto)
                    │
                    ▼
            key = "ns:model:digest"
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
   storage.get(key)         coalesce.has(key)?
        │                        │ yes
        │ found, fresh           ▼
        │                   await in-flight Promise → return T
        ▼
   return entry.value (HIT, emit 'hit', cost-track)
        │
        │ not found / expired
        ▼
   semantic enabled?
        │ yes
        ▼
   embeddings.embed(extractText(req))
        │
        ▼
   storage.vectorSearch(vector, topK) | memoryIndex.search(...)
        │
        ▼
   pick top hit ≥ threshold → return its value (HIT 'semantic')
        │
        │ no semantic hit
        ▼
   coalesce.dedupe(key, async () => {
       const value = await fn();
       const usage = extractUsage(value) ?? options.usage;
       const ttl   = resolveTTL({ model, namespace, override });
       const entry = { v: 1, value, exp: now + ttl, createdAt: now, tags, usage };
       await storage.set(key, entry, ttl);
       if (semantic) await storage.vectorUpsert([{ id: key, vector }]);
       return value;
   });
        │
        ▼
   return value (MISS, emit 'miss' + 'set')
```

### 3.3 Data flow — `wrapStream()` happy path

```
            cache.wrapStream(request, fn, { serializer })
                    │
                    ▼
              key = hashRequest(canonical)
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
   storage.get(key) → CacheEntry<string>             coalesce.has(key)?
        │ found                                            │ yes
        ▼                                                  ▼
   chunks = serializer.deserialize(entry.value)      await in-flight ReadableStream<TChunk>
        │
        ▼
   return simulateStream(chunks, { chunkDelayMs })
        │
        │ not found
        ▼
   coalesce.dedupe(key, async () => {
       const upstream = await fn();
       const [consumerBranch, captureBranch] = upstream.tee();

       (async () => {
         const captured: TChunk[] = [];
         const reader = captureBranch.getReader();
         while (true) {
           const { value, done } = await reader.read();
           if (done) break;
           captured.push(value);
         }
         const data = serializer.serialize(captured);
         const ttl  = resolveTTL(...);
         await storage.set(key, { v: 1, value: data, ... }, ttl);
       })().catch(err => events.emit('error', { error: wrapStorageError(err), operation: 'set:stream' }));

       return consumerBranch;
   });
```

> **Why `ReadableStream.tee()`?** It is a Web Streams primitive available
> in every supported runtime (Node 18+ via `node:stream/web`, Bun, Deno,
> browsers, Vercel Edge, Cloudflare Workers). The two branches are
> back-pressure-aware: the slower consumer doesn't get starved by the
> faster cache-capture branch.

### 3.4 Key design patterns

| Pattern | Where | Why |
|---|---|---|
| **Single-flight (coalescing)** | `core/coalesce.ts` | Prevents thundering-herd on cache miss. 50 concurrent `wrap()` calls for the same key result in one upstream `fn()` invocation. |
| **Tee + capture** | `core/stream.ts` | Streams need real-time delivery to the consumer AND the cache simultaneously. `ReadableStream.tee()` gives us two back-pressure-aware branches. |
| **Versioned envelope** | `core/envelope.ts` | The wire format carries a `v` field so future schema bumps treat older entries as misses (forward-compat). |
| **Discriminated union events** | `core/events.ts` | `on('hit', listener)` is typed against an exact event payload; `on('error', …)` listener cannot mistakenly access a `key` field that exists on `'set'` only. |
| **Tagged error hierarchy** | `errors/*` | Single `instanceof CacheError` check in user code; `error.code` literal union enables exhaustive switching on specific failure modes. |
| **Pure function core, side-effects at the edges** | `key`, `canonical`, `ttl`, `similarity` are pure; only `storage/*`, `embeddings/*`, and `adapters/*` carry I/O. | Trivial to test, edge-runtime safe, deterministic. |
| **Strategy via function injection** | `extractText` in semantic, `serializer` in stream, `sizeOf` in memory storage, `clock` in core | No abstract classes; users plug in functions. Keeps bundle small. |
| **Lazy import for Node-only code** | `storage/sqlite.ts` calls `await import('better-sqlite3')` inside `init()` | Edge bundlers won't include the Node module unless the subpath is explicitly imported. |
| **Subpath exports as the API contract** | `package.json#exports` | Matches the strict layering rules — bundlers tree-shake by import boundary, not by named export. |
| **Proxy-based adapters** | `wrapOpenAI`, `wrapAnthropic` | Drop-in compatibility — no new method names to learn, existing `client.chat.completions.create(...)` keeps working. |

---

## 4. Type System

### 4.1 End-to-end generic propagation through `wrap`

```ts
// src/core/cache.ts
export interface Cache {
  wrap<T>(
    request: CacheRequest,
    fn: () => Promise<T>,
    options?: WrapOptions,
  ): Promise<T>;
}
export type LLMCache = Cache;

// Usage:
const reply = await cache.wrap(req, () => openai.chat.completions.create({ ... }));
//    ^? ChatCompletion — inferred from openai.chat.completions.create's return type
```

The generic flows through three layers:

1. `wrap<T>` is generic in `T`.
2. The internal `coalesce.dedupe<T>(key, fn)` is generic in `T`.
3. The serialized `CacheEntry<T>` carries `T` so `storage.get<T>(key)` returns `CacheEntry<T> | undefined` (with a `T = unknown` default for backends that can't statically know the shape).

The cache **never widens to `unknown`** unless the user explicitly opts in via `cache.get<unknown>(req)`.

### 4.2 Storage generic

```ts
export interface CacheEntry<T = unknown> {
  readonly v: 1;
  readonly value: T;
  readonly exp: number;
  readonly createdAt: number;
  readonly tags?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly usage?: TokenUsage;
}

export interface CacheStorage {
  get<T = unknown>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, entry: CacheEntry<T>, ttlMs: number): Promise<void>;
  // ...
}
```

Storage adapters cannot know the runtime shape of `T` (they store raw bytes) but the type parameter lets the cache layer hand the correctly-typed entry back to `wrap<T>`.

### 4.3 Adapter typing — preserving the OpenAI / Anthropic surface

`wrapOpenAI<TClient extends OpenAILike>(client: TClient): TClient` returns the **input type unchanged**. Users keep using `openai.chat.completions.create({...})` with full IntelliSense, and the Proxy intercepts the methods we care about while passing the rest through.

```ts
type OpenAILike = {
  chat: { completions: { create: (...args: any[]) => any } };
  embeddings?: { create: (...args: any[]) => any };
  responses?: { create: (...args: any[]) => any };
};
```

The `any` here is **only the structural-subtyping bound** — it's wide enough to admit any concrete `openai` SDK shape the user installs without forcing us to re-declare every overload. Because the Proxy is generic in `TClient` and returns `TClient` (not a re-typed shape), and because intercepted methods forward to the SDK's own implementation, the user's call site keeps the SDK's exact return type:

```ts
const openai = wrapOpenAI(new OpenAI(), { cache });
const r = await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
//    ^? ChatCompletion (from the openai package), NOT any
```

A type test in `tests/types/adapter-result.test-d.ts` asserts this with `expectTypeOf`, so if a future refactor accidentally re-types a return through the Proxy, CI fails. The `WrapClientOptions<TClient>.skip` / `.ttl` callbacks are also generic in `TClient`, so `skip: (req) => req.tools != null` autocompletes against the SDK's `ChatCompletionCreateParams` instead of `Record<string, unknown>`.

### 4.4 Strict mode at the type level

`tsconfig.json` enables:
- `strict: true`
- `exactOptionalPropertyTypes: true`
- `noUncheckedIndexedAccess: true`
- `noImplicitOverride: true`
- `noFallthroughCasesInSwitch: true`
- `noPropertyAccessFromIndexSignature: true`
- `useDefineForClassFields: true`

With `noUncheckedIndexedAccess`, every `record[key]` access yields `T | undefined` — this is essential for the storage layer where missing keys are normal.

### 4.5 Type-level test coverage

`tests/types/*.test-d.ts` files use Vitest's `--typecheck` mode plus `expectTypeOf` to assert:

- `cache.wrap(req, async () => 42 as const).then(x => expectTypeOf(x).toEqualTypeOf<42>())` — generic propagates.
- `cache.get(req)` returns `Promise<unknown>` by default, narrowable via `cache.get<MyType>(req)`.
- `wrapOpenAI(new OpenAI())` returns `OpenAI` (input shape preserved).
- Storage `get<MyEntry>(key)` returns `Promise<CacheEntry<MyEntry> | undefined>`.
- `on('hit', e => …)` payload has `e.from: 'exact' | 'semantic'` and not `e.error`.
- `on('error', e => …)` payload has `e.error: CacheError` and not `e.from`.
- `customEmbeddings({ embed: async (xs) => xs.map(_ => [1, 2, 3]) })` returns an `EmbeddingProvider` (number[][] auto-converted to Float32Array[]).

These tests fail the build if a refactor accidentally widens an event payload or drops a generic parameter.

---

## 5. Error Handling Strategy

### 5.1 Error class hierarchy

```ts
// src/errors/base.ts
export type ErrorCode =
  | 'INVARIANT'
  | 'CACHE_DISPOSED'
  | 'CACHE_INVALID_OPTIONS'
  | 'WEB_CRYPTO_UNAVAILABLE'
  | 'STORAGE_GET_FAILED'
  | 'STORAGE_SET_FAILED'
  | 'STORAGE_DELETE_FAILED'
  | 'STORAGE_INVALIDATE_FAILED'
  | 'STORAGE_BACKEND_UNAVAILABLE'
  | 'STORAGE_VALUE_TOO_LARGE'
  | 'STORAGE_PARSE_FAILED'
  | 'STORAGE_VECTOR_UNSUPPORTED'
  | 'EMBEDDING_REQUEST_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'STREAM_CAPTURE_FAILED'
  | 'STREAM_REPLAY_FAILED'
  | 'STREAM_SERIALIZER_MISSING'
  | 'STREAM_SERIALIZER_MISMATCH'
  | 'STREAM_UPSTREAM_ABORTED'
  | 'STREAM_API_UNAVAILABLE'
  | 'INVALIDATION_PATTERN_INVALID'
  | 'INVALIDATION_NOT_SUPPORTED'
  | 'COST_UNKNOWN_MODEL'
  | 'COST_INVALID_PRICING'
  | 'CONFIG_INVALID_TTL'
  | 'CONFIG_INVALID_THRESHOLD'
  | 'CONFIG_INVALID_NAMESPACE'
  | 'ADAPTER_UNSUPPORTED_METHOD';

export abstract class CacheError extends Error {
  abstract readonly code: ErrorCode;
  override readonly name: string = 'CacheError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype); // safe instanceof across realms
  }
}
```

Subclasses carry structured context, e.g.:

```ts
export class StorageError extends CacheError {
  readonly code:
    | 'STORAGE_GET_FAILED'
    | 'STORAGE_SET_FAILED'
    | 'STORAGE_DELETE_FAILED'
    | 'STORAGE_INVALIDATE_FAILED'
    | 'STORAGE_BACKEND_UNAVAILABLE'
    | 'STORAGE_VALUE_TOO_LARGE'
    | 'STORAGE_PARSE_FAILED'
    | 'STORAGE_VECTOR_UNSUPPORTED';

  constructor(
    code: StorageError['code'],
    readonly operation: 'get' | 'set' | 'delete' | 'invalidate' | 'clear' | 'vectorSearch' | 'vectorUpsert',
    readonly storageName: string,
    message: string,
    options?: { cause?: unknown; key?: string; bytes?: number },
  ) {
    super(message, options);
    this.code = code;
  }
}

export class EmbeddingError extends CacheError {
  readonly code: 'EMBEDDING_REQUEST_FAILED' | 'EMBEDDING_DIMENSION_MISMATCH' | 'EMBEDDING_PROVIDER_UNAVAILABLE';
  constructor(
    code: EmbeddingError['code'],
    readonly providerName: string,
    message: string,
    readonly options?: { cause?: unknown; httpStatus?: number; expectedDim?: number; actualDim?: number },
  ) {
    super(message, options);
    this.code = code;
  }
}
```

### 5.2 Throw vs. Result vs. graceful-degrade

| Situation | Convention |
|---|---|
| Programmer error (invalid TTL ≤ 0, threshold > 1, accessing the cache after `dispose()`) | **Throw** synchronously at config / call time. These are bugs to fix at dev time. |
| Cache-layer failure (storage timeout, embedding 429, semantic vector parse error) inside `wrap()` | **Default: graceful-degrade** — execute `fn()`, return live result, emit `'error'` event. Override with `onError: 'throw'` to escalate, or call `cache.tryWrap()` to receive a `Result`. |
| Live LLM API error thrown by `fn()` | **Always propagate.** The cache never swallows or transforms errors thrown by the user's `fn()`. |
| Streaming upstream errors mid-stream | **Always propagate** to the consumer (the consumer's `for await` loop receives the error). The half-captured chunks are dropped — nothing is written to the cache. |
| Storage `get` returns malformed JSON / wrong envelope version | Treat as miss, emit `'error'` for observability, fall through to `fn()`. Do not throw — corrupt cache state must not block production. |
| User-supplied callback throws (`extractText`, `serializer`, `skip`, `rerank`) | Catch and rethrow wrapped in the appropriate domain error (`EmbeddingError`, `StreamError`, `ConfigError`) with `cause` set, so the stack still points at the user code. |

### 5.3 Error messages

Every thrown error includes:
1. The human-readable message.
2. The `code` (for programmatic handling).
3. Structural context (storage name + operation, embedding provider name + HTTP status, …).
4. A docs-link suffix appended unless `NODE_ENV === 'production'`. The check is **edge-safe**:
   ```ts
   const isProd =
     typeof process !== 'undefined' &&
     typeof process.env !== 'undefined' &&
     process.env.NODE_ENV === 'production';
   ```
   No bare `process.env` access (Cloudflare Workers and Vercel Edge throw `ReferenceError` on undefined `process`). When in doubt, including the docs link is the safer default.

### 5.4 Observability surface

Errors that get swallowed by graceful-degradation are still surfaced via `cache.on('error', listener)`. The recommended pattern in production:

```ts
cache.on('error', ({ error, operation }) => {
  metrics.increment('llm_cache_errors', { code: error.code, operation });
  if (error.code === 'STORAGE_BACKEND_UNAVAILABLE') alert.fire(error);
});
```

The event listener receives a typed `{ error: CacheError; operation: string }` payload. Errors thrown inside listeners are caught and re-emitted as a synthetic `'error'` event with `operation: 'event-listener'` to prevent listener bugs from crashing the cache.

---

## 6. Bundle & Tree-shaking Plan

### 6.1 Entry points (`package.json#exports`)

> All sizes are **minified + gzip** as measured by `size-limit` with
> `@size-limit/preset-small-lib` (its default). The preset reports gzip;
> stating "min" alone would be misleading. CI fails the build on any cap breach.

| Subpath | Files included | Size budget (min+gz) |
|---|---|---|
| `.` | `core/*` (no semantic), `types/*`, `internal/*`, `errors/base` | **6 KB** target, 8 KB hard cap |
| `./errors` | All concrete error classes | 0.6 KB |
| `./cost` | `cost/*` (most weight is the pricing table) | 1.5 KB |
| `./semantic` | `semantic/*` (similarity, memory-index, layer) | 1.2 KB |
| `./storage` | Universal barrel: `memoryStorage`, `multiTierStorage`, `lru` | 1.2 KB |
| `./storage/redis` | ioredis adapter (peer dep) | 0.8 KB |
| `./storage/upstash` | @upstash/redis REST adapter | 0.9 KB |
| `./storage/cloudflare-kv` | CF Workers KV adapter | 0.6 KB |
| `./storage/vercel-kv` | Vercel KV adapter | 0.6 KB |
| `./storage/sqlite` | better-sqlite3 adapter (Node-only) | 1.1 KB |
| `./storage/postgres` | pg / postgres + pgvector adapter (Node-only) | 1.4 KB |
| `./embeddings` | `customEmbeddings`, `withBatching`, types | 0.8 KB |
| `./embeddings/openai` | OpenAI embeddings (REST) | 0.9 KB |
| `./embeddings/cohere` | Cohere embeddings (REST) | 0.7 KB |
| `./embeddings/voyage` | Voyage embeddings (REST) | 0.7 KB |
| `./adapters/openai` | OpenAI Proxy + stream serializer | 1.2 KB |
| `./adapters/anthropic` | Anthropic Proxy + stream serializer | 1.2 KB |
| `./adapters/ai-sdk` | LanguageModelV3Middleware | 1.0 KB |
| `./adapters/langchain` | BaseCache subclass | 0.6 KB |
| `./adapters/hono` | Hono middleware | 0.5 KB |
| `./adapters/express` | Express middleware | 0.5 KB |
| `./adapters/next` | Next.js Route Handler wrapper | 0.5 KB |
| `./package.json` | (resolution support) | — |

> **Why semantic is its own subpath.** Semantic search is a 30%-use-case
> feature. Forcing the cosine-similarity routine, the in-memory vector
> index, and the layer plumbing on every consumer would push the core well
> past the 8 KB cap. A user importing only `createCache` + `memoryStorage`
> ships under 8 KB total.

### 6.2 Tree-shaking guarantees

- `package.json#sideEffects: false` — bundlers can drop unused exports.
- Every barrel uses `export { ... } from './x'` (named re-exports), never `export * from`.
- No top-level `new SomeClass()`, `console.log()`, or other side-effects at module load.
- The pricing table is exported as a **frozen object literal**, not a class instance — the bundler can keep only the keys you reference if you import them by name.
- Adapters use `import type` for provider SDK types so adapters work without the SDK at runtime, AND so the SDK is never bundled.
- `storage/sqlite.ts` uses `await import('better-sqlite3')` inside the storage's lazy `init()`, so edge bundlers (Wrangler, Vercel) won't pull `better-sqlite3` unless that subpath is statically imported.
- `storage/redis.ts` accepts a pre-constructed `ioredis` client, never imports `ioredis` itself.

### 6.3 Build tool

`tsup` with multi-entry config:

```ts
// tsup.config.ts (sketch — written during implementation)
export default defineConfig({
  entry: {
    index:                              'src/index.ts',
    'errors/index':                     'src/errors/index.ts',
    'cost/index':                       'src/cost/index.ts',
    'semantic/index':                   'src/semantic/index.ts',
    'storage/index':                    'src/storage/index.ts',
    'storage/redis':                    'src/storage/redis.ts',
    'storage/upstash':                  'src/storage/upstash.ts',
    'storage/cloudflare-kv':            'src/storage/cloudflare-kv.ts',
    'storage/vercel-kv':                'src/storage/vercel-kv.ts',
    'storage/sqlite':                   'src/storage/sqlite.ts',
    'storage/postgres':                 'src/storage/postgres.ts',
    'embeddings/index':                 'src/embeddings/index.ts',
    'embeddings/openai':                'src/embeddings/openai.ts',
    'embeddings/cohere':                'src/embeddings/cohere.ts',
    'embeddings/voyage':                'src/embeddings/voyage.ts',
    'adapters/openai/index':            'src/adapters/openai/index.ts',
    'adapters/anthropic/index':         'src/adapters/anthropic/index.ts',
    'adapters/ai-sdk/index':            'src/adapters/ai-sdk/index.ts',
    'adapters/langchain/index':         'src/adapters/langchain/index.ts',
    'adapters/hono/index':              'src/adapters/hono/index.ts',
    'adapters/express/index':           'src/adapters/express/index.ts',
    'adapters/next/index':              'src/adapters/next/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,           // keep readable; consumers' bundlers minify
  treeshake: true,
  splitting: false,        // each subpath is its own bundle
  target: 'es2022',
  external: [
    'openai', '@anthropic-ai/sdk', 'ai', '@langchain/core',
    'ioredis', '@upstash/redis', 'better-sqlite3', '@vercel/kv',
    'pg', 'postgres',
    'cohere-ai',
    'hono', 'express', 'next',
    'node:fs/promises', 'node:fs',
  ],
});
```

`size-limit` runs in CI and fails the build if any limit in `package.json#size-limit` is exceeded.

### 6.4 Verification tools

- `publint` — validates the `exports` map and dual-package layout.
- `@arethetypeswrong/cli` — verifies that types resolve correctly for every subpath in both Node and bundler contexts.
- `vitest` runs in two pools: default Node and a Workers pool (`@cloudflare/vitest-pool-workers`) limited to edge-safe modules to confirm they don't accidentally import `node:*`.

---

## 7. Dependencies

### 7.1 Runtime dependencies — **none**

The library targets the union of Node 18+, Bun, Deno, browsers, Vercel Edge, and Cloudflare Workers. The only universally available primitives we need are:

- `String`, `Array`, `Map`, `Set`, `Object.freeze`, `Promise`, `Symbol` → built-in.
- `globalThis.crypto.subtle.digest('SHA-256', …)` → universal (Node 18+ exposes Web Crypto on `globalThis.crypto`).
- `TextEncoder`, `TextDecoder` → universal.
- `ReadableStream`, `ReadableStream.tee()` → universal (Node 18+ via Web Streams).
- `fetch`, `Headers`, `Request`, `Response` → universal as of Node 18.

Every additional dep would either:
- Inflate the bundle (LangChain's lesson; the report calls this out as a competitive risk).
- Constrain the runtime matrix (Node-only `node:crypto`, `node:fs`).
- Drag a transitive license/audit burden onto every consumer.

The bundle-size discipline is the headline differentiator vs. LangChain's `@langchain/community` cache implementations. The report's `@noble/hashes` suggestion was tempting (and well-targeted), but Web Crypto's `SubtleCrypto.digest('SHA-256', …)` covers the same need with zero deps inside an already-async `wrap()` flow. The asynchronicity overhead is dominated by the storage round-trip in every realistic benchmark.

### 7.2 Peer dependencies (optional)

| Package | Why peer | Required by |
|---|---|---|
| `openai` | OpenAI client surface (Proxy target) and stream chunk types | **Runtime peer:** `./adapters/openai` (we Proxy a real `OpenAI` instance). **Types-only peer:** `./embeddings/openai` (we hit the REST endpoint directly via `fetch` — `import type` only, the SDK is never required at runtime). |
| `@anthropic-ai/sdk` | Anthropic client surface and message types | **Runtime peer:** `./adapters/anthropic`. |
| `ai` | Vercel AI SDK middleware shape (`LanguageModelV3Middleware`) | **Runtime peer:** `./adapters/ai-sdk`. |
| `@langchain/core` | `BaseCache`, `Generation` | **Runtime peer:** `./adapters/langchain` (we extend `BaseCache`). |
| `ioredis` | Redis client | **Runtime peer:** `./storage/redis` (only when constructing the client; `redisStorage({ client })` accepts a pre-constructed client and never imports `ioredis` itself). |
| `@upstash/redis` | Upstash REST client | **Runtime peer:** `./storage/upstash` only when used via the `{ client }` constructor; the `{ url, token }` form uses bare `fetch`. |
| `@vercel/kv` | Vercel KV client | **Runtime peer:** `./storage/vercel-kv`. |
| `better-sqlite3` | SQLite driver | **Runtime peer:** `./storage/sqlite` (Node-only, lazy `import()`). |
| `pg` or `postgres` | Postgres driver (either accepted) | **Runtime peer:** `./storage/postgres` (Node-only, lazy `import()`). The pgvector extension is a server-side feature, not an npm dep. |
| `cohere-ai` | Cohere client surface | **Types-only peer:** `./embeddings/cohere` (REST direct via `fetch`; `import type` only). The peer-dep entry exists purely so users on TS-strict resolution get IntelliSense. |
| `hono` | Hono context types | **Runtime peer:** `./adapters/hono`. |
| `express` | Express middleware types | **Runtime peer:** `./adapters/express`. |
| `next` | Next.js Route Handler types | **Runtime peer:** `./adapters/next`. |

All are marked `peerDependenciesMeta.<pkg>.optional = true` so installing the lib without them is silent. Adapters that only use provider types via `import type` work even at runtime without the SDK installed — they are pure data-shape mappers.

For Cloudflare Workers KV, no peer dep is required: the `KVNamespace` type is part of `@cloudflare/workers-types` (a dev dep only), and the runtime contract is the bound KV namespace passed in by the caller.

### 7.3 Dev dependencies (build/test only)

Standard set for the portfolio: `tsup`, `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `@typescript-eslint/*`, `prettier`, `size-limit`, `@size-limit/preset-small-lib`, `publint`, `@arethetypeswrong/cli`, `@types/node`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`. Provider SDKs are listed under devDeps to give the type-checker the real shapes during development. `ioredis-mock` for storage tests.

---

## 8. Configuration

### 8.1 `tsconfig.json` (root)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useDefineForClassFields": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "types": ["node", "@cloudflare/workers-types"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

> `lib: ["ES2022", "DOM", "DOM.Iterable"]` brings in `ReadableStream`, `Response`, `crypto.subtle`, etc. We don't ship browser code that touches the DOM, but the DOM lib is the canonical home of Web Streams / Web Crypto types.

### 8.2 `tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-d.ts", "tests", "examples", "benchmarks"]
}
```

### 8.3 `vitest.config.ts`

- `test.environment: 'node'`
- `test.typecheck.enabled: true`, `test.typecheck.include: ['tests/types/**/*.test-d.ts']`
- `test.coverage`: V8 reporter, threshold `lines/branches/functions/statements: 90%`.
- Workers pool project for `tests/edge/**` (smoke tests for edge-safe modules) using `@cloudflare/vitest-pool-workers`.
- A separate "node-only" project for `tests/storage/sqlite.test.ts` (excluded from edge pool).

### 8.4 `package.json` highlights

- `name: '@aikit/cache'`, `version: '0.1.0'`, `type: 'module'`, `sideEffects: false`.
- Comprehensive `exports` map matching §6.1.
- `engines.node: '>=18.17.0'`.
- `publishConfig.access: 'public'`, `provenance: true`.
- `size-limit` block enforcing per-subpath budgets (added in implementation phase).
- `prepublishOnly` runs lint → typecheck → test → build → publint → attw → size.

---

## 9. Edge Cases the Implementation Must Handle

### 9.1 Cache key / canonicalization

1. Two requests with the same fields in different key order — same key.
2. A request with `params: undefined` vs missing `params` field — same key.
3. A request with `params: { temperature: 0 }` vs `params: { temperature: 0, top_p: 1 }` — **different** keys (top_p affects output).
4. A request with `metadata` containing a UUID (`request_id`), trace span, or any caller-side annotation — the entire `metadata` subtree is in the default `WrapOptions.ignoreFields`, so adding/removing metadata fields never changes the key.
4a. A request with both `messages` and `input` set, or with neither set — `CACHE_INVALID_OPTIONS` thrown synchronously at `wrap()` entry. Adapters that intercept embedding / responses / audio endpoints must populate `input`, never smuggle data through `params`.
5. Messages containing user-supplied JSON-encoded strings — hashed verbatim; we do not double-decode.
6. `messages` containing whitespace-only differences (`'Hello'` vs `'Hello '`) — different keys by default; opt-in `canonicalize: { trimWhitespace: true }` to collapse.
7. Unicode normalization — input is treated as code-point sequences. NFC/NFD differences produce different keys; documented.
8. Floating-point params (`temperature: 0.5` vs `0.50`) — same key (`canonicalJSON` normalizes via `Number.prototype.toString`).
9. `NaN`, `Infinity`, `-Infinity` in `params` — `canonicalJSON` throws `INVARIANT` (these are invalid JSON; pass strings if you need them).
10. Very large `messages` (> 1 MB) — supported; SHA-256 streaming-friendly.
11. Cache-key forward compatibility: every persisted entry's wire format includes `v: 1`. A future v0.2 schema bump will increment `v`; loaders see `v !== 1` and treat the entry as a miss (no in-place migration).
12. Cache-key version is also implicitly tied to the canonicalization algorithm. Bumping the canonicalizer (e.g. enabling whitespace normalization by default in v0.2) ships under `v: 2` so old and new entries don't collide.

### 9.2 TTL

13. TTL of 0 — entry is set then immediately considered expired on the next `get()`. Functionally a no-op; documented as the way to disable per-call caching.
14. TTL of `Infinity` — rejected with `CONFIG_INVALID_TTL`. Use a large but finite TTL (e.g. `10 * 365 * 86400_000`).
15. TTL of negative number — `CONFIG_INVALID_TTL`.
16. Sliding TTL with `maxAgeMs` — entries that hit fresher than `maxAgeMs` get their `exp` refreshed; older entries stop refreshing and expire normally. Prevents entries from living forever under continuous traffic.
17. TTL jitter — adds `±10%` (default) randomness to written TTLs to prevent thundering-herd expiry. Read-side TTL check is exact (no jitter on the read path).
18. Per-model TTL takes precedence over per-namespace TTL takes precedence over `default`. Ties broken by definition specificity, not declaration order.
19. Storage backend with coarser TTL granularity than the requested value (e.g. Cloudflare KV's 60-second minimum) — the adapter rounds **up** and emits a one-time warning.

### 9.3 Coalescing

20. 100 concurrent `wrap()` calls for the same key — exactly one upstream `fn()` call; the other 99 await the same Promise.
21. The leader's `fn()` throws — every waiter receives the same rejected Promise. None of them retry (caller's responsibility).
22. The leader's `fn()` is canceled (e.g. `AbortSignal`) — the waiters see the cancellation. The next caller after the rejection performs a fresh call (no negative-result caching by default).
23. Two callers issue the same key 1 ms apart, the leader settles in 0.5 ms — the second caller sees the result via `storage.get`, not via coalescing. Both paths return the same data.
24. Coalescing key includes the namespace — two callers in different namespaces with the same `(model, messages, params)` do NOT coalesce.
25. The coalescing map's entries are removed on `.finally()` — no memory leak even under sustained burst load.
26. `wrapStream`'s upstream Promise is captured for coalescing, but the returned `ReadableStream` is `tee()`'d freshly per waiter; multiple waiters see the same chunks at the same cadence.

### 9.4 Streaming

27. Upstream stream errors mid-stream — the consumer's `for await` loop receives the error; the partial chunks are dropped; nothing is cached.
28. Consumer aborts (`AbortSignal`) before the upstream finishes — the cache-capture branch continues to drain the upstream so the entry is still cached. (We pay the bandwidth either way; we may as well save the cost on the next caller.)
29. Upstream emits 0 chunks before close — cached as an empty array; replays as an immediately-closed stream.
30. Upstream emits non-serializable values (functions, symbols) — `serializer.serialize` throws `STREAM_CAPTURE_FAILED`; the consumer still gets the live stream; nothing is cached.
31. Replay with `chunkDelayMs: 'preserve'` after a process restart — original timing was captured per-chunk in the serialized envelope; preserved across restarts.
32. Replay of a stream cached under one serializer with a different serializer — detected by `meta.serializerId` mismatch on the loaded envelope; the cache fails fast with `STREAM_REPLAY_FAILED` and treats it as a miss (next call fetches and re-caches under the current serializer's id). The check is purely on the stamped id, so two serializers producing the same wire shape no longer silently corrupt each other's data.
33. Stream payload exceeds storage's `maxValueBytes` — emit `'evict'` style warning, do not cache, but the consumer's stream completes normally.

### 9.5 Storage adapters

34. `memoryStorage` reaches `max` entry count — LRU evicts oldest; `'evict'` event fires.
35. `memoryStorage` reaches `maxBytes` — LRU evicts oldest until under the cap.
36. `redisStorage` connection drops — `set` / `get` reject; cache layer falls through to `fn()` (default `onError: 'silent'`).
37. `upstashStorage` 429 rate limit — adapter retries with exponential backoff (3 attempts, 100/200/400 ms) before propagating.
38. `cloudflareKVStorage` write occurs in a request handler — wrapped in `event.waitUntil()` so the handler returns immediately and the write completes async.
39. `sqliteStorage` invoked in an edge runtime (no `node:*`) — `STORAGE_BACKEND_UNAVAILABLE` thrown at first storage operation, not at module import (the lazy `import('better-sqlite3')` defers the failure).
40. Storage with `capabilities.maxValueBytes` set — entries exceeding it are dropped before `set()` with a one-time warning. Live `fn()` result is still returned.
41. Two storage backends in `multiTierStorage` see divergent values for the same key (out-of-band write to L2) — read returns L1's value; documented behavior. `multiTierStorage({ readPolicy: 'newest' })` is a v0.2 milestone.
42. `storage.invalidate({ predicate })` on a backend without efficient enumeration (Upstash) — falls back to `keys` scan with a documented `O(N)` warning.
43. Storage `get` returns an entry whose `v !== 1` — treated as miss; emit `'error'` event for observability.

### 9.6 Semantic cache

44. Embedding provider returns vectors of the wrong dimension — `EMBEDDING_DIMENSION_MISMATCH`; semantic lookup is skipped, cache falls through to `fn()`.
45. Embedding request rate-limited — graceful-degrade; emit `'error'`; cache falls through to `fn()`.
46. Threshold of 1.0 — only exact-vector matches hit (cosine distance 0). Useful for purely embedding-based dedupe.
47. Threshold of 0.0 — anything matches; first vector candidate wins. Documented as a footgun.
48. Two cached entries with cosine similarity above threshold — `rerank` callback (default `argmax(similarity)`) picks one. Tie-break documented.
49. Storage advertises `vectorSearch` capability but the underlying adapter throws `STORAGE_VECTOR_UNSUPPORTED` at runtime — semantic layer falls back to `MemoryVectorIndex` and emits a one-time warning.
50. Semantic layer with a storage that does not advertise vector search — automatically uses `MemoryVectorIndex`. Documented as not appropriate for > 10k entries.
51. `extractText` returns an empty string — `EmbeddingError(EMBEDDING_REQUEST_FAILED)` with hint to override `extractText`.
52. Caller writes a non-text message (multimodal image / audio / file part) — default `extractText` THROWS `EmbeddingError(EMBEDDING_REQUEST_FAILED)` with a hint to override `extractText` and incorporate hashes of the non-text parts. Silent text-only fallback would conflate visually-different vision requests under one cache key and serve confidently-wrong cross-image hits.
53. Embedding cost tracking — every embedding call records its own cost into `stats.embeddingCostUSD`; the `stats.netSavedUSD` field surfaces the net effect after embedding overhead.

### 9.7 Cost

54. Unknown model → `COST_UNKNOWN_MODEL` with a hint to call `registerModel()`. Cache layer continues to function; only stats reporting is affected.
55. Pricing with negative price → `COST_INVALID_PRICING` at registration time.
56. Adapter cannot extract `usage` from the upstream response (e.g. legacy provider response missing the field) — `usage` is omitted from the cached entry; on hit, `savedUSD` for that entry is `0` (we don't make up numbers).
57. Manual `set()` without `usage` — same: hits don't accumulate dollars.
58. Provider-side prompt caching discount — pricing table's `cachedInputUSDPer1M` is honored when adapters set `usage.cachedInputTokens > 0`. Otherwise the full `inputUSDPer1M` is used.

### 9.8 Adapters

59. `wrapOpenAI` wrapping a custom subclass of `OpenAI` — Proxy preserves prototype, so `instanceof` checks keep working.
60. `wrapOpenAI` called twice on the same client — the second wrap detects the marker (`Symbol.for('aikit.cache.wrapped')`) and returns the same Proxy with a one-time warning (no double-caching).
61. `wrapOpenAI` with `skip: (req) => req.tools != null` — tool-using requests bypass the cache (tools usually depend on live state).
62. `cacheMiddleware` for AI SDK's `wrapStream` — chunks are cached using `aiSdkStreamSerializer`; replay produces a fresh `ReadableStream<LanguageModelV3StreamPart>`.
63. `LangChainCache` returning `null` for misses — matches LangChain's `BaseCache` contract.
64. `next` adapter's wrapped Route Handler used in a static export build — graceful degrade (cache reads succeed, writes are no-ops in static contexts).
65. `hono` adapter sees a non-JSON request body — passes through unmodified (we cache only requests we can canonicalize).

### 9.9 Edge runtime / Web Crypto

66. `globalThis.crypto?.subtle` undefined — `WEB_CRYPTO_UNAVAILABLE`. Theoretical; supported runtimes always provide it. Kept as a defensive guard.
67. `ReadableStream.tee()` not available — `STREAM_API_UNAVAILABLE` thrown at first `wrapStream()` call. Theoretical on supported runtimes (all expose Web Streams); kept as a defensive guard so the user gets a precise diagnostic instead of an unrelated `TypeError`.
68. `process.env.NODE_ENV` access in error message construction — gated by `typeof process !== 'undefined'` (Cloudflare Workers throws a `ReferenceError` on undefined `process`).
69. Cache used inside a Cloudflare Worker request handler — writes wrapped in `ctx.waitUntil(...)` are completed even if the handler returns early.

### 9.10 Type safety regressions

70. `cache.wrap(req, fn)` where `fn` returns `Promise<unknown>` — return type is `Promise<unknown>`; user must narrow. We do not silently widen.
71. `cache.get(req)` without explicit generic — returns `Promise<unknown>`. Encourages narrowing at the call site.
72. Storage adapter returns `CacheEntry<unknown>` — cast to `CacheEntry<T>` happens at the cache layer based on `wrap<T>`'s generic. Runtime structural validation is opt-in via a `validate` callback (v0.2).

### 9.11 Concurrency / disposal

73. `cache.dispose()` called twice — second call is a no-op; returns the same resolved Promise.
74. `cache.dispose()` called while a `wrap()` is in-flight — awaits the in-flight call, then drops the cache; the `wrap()`'s result still returns to its caller.
75. `cache.dispose()` called while a streaming `wrap()` is mid-capture — awaits the upstream close before resolving; the captured chunks are still written.
76. Two `cache.on('hit', listener)` calls register two listeners; both fire on every hit.
77. `cache.resetStats()` is a no-op for the in-flight `wrap()` calls' future contributions to stats — they will count toward the post-reset window.
78. `Object.freeze` on options at construction is shallow; nested objects (e.g. `perModelTTL`) are frozen one level deep but their values (numbers) are primitive. Documented that consumers should not mutate option references after construction.

### 9.12 Misc

79. JSON serialization round-trip preserves all envelope fields. Functions on `extractText` / `serializer` / `skip` are not serialized — they live on the in-memory cache and must be re-supplied when the process restarts.
80. Concurrent `wrap()` calls on the same `LLMCache` instance from different async contexts are safe — the coalescing map is per-instance and uses synchronous Map operations.
81. Two `LLMCache` instances pointing at the same storage but with different namespaces do not collide — the namespace is mixed into every key. Two instances pointing at the same storage with the **same** namespace share entries (intended; supports horizontal scale-out).
82. Hash collisions across millions of keys — SHA-256 collision probability is negligible at any realistic scale; namespace + model prefix shrinks the relevant collision space further.

---

## 10. Out of Scope (explicit)

Pinned here so future contributors don't drift the scope:

- **LLM invocation itself.** Use `openai`, `@anthropic-ai/sdk`, `ai`, or any other client. We only cache responses.
- **Vector database.** We adapt to existing vector-capable storages (Upstash Vector, Redis Search, pgvector via custom adapter); we do not ship one.
- **Embedding model hosting.** Pluggable providers only.
- **Hosted SaaS** (Helicone, Portkey-style). Self-hosted is the differentiator.
- **AI gateway features** (model routing, retries with fallback models, rate limiting). That's a different lib.
- **Cache for `prefix` prompt-cache** (Anthropic / OpenAI). Provider-native; the library tracks the discount via `cachedInputUSDPer1M` but does not duplicate the feature.
- **Real-time observability dashboard.** Stats are exposed via `cache.stats()`; building a UI is downstream.

---

## 11. Implementation Order (non-binding)

### v0.1 — first publishable cut

1. `internal/digest` + `internal/canonical-json` + `internal/clock` + `errors/*` — foundation.
2. `core/canonical` + `core/key` + `core/envelope` + `core/types` — keying core.
3. `core/ttl` + `core/coalesce` + `core/events` + `core/stats` — orchestration.
4. `storage/lru` + `storage/memory` — first end-to-end exact-match path.
5. `core/cache` — `createCache`, `wrap`, `get`, `set`, `delete`, `clear`, `on`, `dispose`. Type-test files for generic propagation.
6. `core/invalidate` + per-storage invalidate strategy (memory first).
7. `core/stream` + `wrapStream` + `aiSdkStreamSerializer` (smallest serializer first).
8. `cost/pricing` (Apr 2026 snapshot) + `cost/pricing-registry` + `cost/tracker` — savings math.
9. `storage/multi-tier` + `storage/upstash` + `storage/cloudflare-kv` + `storage/redis` + `storage/sqlite` + `storage/vercel-kv` + `storage/postgres` (incl. pgvector). Each Redis-/Upstash-shipped adapter also exports its `DistributedLock` (`redisLock`, `upstashLock`) for multi-pod single-flight.
10. `embeddings/types` + `embeddings/custom` + `embeddings/openai` + `embeddings/cohere` + `embeddings/voyage` + `embeddings/batched`.
11. `semantic/similarity` + `semantic/memory-index` + `semantic/store-adapter` + `semantic/layer`.
12. `adapters/openai` + `adapters/anthropic` + `adapters/ai-sdk` + `adapters/langchain` + `adapters/hono` + `adapters/express` + `adapters/next`.
13. README, examples (incl. CF Workers KV demo, Vercel Edge route, AI SDK middleware), benchmarks.
14. CI: `lint → typecheck → test → coverage → build → publint → attw → size`.

### v0.2 milestones (post-launch backlog)

- **Reference `DistributedLock` polish** — the `coalesce.lock` interface ships in v0.1 (with `redisLock` from `./storage/redis` and `upstashLock` from `./storage/upstash`), so multi-pod deployments can share single-flight on day one. v0.2 adds: a Cloudflare Durable Objects lock implementation, fairness/queue-length metrics on the lock interface, and a built-in benchmark suite.
- **`multiTierStorage({ readPolicy: 'newest' })`** — compare timestamps across tiers and return the freshest (currently L1 always wins).
- **Negative-result caching** — cache `fn()` errors with a short TTL to absorb transient outages without hammering the upstream. Opt-in due to the obvious foot-gun.
- **`v: 2` envelope** — add `model`, `provider`, and `region` to every entry for richer observability without re-canonicalizing the key.
- **Cache warming primitives** — `cache.warm([reqs], producer)` to pre-populate during deploy.
- **`adapters/mistral`, `adapters/google`** — once the SDK shapes stabilize.
- **OpenTelemetry exporter** — wraps `cache.on('hit'/'miss'/'error')` into spans / counters so the cache slots into existing observability.
- **`semantic/index/hnsw`** — opt-in HNSW small-world index for in-memory deployments above 10k vectors. Currently linear-scan only.
- **`storage/durable-object`** — Cloudflare Durable Objects adapter for stronger per-key consistency than KV.

---

## Review Changes

This section records the disposition of every concern raised by Mykhailo Kryvytskyi in the architecture-plan PR review. For each item: the original concern, what we changed (or why we did not), and which sections of `PLAN.md` were modified. The reviewer's `REQUEST_CHANGES` verdict is addressed.

### High-severity

1. **`CacheRequest` too chat-centric — embeddings / `responses.create` / agent tool-calls have no `messages`.**
   *Agreed.* `messages` is now optional and a sibling `input?: unknown` covers everything non-chat. The canonicalizer hashes whichever is provided; passing both throws `CACHE_INVALID_OPTIONS`. Adapters no longer need to smuggle data through `params`, so `invalidate({ prefix })` keeps working.
   *Sections modified:* §2.1 (`CacheRequest` interface and JSDoc), §1 file responsibility for `core/canonical.ts`, §9.1 edge cases (added 4a).

2. **Self-contradiction: docstring says `metadata` is excluded but the default ignore-list only drops `metadata.timestamp`.**
   *Agreed.* Default `WrapOptions.ignoreFields` is now `['id', 'request_id', 'metadata']` (whole subtree). The `CacheRequest.metadata` JSDoc was rewritten to match.
   *Sections modified:* §1 file responsibility for `core/canonical.ts`, §2.1 (`CacheRequest.metadata` JSDoc).

3. **`tryWrap` documented in §2.7 but missing from the `LLMCache` interface.**
   *Agreed.* `tryWrap` and `tryWrapStream` are now first-class members of the interface; their type-test counterparts will catch any future drift on day one.
   *Sections modified:* §2.1 (interface block), §2.7 (already accurate; clarified by interface presence).

4. **`wrapOpenAI` collapses SDK return types to `any`.**
   *Agreed.* The `OpenAILike` bound stays `(...args: any[]) => any` (necessary for structural subtyping against any `openai` SDK version), but `wrapOpenAI<TClient extends OpenAILike>(client: TClient): TClient` returns `TClient` verbatim — call sites keep the SDK's `ChatCompletion` etc., not `any`. `WrapClientOptions<TClient>.skip` and `.ttl` are now generic in `TClient` so callbacks autocomplete against the SDK's request shape.
   *Sections modified:* §2.6 (`wrapOpenAI` and `WrapClientOptions`), §4.3 (typing rationale + type-test note).

5. **No `AbortSignal` story for `wrap()` / `wrapStream()`.**
   *Agreed.* `WrapOptions.signal?: AbortSignal` added with documented semantics for both leader and waiter aborts. Default policy is `'leader-only'` (leader cancellation rejects every waiter, next caller retries fresh); `coalesce.abortPolicy: 'shared'` opts into leader-promotion.
   *Sections modified:* §2.1 (`WrapOptions`, `CacheOptions.coalesce`).

6. **Distributed coalescing in v0.2 is too late — single-flight on multi-pod deploys is broken without it.**
   *Agreed.* Promoted to v0.1 as a hook: `coalesce.lock?: DistributedLock` (default in-process no-op). Reference implementations `redisLock(client)` and `upstashLock({ url, token })` ship from the existing `./storage/redis` and `./storage/upstash` subpaths in v0.1 so enterprise deployments get genuine cluster-wide single-flight on day one.
   *Sections modified:* §2.1 (`coalesce` option, `DistributedLock` interface), §2.2 (lock factories on each storage subpath), §11 v0.1 step 9 + v0.2 backlog rewritten.

7. **Cloudflare Workers writes have no `ctx.waitUntil()` plumbing.**
   *Agreed.* `cloudflareKVStorage(kv, { ctx?: ExecutionContext })` accepts an `ExecutionContext`; writes are wrapped in `ctx.waitUntil(...)` when present. Additionally, `Cache.flush(): Promise<void>` lets users `await cache.flush()` before returning a `Response` if they prefer not to thread `ctx` through.
   *Sections modified:* §2.1 (`Cache.flush`), §2.2 (`cloudflareKVStorage` options).

8. **Streaming envelope has no serializer fingerprint — replay can silently feed garbage into a wrong deserializer.**
   *Agreed.* `ChunkSerializer<T>` now requires `readonly id: string`; the streaming envelope stamps `meta.serializerId`; replay refuses on mismatch with `STREAM_REPLAY_FAILED` (treated as a miss). Added `STREAM_SERIALIZER_MISMATCH` to the `ErrorCode` union for diagnostics.
   *Sections modified:* §1 file responsibility for `core/envelope.ts`, §2.5 (`ChunkSerializer`), §5.1 (`ErrorCode`), §9.4 case 32.

### Medium-severity

9. **pgvector promised in the report scope, missing from v0.1 file map.**
   *Agreed.* Added `src/storage/postgres.ts` (Postgres + pgvector adapter, Node-only, lazy import of `pg` or `postgres`). Capability `vectorSearch === true` when `vectorColumn` is set so the semantic layer routes to native ANN. Added to the file tree, file-responsibility table, tests, bundle table, tsup config, externals, peer deps, and `package.json#exports`.
   *Sections modified:* §1 (file tree, responsibility table, tests), §2.2 (`postgresStorage`), §6.1 (bundle table), §6.3 (tsup), §7.2 (peer deps), `package.json` (description, keywords, exports, peers, devDeps).

10. **Default semantic `threshold: 0.94` is borderline — confidently wrong is the worst UX outcome.**
    *Agreed.* Default raised to `0.95`. JSDoc documents that 0.92–0.94 is opt-in for FAQ-style bots and < 0.92 is a foot-gun.
    *Sections modified:* §2.3 (example + `SemanticOptions.threshold` JSDoc).

11. **Multimodal content silently dropped from `extractText` — vision apps would conflate visually-different requests.**
    *Agreed.* Default `extractText` now THROWS `EmbeddingError(EMBEDDING_REQUEST_FAILED)` when message content arrays contain non-text parts; users wanting vision-aware semantic caching must supply a custom `extractText` that incorporates per-image hashes. Documented with an example.
    *Sections modified:* §2.3 (`SemanticOptions.extractText` JSDoc with example), §9.6 case 52.

12. **`ErrorCode` reuses `WEB_CRYPTO_UNAVAILABLE` for missing `ReadableStream.tee()`.**
    *Agreed.* Added `STREAM_API_UNAVAILABLE` to the `ErrorCode` union. §9.9 case 67 rewritten.
    *Sections modified:* §5.1 (`ErrorCode`), §9.9 case 67.

13. **`cacheHandler` (Hono) vs `cacheMiddleware` (Express, AI SDK) — Hono's official term is also "middleware".**
    *Agreed.* Renamed Hono's export `cacheHandler` → `cacheMiddleware` everywhere.
    *Sections modified:* §1 (file tree, responsibility table), §2.6 (Hono example, signature).

14. **Tenancy is namespace-by-convention; easy to misconfigure across tenants.**
    *Agreed.* Added `CacheOptions.keyPolicy?: (request) => string` for programmatic per-request namespace derivation (e.g. `tenant:${req.metadata.tenantId}`); throws `CONFIG_INVALID_NAMESPACE` if it returns empty so a missing tenant id fails loudly. Documented `namespace` as required-when-shared and added a "Secure-defaults checklist" callout at the top of §2.1.
    *Sections modified:* §2.1 (top-of-section callout, `CacheOptions.namespace` + new `keyPolicy`).

15. **No encryption-at-rest hook for shared-storage scenarios.**
    *Agreed.* Added `transformAtRest?: TransformAtRest` option to every shipped storage adapter (Redis, Upstash, Cloudflare KV, Vercel KV, SQLite, Postgres). Defined `TransformAtRest` (a paired `encode`/`decode` over `Uint8Array`) so consumers can plug in AES-GCM-with-KMS without forking. Per-adapter rather than core-wide so backends with native at-rest encryption pay no overhead.
    *Sections modified:* §2.2 (each storage signature + new "Encryption / transform at rest" subsection).

### Low-severity

16. **`embeddings/openai` listed as peer dep but described as REST-direct — same nit for `cohere-ai`.**
    *Agreed.* The peer-dep table in §7.2 now explicitly labels each peer as "Runtime peer" or "Types-only peer", and `openai`/`cohere-ai` for embeddings are tagged as types-only with the rationale (we hit REST via `fetch`; the entry exists for IntelliSense only).
    *Sections modified:* §7.2.

17. **`LLMCache` interface name boxes us in — half the use cases aren't strictly LLM responses.**
    *Agreed.* Renamed the canonical interface to `Cache`; `LLMCache` is exported as a `type LLMCache = Cache` alias. `createCache(...)` returns `Cache`; both names are in the root barrel for SEO and intent at the call site.
    *Sections modified:* §1 (root barrel responsibility, `core/cache.ts` responsibility), §2.1 (`Cache` interface JSDoc + `createCache` return type + alias export).

### What we did not change

Nothing — every reviewer concern resulted in a substantive plan change. Mykhailo's verdict moves the v0.1 design from "impressive but with correctness/DX gaps" to "ready to start writing source files in the next phase". The next phase will implement the modules in the order listed in §11 v0.1, starting with `internal/digest` + `internal/canonical-json` + `errors/*`.
