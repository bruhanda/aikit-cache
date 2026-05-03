# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-03

Initial public release.

### Added

- **`createCache()`** — type-safe cache factory with `wrap`, `wrapStream`, `tryWrap`, `tryWrapStream`, `get`, `set`, `delete`, `invalidate`, `clear`, `stats`, `resetStats`, `on`, `flush`, `dispose`.
- **Canonical request hashing** — sorted keys, normalized whitespace, configurable `ignoreFields`, versioned envelope (`v: 1`) for forward compatibility.
- **Exact-match cache** with per-model TTL, per-namespace TTL, sliding TTL with `maxAgeMs` cap, and configurable jitter (default 10%).
- **Semantic cache** (opt-in) — `withSemantic()` with cosine similarity threshold, top-K retrieval, custom `extractText` and `rerank` hooks.
- **Streaming-aware replay** — `wrapStream` tees upstream chunks, captures atomically (nothing cached on mid-stream error), replays with `'preserve'` / `'instant'` / numeric cadence. Serializer `id` is checked on replay to refuse cross-version drift.
- **In-flight single-flight coalescing** — local `Coalescer` collapses concurrent identical requests; pluggable `DistributedLock` extends it across pods.
- **Programmatic invalidation** — by `key`, `prefix`, `tag`, or `predicate`; backends route to the most efficient native operation.
- **Cost tracker** — opt-in `defaultCostTracker` exported from `@aikit/cache/cost` ships built-in pricing for OpenAI, Anthropic, Cohere, and others, plus `registerModel` / `unregisterModel` / `listModels` for overrides.
- **Statistics** — `cache.stats()` returns hits, misses, hit rate, errors, coalesced requests, saved input/output tokens, `savedUSD`, `embeddingCostUSD`, `netSavedUSD`, and a per-model breakdown.
- **Events** — typed listeners for `hit`, `miss`, `set`, `evict`, `error`, `coalesce` with payload narrowing by event name.
- **Storage adapters**
  - `memoryStorage` — in-process LRU with byte-size accounting and lazy TTL eviction.
  - `multiTierStorage` — read-through, write-through L1+L2 composition with backfill of upper tiers on lower-tier hits.
  - `redisStorage` + `redisLock` — `ioredis`-compatible client; `SCAN`+`DEL` prefix invalidation; Redis sets for tag indices.
  - `upstashStorage` + `upstashLock` — REST or client-based; same shape as Redis.
  - `cloudflareKVStorage` — Workers-native; `expirationTtl`, prefix `list`, optional `ctx.waitUntil` integration.
  - `vercelKVStorage` — legacy `@vercel/kv` client.
  - `sqliteStorage` — `better-sqlite3`-shaped database; tagged invalidation; deterministic `clock` injection.
  - `postgresStorage` — `pg` / `postgres` clients; optional pgvector column for native vector search.
  - Optional `transformAtRest` hook on every backend for at-rest encryption / compression.
- **Embedding providers** — `openaiEmbeddings`, `cohereEmbeddings`, `voyageEmbeddings`, `customEmbeddings`, plus `withBatching` wrapper for request coalescing.
- **Framework adapters**
  - `wrapOpenAI` — `Proxy` that preserves the SDK type, intercepts `chat.completions.create`, `embeddings.create`, `responses.create` (stream + non-stream).
  - `wrapAnthropic` — `Proxy` that preserves the SDK type, intercepts `messages.create` (stream + non-stream) and `messages.stream`.
  - `cacheMiddleware` for **Vercel AI SDK** v3 — implements both `wrapGenerate` and `wrapStream`.
  - `LangChainCache` — drop-in for `RedisCache` / `UpstashRedisCache`, structurally typed (no `@langchain/core` runtime dependency).
  - `cacheMiddleware` for **Hono** with `X-Cache: HIT` header.
  - `cacheMiddleware` for **Express** with `res.json` / `res.send` interception.
  - `withCache` for **Next.js** Route Handlers.
- **Errors** — `CacheError` base with stable `code` literal union, plus typed subclasses `ConfigError`, `StorageError`, `EmbeddingError`, `StreamError`, `InvalidationError`, `CostError`, `WebCryptoUnavailableError`.
- **`Result<T, E>`** discriminated union with `isOk` / `isErr` / `ok` / `err` for non-throwing flows.
- **Tree-shakeable subpaths** — root, `./errors`, `./cost`, `./semantic`, `./storage`, `./storage/<backend>`, `./embeddings/<provider>`, `./adapters/<framework>`. Root is zero-dep.
- **Runtime support** — Node.js 18.17+, Bun, Deno, modern browsers, Cloudflare Workers, Vercel Edge Runtime.

[0.1.0]: https://github.com/j09822475-dev/aikit-cache/releases/tag/v0.1.0
