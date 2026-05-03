import type { CacheRequest } from '../../core/types.js';

/**
 * Build a `CacheRequest` from a parsed JSON body that follows the universal
 * LLM-style shape (`{ model, messages? | input?, tools?, ...params }`).
 * Returns `undefined` when the body is not an object or has no `model`
 * string. Used by every HTTP adapter (Hono, Express, Next) so a single
 * change here updates every middleware.
 */
export function extractCacheRequestFromBody(
  body: unknown,
): CacheRequest | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b['model'] !== 'string') return undefined;
  const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
    model: b['model'],
    params: extractParams(b),
  };
  if (Array.isArray(b['messages'])) {
    out.messages = b['messages'] as NonNullable<CacheRequest['messages']>;
  } else {
    out.input = b;
  }
  if (Array.isArray(b['tools'])) {
    out.tools = b['tools'] as NonNullable<CacheRequest['tools']>;
  }
  return out;
}

/**
 * Strip routing keys (`model`, `messages`, `tools`, `stream`,
 * `stream_options`) so the remainder lands in `CacheRequest.params`. Shared
 * across HTTP and SDK adapters.
 */
export function extractParams(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (
      k === 'model' ||
      k === 'messages' ||
      k === 'tools' ||
      k === 'stream' ||
      k === 'stream_options'
    ) {
      continue;
    }
    params[k] = body[k];
  }
  return params;
}
