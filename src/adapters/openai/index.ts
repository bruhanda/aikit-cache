/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import type { ChunkSerializer } from '../../types/stream.js';
import { extractParams } from '../_shared/extract.js';
import type { OpenAILike, OpenAIStreamChunk } from './types.js';

const WRAPPED = Symbol.for('aikit.cache.wrapped.openai');

/**
 * `ChunkSerializer` for OpenAI streaming chat completions. Stamped with the
 * stable `id` `'openai-stream-v1'` — replay refuses on serializer-id mismatch
 * (see PLAN §9.4 case 32).
 */
export const openAIStreamSerializer: ChunkSerializer<OpenAIStreamChunk> = {
  id: 'openai-stream-v1',
  serialize(chunks) {
    return JSON.stringify(chunks);
  },
  deserialize(data) {
    const json = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const parsed = JSON.parse(json) as readonly OpenAIStreamChunk[];
    return parsed;
  },
};

/**
 * Options for {@link wrapOpenAI}. The `TClient` generic flows through
 * `skip`/`ttl` so callbacks autocomplete against the user's installed
 * `openai` SDK version.
 */
export interface WrapClientOptions<TClient extends OpenAILike = OpenAILike> {
  readonly cache: Cache;
  /** Sub-namespace mixed into the cache key in addition to the cache's global namespace. */
  readonly namespace?: string;
  /** Skip caching for requests where this returns true. */
  readonly skip?: (request: Parameters<TClient['chat']['completions']['create']>[0]) => boolean;
  /** TTL override per request; either a number or a callback. */
  readonly ttl?:
    | number
    | ((request: Parameters<TClient['chat']['completions']['create']>[0]) => number);
}

/**
 * Wrap an OpenAI client with caching. Returns a `Proxy` with the **exact
 * same type** as the input client, preserving all SDK return types verbatim
 * and keeping `instanceof OpenAI` working. The original client is **not**
 * mutated — calling `wrapOpenAI(client, ...)` twice with different
 * namespaces yields two independent wrappers over the same client.
 *
 * Intercepted methods:
 *   - `chat.completions.create({ stream: false })` → exact-match cache.
 *   - `chat.completions.create({ stream: true })`  → streaming cache.
 *   - `embeddings.create()`                        → exact-match cache (`input` field).
 *   - `responses.create({ stream?: })`             → both modes.
 *
 * @param client A real `openai` SDK client.
 * @param options Cache to forward to plus optional skip / ttl overrides.
 * @returns A typed Proxy preserving the SDK shape.
 *
 * @example
 * import OpenAI from 'openai';
 * const openai = wrapOpenAI(new OpenAI(), { cache });
 * await openai.chat.completions.create({ model: 'gpt-4o', messages });
 */
