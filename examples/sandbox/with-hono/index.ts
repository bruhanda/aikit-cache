/**
 * with-hono.ts — @aikit/cache + Hono middleware demo.
 *
 * Run: npm start
 *
 * What it shows:
 *   - cacheMiddleware() in front of a /v1/chat/completions-style route
 *   - first POST is a MISS, second identical POST is a HIT
 *   - X-Cache: HIT|MISS response header
 *
 * The route handler is a stub LLM — no API keys needed. The middleware
 * works the same with a real upstream (OpenAI, Anthropic, your own model).
 *
 * Hono runs anywhere `fetch` exists — Node, Bun, Deno, Cloudflare Workers,
 * Vercel Edge. We use `app.fetch(new Request(...))` to drive it from a
 * plain Node script for demo purposes.
 */
import { Hono } from 'hono';
import { createCache } from '@aikit/cache';
import { memoryStorage } from '@aikit/cache/storage';
import { cacheMiddleware } from '@aikit/cache/adapters/hono';

const cache = createCache({
  storage: memoryStorage({ max: 1_000 }),
  ttl: { default: 60_000 },
});

let upstreamCalls = 0;
async function fakeChatCompletion(model: string, messages: readonly { role: string; content: string }[]): Promise<unknown> {
  upstreamCalls += 1;
  await sleep(300);
  return {
    id: `cmpl_${upstreamCalls}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `Stub reply to: ${messages[messages.length - 1]?.content ?? '(empty)'}` },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 16, total_tokens: 26 },
  };
}

const app = new Hono();

app.post('/v1/chat/completions', cacheMiddleware({ cache, ttl: 60_000 }), async (c) => {
  const body = (await c.req.json()) as { model: string; messages: { role: string; content: string }[] };
  const reply = await fakeChatCompletion(body.model, body.messages);
  return c.json(reply);
});

const requestBody = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello, Hono!' }],
};

async function callOnce(label: string): Promise<void> {
  const start = Date.now();
  const res = await app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }),
  );
  const ms = Date.now() - start;
  const cacheHeader = res.headers.get('X-Cache');
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  console.log(`${label}: ${ms} ms, X-Cache=${cacheHeader}, content="${json.choices[0]!.message.content}"`);
}

await callOnce('1st call');
await callOnce('2nd call');
await callOnce('3rd call');

console.log(`\nupstream invocations: ${upstreamCalls} (expected 1 — the other 2 came from cache)`);

await cache.dispose();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
