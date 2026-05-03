/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import type { ChunkSerializer } from '../../types/stream.js';
import { extractParams } from '../_shared/extract.js';
import type { AnthropicLike, AnthropicStreamEvent } from './types.js';

const WRAPPED = Symbol.for('aikit.cache.wrapped.anthropic');

/**
 * `ChunkSerializer` for Anthropic streaming events. Stamped with the
 * stable id `'anthropic-stream-v1'`.
 */
export const anthropicStreamSerializer: ChunkSerializer<AnthropicStreamEvent> = {
  id: 'anthropic-stream-v1',
  serialize(chunks) {
    return JSON.stringify(chunks);
  },
  deserialize(data) {
    const json = typeof data === 'string' ? data : new TextDecoder().decode(data);
    return JSON.parse(json) as readonly AnthropicStreamEvent[];
  },
};

export interface WrapAnthropicOptions<TClient extends AnthropicLike = AnthropicLike> {
  readonly cache: Cache;
  readonly namespace?: string;
  readonly skip?: (request: Parameters<TClient['messages']['create']>[0]) => boolean;
  readonly ttl?:
    | number
    | ((request: Parameters<TClient['messages']['create']>[0]) => number);
}

/**
 * Wrap an Anthropic SDK client. Returns a `Proxy` with the **exact same
 * type** as the input client; the original is **not** mutated, so two
 * `wrapAnthropic` calls with different namespaces produce independent
 * wrappers, and `instanceof Anthropic` keeps working on both.
 *
 * Intercepts `messages.create` (both stream and non-stream) and
 * `messages.stream` while preserving the SDK's exact return types.
 *
 * @param client An Anthropic SDK client instance.
 * @param options Cache plus optional namespace / skip / ttl.
 * @returns A typed Proxy preserving the SDK shape.
 */
export function wrapAnthropic<TClient extends AnthropicLike>(
  client: TClient,
  options: WrapAnthropicOptions<TClient>,
): TClient {
  if (!options?.cache) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'wrapAnthropic requires a `cache` option', { field: 'cache' });
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

  const wrapCreate = (original: (...args: any[]) => any) =>
    function wrapped(this: unknown, ...args: unknown[]) {
      const params = (args[0] ?? {}) as Record<string, unknown>;
      if (shouldSkip(params)) return original.apply(this, args);
      const isStream = params['stream'] === true;
      const req = buildRequest(params, namespace);
      const ttl = resolveTtl(params);
      if (isStream) {
        const wrapOpts: { serializer: ChunkSerializer<AnthropicStreamEvent>; ttl?: number } = {
          serializer: anthropicStreamSerializer,
        };
        if (ttl !== undefined) wrapOpts.ttl = ttl;
        return cache.wrapStream<AnthropicStreamEvent>(
          req,
          () => original.apply(this, args) as Promise<ReadableStream<AnthropicStreamEvent>>,
          wrapOpts,
        );
      }
      const wrapOpts: { ttl?: number } = {};
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrap(req, () => original.apply(this, args), wrapOpts);
    };

  const wrapStreamMethod = (original: (...args: any[]) => any) =>
    function wrapped(this: unknown, ...args: unknown[]) {
      const params = (args[0] ?? {}) as Record<string, unknown>;
      if (shouldSkip(params)) return original.apply(this, args);
      const req = buildRequest(params, namespace);
      const ttl = resolveTtl(params);
      const wrapOpts: { serializer: ChunkSerializer<AnthropicStreamEvent>; ttl?: number } = {
        serializer: anthropicStreamSerializer,
      };
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrapStream<AnthropicStreamEvent>(
        req,
        () => original.apply(this, args) as Promise<ReadableStream<AnthropicStreamEvent>>,
        wrapOpts,
      );
    };

  const messagesProxy = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop === 'create') {
        const original = Reflect.get(target, 'create', receiver) as (...args: any[]) => any;
        return wrapCreate(original.bind(target));
      }
      if (prop === 'stream') {
        const original = Reflect.get(target, 'stream', receiver) as ((...args: any[]) => any) | undefined;
        if (!original) return undefined;
        return wrapStreamMethod(original.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED) return true;
      if (prop === 'messages') return messagesProxy;
      return Reflect.get(target, prop, receiver);
    },
  }) as TClient;
}

function buildRequest(params: Record<string, unknown>, namespace: string | undefined): CacheRequest {
  const model = typeof params['model'] === 'string' ? params['model'] : 'unknown';
  const messages = params['messages'];
  const restParams = extractParams(params);
  const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
    model,
    params: restParams,
  };
  if (Array.isArray(messages)) out.messages = messages as NonNullable<CacheRequest['messages']>;
  if (Array.isArray(params['tools'])) out.tools = params['tools'] as NonNullable<CacheRequest['tools']>;
  if (typeof params['system'] === 'string') {
    out.params = { ...restParams, system: params['system'] };
  }
  if (namespace) out.namespace = namespace;
  return out;
}

export type { AnthropicLike, AnthropicStreamEvent } from './types.js';