export function wrapOpenAI<TClient extends OpenAILike>(
  client: TClient,
  options: WrapClientOptions<TClient>,
): TClient {
  if (!options?.cache) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'wrapOpenAI requires a `cache` option', { field: 'cache' });
  }
  if ((client as unknown as Record<symbol, boolean>)[WRAPPED]) return client;

  const cache = options.cache;
  const namespace = options.namespace;

  const resolveTtl = (request: unknown): number | undefined => {
    if (typeof options.ttl === 'number') return options.ttl;
    if (typeof options.ttl === 'function') return options.ttl(request as never);
    return undefined;
  };
  const shouldSkip = (request: unknown): boolean =>
    options.skip ? options.skip(request as never) : false;

  const wrapChatCreate = (
    original: (...args: any[]) => any,
  ): ((this: unknown, params: Record<string, unknown>, ...rest: unknown[]) => unknown) =>
    function wrapped(this: unknown, params: Record<string, unknown>, ...rest: unknown[]) {
      const isStream = params['stream'] === true;
      if (shouldSkip(params)) return original.call(this, params, ...rest);

      const req: CacheRequest = buildRequest(params, namespace);
      const ttl = resolveTtl(params);
      if (isStream) {
        const wrapOpts: { serializer: ChunkSerializer<OpenAIStreamChunk>; ttl?: number } = {
          serializer: openAIStreamSerializer,
        };
        if (ttl !== undefined) wrapOpts.ttl = ttl;
        return cache.wrapStream<OpenAIStreamChunk>(
          req,
          () => original.call(this, params, ...rest) as Promise<ReadableStream<OpenAIStreamChunk>>,
          wrapOpts,
        );
      }
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => original.call(this, params, ...rest), wrapOpts);
    };

  const wrapEmbeddingsCreate = (
    original: (...args: any[]) => any,
  ): ((this: unknown, params: Record<string, unknown>, ...rest: unknown[]) => unknown) =>
    function wrapped(this: unknown, params: Record<string, unknown>, ...rest: unknown[]) {
      if (shouldSkip(params)) return original.call(this, params, ...rest);
      const req: CacheRequest = {
        model: typeof params['model'] === 'string' ? params['model'] : 'unknown',
        input: params['input'],
        ...(namespace ? { namespace } : {}),
      };
      const ttl = resolveTtl(params);
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => original.call(this, params, ...rest), wrapOpts);
    };

  const wrapResponsesCreate = (
    original: (...args: any[]) => any,
  ): ((this: unknown, params: Record<string, unknown>, ...rest: unknown[]) => unknown) =>
    function wrapped(this: unknown, params: Record<string, unknown>, ...rest: unknown[]) {
      if (shouldSkip(params)) return original.call(this, params, ...rest);
      const isStream = params['stream'] === true;
      const req: CacheRequest = {
        model: typeof params['model'] === 'string' ? params['model'] : 'unknown',
        input: params['input'] ?? params['messages'] ?? params,
        ...(namespace ? { namespace } : {}),
      };
      const ttl = resolveTtl(params);
      if (isStream) {
        const wrapOpts: { serializer: ChunkSerializer<OpenAIStreamChunk>; ttl?: number } = {
          serializer: openAIStreamSerializer,
        };
        if (ttl !== undefined) wrapOpts.ttl = ttl;
        return cache.wrapStream<OpenAIStreamChunk>(
          req,
          () => original.call(this, params, ...rest) as Promise<ReadableStream<OpenAIStreamChunk>>,
          wrapOpts,
        );
      }
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => original.call(this, params, ...rest), wrapOpts);
    };

  const completionsProxy = (completions: { create: (...args: any[]) => any }) =>
    new Proxy(completions, {
      get(target, prop, receiver) {
        if (prop === 'create') {
          const original = Reflect.get(target, 'create', receiver) as (...args: any[]) => any;
          return wrapChatCreate(original.bind(target));
        }
        return Reflect.get(target, prop, receiver);
      },
    });

  const chatProxy = new Proxy(client.chat, {
    get(target, prop, receiver) {
      if (prop === 'completions') {
        return completionsProxy(Reflect.get(target, 'completions', receiver));
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const embeddingsProxy = client.embeddings
    ? new Proxy(client.embeddings, {
        get(target, prop, receiver) {
          if (prop === 'create') {
            const original = Reflect.get(target, 'create', receiver) as (...args: any[]) => any;
            return wrapEmbeddingsCreate(original.bind(target));
          }
          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

  const responsesProxy = client.responses
    ? new Proxy(client.responses, {
        get(target, prop, receiver) {
          if (prop === 'create') {
            const original = Reflect.get(target, 'create', receiver) as (...args: any[]) => any;
            return wrapResponsesCreate(original.bind(target));
          }
          return Reflect.get(target, prop, receiver);
        },
      })
    : undefined;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED) return true;
      if (prop === 'chat') return chatProxy;
      if (prop === 'embeddings' && embeddingsProxy) return embeddingsProxy;
      if (prop === 'responses' && responsesProxy) return responsesProxy;
      return Reflect.get(target, prop, receiver);
    },
  }) as TClient;
}

function buildRequest(params: Record<string, unknown>, namespace: string | undefined): CacheRequest {
  const model = typeof params['model'] === 'string' ? params['model'] : 'unknown';
  const messages = params['messages'];
  const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
    model,
    params: extractParams(params),
  };
  if (Array.isArray(messages)) out.messages = messages as NonNullable<CacheRequest['messages']>;
  if (Array.isArray(params['tools'])) out.tools = params['tools'] as NonNullable<CacheRequest['tools']>;
  if (namespace) out.namespace = namespace;
  return out;
}

export type { OpenAILike, OpenAIStreamChunk } from './types.js';
