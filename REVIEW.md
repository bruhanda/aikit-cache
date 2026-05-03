# Response to code review (Mykhailo Kryvytskyi)

Every numbered point below maps 1:1 to the review. Every concern was acted on. Tests are intentionally untouched — that's the next phase.

---

## 1. [critical] `tryWrap` mis-tagged live LLM errors as `StorageError`

**Concern:** `tryWrap` / `tryWrapStream` caught everything and routed it through `wrapError`, which always produced a `StorageError('STORAGE_BACKEND_UNAVAILABLE', …)`. PLAN §5.2 says live errors thrown by `fn()` are **always propagated**, so an OpenAI 429 raised inside `fn()` was being mis-attributed to the cache backend.

**Files:** `src/core/cache.ts`, `src/core/types.ts`.

**Fix:** `tryWrap` and `tryWrapStream` now only put `CacheError` instances into `Result.err`. Anything else (live provider errors) re-throws unchanged. Updated the JSDoc on both methods so the contract matches behavior.

---

## 2. [critical] Semantic layer's `onlyOnMiss` boolean was inverted

**Concern:** `if (!onlyOnMiss) return { hit: false }` permanently disabled semantic lookup whenever the option was set to `false` — the inverse of the documented behavior.

**Files:** `src/semantic/layer.ts`.

**Fix:** Dropped the broken early return per the reviewer's recommendation. `lookup` is only invoked from `wrap()` after an exact miss anyway, so the post-miss path is `onlyOnMiss: true`-equivalent (the documented default). Added a comment recording that `onlyOnMiss: false` (pre-miss lookup) is reserved for follow-up. Removed the unused local destructure.

---

## 3. [critical] Hono / Express middleware never wrote to the cache on miss

**Concern:** Both adapters built `setOpts` and then `void`'d it. `cache.set(...)` was never called, so the middleware degraded to read-only.

**Files:** `src/adapters/hono/index.ts`, `src/adapters/express/index.ts`, plus the new `src/adapters/_shared/extract.ts`.

**Fix (Hono):** Now reads `c.res` after `next()`, clones it, and calls `cache.set(req, body)` when the response is a successful JSON body. Adds `X-Cache: HIT` on hits. Promoted `c.res` to a non-`readonly` field on `HonoContextLike`.

**Fix (Express):** Monkey-patches `res.json` and `res.send` after the lookup miss; persists the body to the cache before forwarding to the original method. Status code <200 or ≥300 short-circuits the write.

---

## 4. [critical] Distributed lock acquired before the local coalescer

**Concern:** With 50 concurrent in-process callers and a real `redisLock`, the previous order issued 50 `SET … NX PX` round-trips for one hot key.

**Files:** `src/core/cache.ts`.

**Fix:** Inverted the order in `wrap()` — the local coalescer runs first, and only the leader acquires the cross-process lock. Per-pod waiters are now free, while cluster-wide single-flight is preserved. Added a comment documenting the invariant.

---

## 5. [high] `Coalescer.dedupe` discarded a chained promise that mirrored rejection

**Concern:** `promise.finally(...)` returns a chained promise that mirrors rejection. Discarding it produced an `UnhandledPromiseRejection` warning whenever `fn()` rejected.

**Files:** `src/core/coalesce.ts`.

**Fix:** The chained handle from `.finally()` is now caught with `.catch(() => {})` so the cleanup chain does not surface as unhandled. Waiters still observe the original `promise`.

---

## 6. [high] Root `core/cache.ts` statically pulled the entire pricing table

**Concern:** `import { computeCost } from '../cost/tracker.js'` and `import { getPricing } from '../cost/pricing-registry.js'` transitively dragged `builtInPricing` into the root subpath bundle, which would blow the 8 KB cap (PLAN §6.1) and violate the §3.1 rule that `core/*` does not depend on `cost/*`.

**Files:** `src/core/types.ts`, `src/core/cache.ts`, `src/cost/index.ts`, `src/index.ts`, `src/semantic/types.ts`, `src/semantic/layer.ts`.

