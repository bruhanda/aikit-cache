/**
 * with-nextjs.ts — @aikit/cache + Next.js Route Handler demo.
 *
 * Run: npm start
 *
 * What it shows:
 *   - withCache() wrapping a Next.js Route Handler `(req: Request) => Response`
 *   - same handler, two identical POSTs — second is served from cache
 *   - X-Cache: HIT response header on the cached response
 *
 * In a real Next.js app this lives at `app/api/chat/route.ts`:
 *
 *   import { withCache } from '@aikit/cache/adapters/next';
 *   export const POST = withCache(async (req) => {
 *     const body = await req.json();
 *     const reply = await openai.chat.completions.create(body);
 *     return Response.json(reply);
 *   }, { cache, ttl: 3_600_000 });
 *
 * For this demo we use the wrapped handler directly with `Request` /
 * `Response` from the Web Fetch API — no Next.js dev server required.
 */
import { createCache } from '@aikit/cache';
import { memoryStorage } from '@aikit/cache/storage';
import { withCache } from '@aikit/cache/adapters/next';

const cache = createCache({
  storage: memoryStorage({ max: 1_000 }),
  ttl: { default: 3_600_000 },
});

let upstreamCalls = 0;

const POST = withCache(
  async (req: Request): Promise<Response> => {
    const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
    upstreamCalls += 1;
    await sleep(300);
    return Response.json({
      id: `cmpl_${upstreamCalls}`,
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `Stub reply to: ${body.messages[body.messages.length - 1]?.content ?? ''}` },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 16, total_tokens: 26 },
    });
  },
  { cache, ttl: 3_600_000 },
);

const requestBody = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello, Next.js!' }],
};

async function callOnce(label: string): Promise<void> {
  const start = Date.now();
  const req = new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const res = await POST(req);
  const ms = Date.now() - start;
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  console.log(`${label}: ${ms} ms, X-Cache=${res.headers.get('X-Cache') ?? '(none — MISS)'}, content="${json.choices[0]!.message.content}"`);
}

await callOnce('1st call');
await callOnce('2nd call');

console.log(`\nupstream invocations: ${upstreamCalls} (expected 1 — the second came from cache)`);

await cache.dispose();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
