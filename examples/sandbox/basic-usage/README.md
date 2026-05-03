# basic-usage — @aikit/cache sandbox

Minimal demo of `@aikit/cache`: in-memory storage, `wrap()`, hit/miss
timings, and `stats()`.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/bruhanda/aikit-cache/tree/main/examples/sandbox/basic-usage)

## Run locally

```bash
npm install
npm start
```

## Expected output

```
miss → ~400 ms — Mock reply to: "What is the capital of France?"
hit  → ~0 ms   — Mock reply to: "What is the capital of France?"
miss → ~400 ms — Mock reply to: "Who wrote The Iliad?"

stats: { hits: 1, misses: 2, hitRate: '33.3%' }
```

The mock LLM call sleeps 400 ms; the second identical request returns
from cache in ~0 ms.
