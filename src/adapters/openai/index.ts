/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import type { ChunkSerializer } from '../../types/stream.js';
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

export interface WrapClientOptions<TClient extends OpenAILike = OpenAILike> {
  readonly cache: Cache;
  /** Sub-namespace mixed into the cache key in addition to the cache's global namespace. */
  readonly namespace?: string;
  /**
   * Skip caching for requests where this returns true. Generic in `TClient`
   * so callbacks autocomplete against the SDK's `ChatCompletionCreateParams`.
   */
  readonly skip?: <TReq extends Parameters<TClient['chat']['completions']['create']>[0]>(
    request: TReq,
  ) => boolean;
  /** TTL override per request; either a number or a callback. */
  readonly ttl?:
    | number
    | (<TReq extends Parameters<TClient['chat']['completions']['create']>[0]>(request: TReq) => number);
}

/**
 * Wrap an OpenAI client with caching. Returns a `Proxy` with the **exact
 * same type** as the input client, preserving all SDK return types verbatim.
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
  const existing = (client as unknown as Record<symbol, boolean>)[WRAPPED];
  if (existing) return client;

  const cache = options.cache;
  const namespace = options.namespace;

  const resolveTtl = (request: unknown): number | undefined => {
    if (typeof options.ttl === 'number') return options.ttl;
    if (typeof options.ttl === 'function') return options.ttl(request as never);
    return undefined;
  };
  const shouldSkip = (request: unknown): boolean => {
    if (!options.skip) return false;
    return options.skip(request as never);
  };

  const wrapChat = (originalCreate: (...args: any[]) => any): ((...args: any[]) => any) =>
    function wrappedCreate(this: unknown, params: Record<string, unknown>, ...rest: unknown[]) {
      const isStream = params['stream'] === true;
      if (shouldSkip(params)) return originalCreate.call(this, params, ...rest);

      const req: CacheRequest = buildRequest(params, namespace, options.namespace);
      const ttl = resolveTtl(params);
      if (isStream) {
        const wrapOpts: { serializer: ChunkSerializer<OpenAIStreamChunk>; ttl?: number } = {
          serializer: openAIStreamSerializer,
        };
        if (ttl !== undefined) wrapOpts.ttl = ttl;
        return cache.wrapStream<OpenAIStreamChunk>(
          req,
          () => originalCreate.call(this, params, ...rest) as Promise<ReadableStream<OpenAIStreamChunk>>,
          wrapOpts,
        );
      }
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => originalCreate.call(this, params, ...rest), wrapOpts);
    };

  const wrapEmbeddings = (originalCreate: (...args: any[]) => any): ((...args: any[]) => any) =>
    function wrappedCreate(this: unknown, params: Record<string, unknown>, ...rest: unknown[]) {
      if (shouldSkip(params)) return originalCreate.call(this, params, ...rest);
      const req: CacheRequest = {
        model: typeof params['model'] === 'string' ? params['model'] : 'unknown',
        input: params['input'],
        ...(namespace ? { namespace } : {}),
      };
      const ttl = resolveTtl(params);
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => originalCreate.call(this, params, ...rest), wrapOpts);
    };

  const wrapResponses = (originalCreate: (...args: any[]) => any): ((...args: any[]) => any) =>
    function wrappedCreate(this: unknown, params: Record<string, unknown>, ...rest: unknown[]) {
      if (shouldSkip(params)) return originalCreate.call(this, params, ...rest);
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
          () => originalCreate.call(this, params, ...rest) as Promise<ReadableStream<OpenAIStreamChunk>>,
          wrapOpts,
        );
      }
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => originalCreate.call(this, params, ...rest), wrapOpts);
    };

  const original = {
    chatCreate: client.chat.completions.create.bind(client.chat.completions),
    embeddingsCreate: client.embeddings?.create?.bind(client.embeddings),
    responsesCreate: client.responses?.create?.bind(client.responses),
  };

  client.chat.completions.create = wrapChat(original.chatCreate) as TClient['chat']['completions']['create'];
  if (client.embeddings && original.embeddingsCreate) {
    client.embeddings.create = wrapEmbeddings(original.embeddingsCreate) as NonNullable<TClient['embeddings']>['create'];
  }
  if (client.responses && original.responsesCreate) {
    client.responses.create = wrapResponses(original.responsesCreate) as NonNullable<TClient['responses']>['create'];
  }
  Object.defineProperty(client, WRAPPED, { value: true, enumerable: false });
  return client;
}

function buildRequest(
  params: Record<string, unknown>,
  namespace: string | undefined,
  _localNamespace: string | undefined,
): CacheRequest {
  const model = typeof params['model'] === 'string' ? params['model'] : 'unknown';
  const messages = params['messages'];
  const restParams: Record<string, unknown> = {};
  for (const k of Object.keys(params)) {
    if (k === 'model' || k === 'messages' || k === 'tools' || k === 'stream' || k === 'stream_options') continue;
    restParams[k] = params[k];
  }
  const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
    model,
    params: restParams,
  };
  if (Array.isArray(messages)) out.messages = messages as NonNullable<CacheRequest['messages']>;
  if (Array.isArray(params['tools'])) out.tools = params['tools'] as NonNullable<CacheRequest['tools']>;
  if (namespace) out.namespace = namespace;
  return out;
}

export type { OpenAILike, OpenAIStreamChunk } from './types.js';
