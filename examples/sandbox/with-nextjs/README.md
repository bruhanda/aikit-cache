# with-nextjs — @aikit/cache sandbox

`withCache()` wrapping a Next.js Route Handler — drop-in caching for
`app/api/.../route.ts`.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/bruhanda/aikit-cache/tree/main/examples/sandbox/with-nextjs)

## Run locally

```bash
npm install
npm start
```

## Expected output

```
1st call: ~330 ms, X-Cache=(none — MISS), content="Stub reply to: Hello, Next.js!"
2nd call: ~1 ms,   X-Cache=HIT,            content="Stub reply to: Hello, Next.js!"

upstream invocations: 1 (expected 1 — the second came from cache)
```

The adapter accepts any `(req: Request) => Response | Promise<Response>`
and preserves the handler's exact type. In a real Next.js app this lives
at `app/api/chat/route.ts`:

```ts
import { withCache } from '@aikit/cache/adapters/next';
import { cache } from '@/lib/cache';

export const POST = withCache(
  async (req) => Response.json(await openai.chat.completions.create(await req.json())),
  { cache, ttl: 3_600_000 },
);
```

The sandbox drives the wrapped handler with `Request` / `Response` from
the Web Fetch API, so it runs anywhere Node 18.17+ runs — no Next.js
dev server required. No API keys needed.
