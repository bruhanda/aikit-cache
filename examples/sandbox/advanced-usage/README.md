# advanced-usage — @aikit/cache sandbox

Production-shaped demo covering multi-tier storage, semantic match,
single-flight coalescing, tag invalidation, and dollar-denominated
savings tracking.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/bruhanda/aikit-cache/tree/main/examples/sandbox/advanced-usage)

## Run locally

```bash
npm install
npm start
```

## What it shows

1. **Exact-match** — second identical call returns from cache.
2. **Semantic match** — a deterministic mock embedding provider matches
   paraphrases (e.g. *"How do I cancel a subscription?"* ↔ *"How can I
   cancel my subscription?"*) above a 0.8 cosine threshold.
3. **Single-flight coalescing** — 50 concurrent identical calls collapse
   to **one** upstream call.
4. **Tag invalidation** — `cache.invalidate({ tag: 'model:gpt-4o' })`
   removes everything tagged with that label.
5. **Stats** — hits, misses, hit rate, **savedUSD**, embedding cost,
   net savings, per-model breakdown.

No API keys are required. Replace the `fakeChat` / `customEmbeddings`
calls with real OpenAI or Anthropic clients to hook into production
traffic.