**Fix:** Defined a `CostTracker` interface in `core/types.ts` (`estimateUSD(model, usage): number`). Replaced `costTracking?: boolean` with `costTracker?: CostTracker` on `CacheOptions`. The core only knows the interface; users opt in by importing `defaultCostTracker` from the new `@aikit/cache/cost` export. Re-exported `CostTracker` from the root barrel for type-only consumers.

The same `cost/*` import existed in `semantic/layer.ts`; addressed it the same way (added `costTracker?: CostTracker` to `SemanticOptions`). Verified post-build: `dist/index.js` no longer contains any pricing string; `builtInPricing` lives only in `dist/cost/index.js`.

---

## 7. [high] `options.semantic._install(undefined as Cache, …)` was a footgun

**Concern:** Casting `undefined` to `Cache` and handing it to `_install` would NPE without diagnostic at the first `cache.get` access from a future semantic implementation.

**Files:** `src/core/types.ts`, `src/semantic/layer.ts`, `src/core/cache.ts`.

**Fix:** Changed the `SemanticLayer._install` signature to `(getCache: () => Cache, storage: CacheStorage) => SemanticLayerHandle`. The cache builds normally and assigns `cacheRef = cache` before returning; the lazy getter throws a `ConfigError(CACHE_INVALID_OPTIONS)` with a precise message if any future implementation calls it during `_install` itself. Updated the layer to capture the lazy getter.

---

## 8. [high] OpenAI / Anthropic adapters mutated the SDK client in place

**Concern:** Re-assigning `client.chat.completions.create = wrappedCreate` broke users who shared an `OpenAI` instance from a module (their unwrapped reference also became wrapped) and prevented two `wrapOpenAI` calls with different namespaces. PLAN §2.6 / §3.4 mandates a `Proxy<OpenAI>`.

**Files:** `src/adapters/openai/index.ts`, `src/adapters/anthropic/index.ts`.

**Fix:** Both adapters now return a `new Proxy(client, …)` with nested proxies on `chat`/`completions`, `embeddings`, `responses`, `messages`. The original client is untouched, so `instanceof OpenAI` keeps working and two wrappers with different namespaces over the same client are independent. The `WRAPPED` symbol idempotency check stays in place; double-wrapping returns the original client.

---

## 9. [medium] `Date.now()` bypassed the injected `Clock` in storage adapters; jitter used `Math.random` directly

**Concern:** PLAN §3.4 lists `clock` as a strategy-injection point precisely so deterministic TTL tests can advance time. `multi-tier`, `postgres`, `sqlite`, and `core/ttl.applyJitter` ignored it.

**Files:** `src/storage/multi-tier.ts`, `src/storage/postgres.ts`, `src/storage/sqlite.ts`, `src/core/ttl.ts`, `src/core/cache.ts`, `src/core/types.ts`.

**Fix:**
- `multiTierStorage`, `postgresStorage`, `sqliteStorage` now accept `clock?: { now(): number }` in their options. All `Date.now()` call sites moved to the injected `now()`.
- `applyJitter` gained a third argument `rng: () => number = Math.random`.
- `CacheOptions` gained `rng?: () => number`. `createCache` plumbs it to every `applyJitter` call.

Tests can now hand the same `clock` to both `createCache` and the storage adapter for fully deterministic expiry.

---

## 10. [medium] `core/stream.ts` duplicated `bytesToBase64Url` / `base64UrlToBytes`; embedding adapters duplicated `normalize()`

**Concern:** Same code, three copies (or four), drifts independently.

**Files:** `src/core/stream.ts`, `src/internal/vector.ts` (new), `src/embeddings/openai.ts`, `src/embeddings/cohere.ts`, `src/embeddings/voyage.ts`, `src/semantic/similarity.ts`.

**Fix:**
- `core/stream.ts` deletes its private base64url helpers and imports `toBase64Url` / `fromBase64Url` from `internal/encoding.ts`.
- New `internal/vector.ts` exports `normalizeVector`. The three embedding providers (OpenAI, Cohere, Voyage) now import it instead of redefining `normalize` inline.
- `semantic/similarity.ts` re-exports `normalize = normalizeVector` so the public semantic surface still has the symbol but the implementation is single-source.

