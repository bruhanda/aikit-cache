/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import type { ChunkSerializer } from '../../types/stream.js';
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
  readonly skip?: <TReq extends Parameters<TClient['messages']['create']>[0]>(request: TReq) => boolean;
  readonly ttl?:
    | number
    | (<TReq extends Parameters<TClient['messages']['create']>[0]>(request: TReq) => number);
}

/**
 * Wrap an Anthropic SDK client. Intercepts `messages.create` (both stream
 * and non-stream) while preserving the SDK's exact return types.
 *
 * @param client An Anthropic SDK client instance.
 * @param options Cache plus optional namespace / skip / ttl.
 * @returns The same client, methods replaced with cache-aware versions.
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
  const shouldSkip = (request: unknown): boolean => (options.skip ? options.skip(request as never) : false);

  const original = {
    create: client.messages.create.bind(client.messages),
    stream: client.messages.stream?.bind(client.messages),
  };

  const wrapCreate = (...args: unknown[]): unknown => {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    if (shouldSkip(params)) return original.create(...args);
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
        () => original.create(...args) as Promise<ReadableStream<AnthropicStreamEvent>>,
        wrapOpts,
      );
    }
    const wrapOpts: { ttl?: number } = {};
    if (ttl !== undefined) wrapOpts.ttl = ttl;
    return cache.wrap(req, () => original.create(...args), wrapOpts);
  };

  client.messages.create = wrapCreate as TClient['messages']['create'];

  if (original.stream) {
    const wrapStreamMethod = (...args: unknown[]): unknown => {
      const params = (args[0] ?? {}) as Record<string, unknown>;
      if (shouldSkip(params)) return original.stream!(...args);
      const req = buildRequest(params, namespace);
      const ttl = resolveTtl(params);
      const wrapOpts: { serializer: ChunkSerializer<AnthropicStreamEvent>; ttl?: number } = {
        serializer: anthropicStreamSerializer,
      };
      if (ttl !== undefined) wrapOpts.ttl = ttl;
      return cache.wrapStream<AnthropicStreamEvent>(
        req,
        () => original.stream!(...args) as Promise<ReadableStream<AnthropicStreamEvent>>,
        wrapOpts,
      );
    };
    client.messages.stream = wrapStreamMethod as NonNullable<TClient['messages']['stream']>;
  }

  Object.defineProperty(client, WRAPPED, { value: true, enumerable: false });
  return client;
}

function buildRequest(params: Record<string, unknown>, namespace: string | undefined): CacheRequest {
  const model = typeof params['model'] === 'string' ? params['model'] : 'unknown';
  const messages = params['messages'];
  const restParams: Record<string, unknown> = {};
  for (const k of Object.keys(params)) {
    if (k === 'model' || k === 'messages' || k === 'tools' || k === 'stream') continue;
    restParams[k] = params[k];
  }
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
