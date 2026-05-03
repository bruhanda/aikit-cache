# with-hono — @aikit/cache sandbox

`@aikit/cache` Hono middleware in front of a `/v1/chat/completions`
route. Works on Node, Bun, Deno, Cloudflare Workers, and Vercel Edge.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/bruhanda/aikit-cache/tree/main/examples/sandbox/with-hono)

## Run locally

```bash
npm install
npm start
```

## Expected output

```
1st call: ~330 ms, X-Cache=null,  content="Stub reply to: Hello, Hono!"
2nd call: ~1 ms,   X-Cache=HIT,   content="Stub reply to: Hello, Hono!"
3rd call: ~1 ms,   X-Cache=HIT,   content="Stub reply to: Hello, Hono!"

upstream invocations: 1 (expected 1 — the other 2 came from cache)
```

The middleware sets `X-Cache: HIT` on cache hits and lets the request
fall through on misses. The route handler is a stub LLM, so no API keys
are required — swap it for a real OpenAI / Anthropic call to use it in
production.