I considered importing from `semantic/similarity.ts` directly (the reviewer's suggestion) but that would have made `embeddings/*` depend on `semantic/*`, which violates §3.1 layering rules. Routing through `internal/vector.ts` keeps both layers clean.

---

## 11. [medium] `defaultExtract` / `extractParams` were copy-pasted across HTTP adapters; `buildRequest` between OpenAI/Anthropic

**Concern:** A fix to one is supposed to be a fix to all.

**Files:** `src/adapters/_shared/extract.ts` (new), `src/adapters/hono/index.ts`, `src/adapters/express/index.ts`, `src/adapters/next/index.ts`, `src/adapters/openai/index.ts`, `src/adapters/anthropic/index.ts`.

**Fix:**
- New `src/adapters/_shared/extract.ts` exports `extractCacheRequestFromBody(body)` (the universal `{ model, messages|input, tools, ...params }` shape) and `extractParams(body)` (strips routing keys).
- All three HTTP adapters delegate to `extractCacheRequestFromBody`.
- The OpenAI and Anthropic SDK adapters' `buildRequest` helpers now call `extractParams` from the shared module.

Anthropic's `buildRequest` still has its own thin layer because it uniquely treats `system` as a hashable param; the body-shape extraction is shared.

---

## 12. [medium] `request.namespace = ''` silently dropped into the global keyspace

**Concern:** The reviewer asked for the same `length > 0` check on `request.namespace` that already existed for `keyPolicy`.

**Files:** `src/core/cache.ts`.

**Fix:** `resolveNamespace` now throws `ConfigError(CONFIG_INVALID_NAMESPACE)` when `request.namespace` is the empty string. Same diagnostic phrasing as the `keyPolicy` check.

---

## 13. [medium] Cloudflare KV silently rounded sub-60s TTLs up

**Concern:** PLAN §9.5 case 19 explicitly asks for a one-time warning so users debugging "why is my 5s TTL acting like 60s" find the answer fast.

**Files:** `src/storage/cloudflare-kv.ts`.

**Fix:** Closure-scoped `warnedMinTtl` boolean. The first time `enforceMin` rounds a sub-60s TTL up, the adapter calls `console.warn` with the actual TTL, the rounded TTL, and the opt-out flag. Subsequent rounds stay silent.

---

## 14. [medium] `canonicalJSON` cycle-vs-DAG behavior — please add a test

**Concern:** The reviewer concluded the implementation is correct but asked for a regression test on the "same `Object.freeze({a:1})` reference appearing twice in the request" case.

**Files:** _none — declined for this PR_.

**Rationale:** The instruction in this PR was "Do NOT touch tests yet — that is the next phase." I'll add the regression test in the test PR. Logging it here so it doesn't fall off the radar.

---

## 15. [low] Redundant `(async () => fn())()` wrapper in `Coalescer.dedupe`

**Files:** `src/core/coalesce.ts`.

**Fix:** Replaced with `Promise.resolve().then(fn)` — equivalent microtask ordering, less noise.

---

## 16. [low] `WrapClientOptions.skip`'s generic was per-call instead of per-options

**Concern:** Lifting the `TReq` generic to the interface lets TypeScript infer the SDK's `ChatCompletionCreateParams` type into the callback.

**Files:** `src/adapters/openai/index.ts`, `src/adapters/anthropic/index.ts`.

**Fix:** `skip` and `ttl`'s callback signatures now use `Parameters<TClient['chat']['completions']['create']>[0]` (or the Anthropic equivalent) directly — no per-call generic, so callers get autocompletion against the SDK's concrete request type.

---

## What I verified

- `npm run typecheck` clean.
- `npm run build` clean.
- `dist/index.js` (root subpath) — no `builtInPricing` / model-name strings present.
- `dist/cost/index.js` — pricing snapshot intact, `defaultCostTracker` exported.
- Lint script can't run (no eslint config in repo) — pre-existing condition, not introduced by this change.

Tests intentionally not run; they live in the next phase per the brief.
