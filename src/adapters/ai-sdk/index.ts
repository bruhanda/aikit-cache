import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import type { ChunkSerializer } from '../../types/stream.js';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from './types.js';

/**
 * `ChunkSerializer` for Vercel AI SDK stream parts. Stamped with id
 * `'ai-sdk-stream-v1'`.
 */
export const aiSdkStreamSerializer: ChunkSerializer<LanguageModelV3StreamPart> = {
  id: 'ai-sdk-stream-v1',
  serialize(chunks) {
    return JSON.stringify(chunks);
  },
  deserialize(data) {
    const json = typeof data === 'string' ? data : new TextDecoder().decode(data);
    return JSON.parse(json) as readonly LanguageModelV3StreamPart[];
  },
};

/**
 * Vercel AI SDK middleware that adds caching to any `LanguageModelV3`.
 * Implements both `wrapGenerate` (exact-match) and `wrapStream` (replay
 * via the same teed pipeline as `cache.wrapStream`).
 *
 * @param options Cache plus optional namespace / TTL / skip predicate.
 * @returns A `LanguageModelV3Middleware` to pass to `wrapLanguageModel`.
 *
 * @example
 * import { openai } from '@ai-sdk/openai';
 * import { wrapLanguageModel, generateText } from 'ai';
 *
 * const cached = wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: cacheMiddleware({ cache, ttl: 3_600_000 }),
 * });
 */
export function cacheMiddleware(options: {
  readonly cache: Cache;
  readonly namespace?: string;
  readonly ttl?: number;
  readonly skip?: (params: LanguageModelV3CallOptions) => boolean;
}): LanguageModelV3Middleware {
  if (!options?.cache) {
    throw new ConfigError('CACHE_INVALID_OPTIONS', 'cacheMiddleware requires a `cache` option', { field: 'cache' });
  }
  const cache = options.cache;
  const namespace = options.namespace;

  const buildReq = (model: string, params: LanguageModelV3CallOptions): CacheRequest => {
    const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = { model };
    if (Array.isArray(params.messages)) {
      out.messages = params.messages as NonNullable<CacheRequest['messages']>;
    } else if (params.prompt !== undefined) {
      out.input = params.prompt;
    } else {
      out.input = params;
    }
    const restParams: Record<string, unknown> = {};
    for (const k of Object.keys(params)) {
      if (k === 'messages' || k === 'prompt' || k === 'tools') continue;
      restParams[k] = (params as Record<string, unknown>)[k];
    }
    out.params = restParams;
    if (Array.isArray(params.tools)) out.tools = params.tools as NonNullable<CacheRequest['tools']>;
    if (namespace) out.namespace = namespace;
    return out;
  };

  return {
    middlewareVersion: 'v3',
    async wrapGenerate({ doGenerate, params, model }) {
      if (options.skip?.(params)) return doGenerate();
      const req = buildReq(model.modelId, params);
      const wrapOpts: { ttl?: number } = {};
      if (options.ttl !== undefined) wrapOpts.ttl = options.ttl;
      return cache.wrap<LanguageModelV3GenerateResult>(req, doGenerate, wrapOpts);
    },
    async wrapStream({ doStream, params, model }) {
      if (options.skip?.(params)) return doStream();
      const req = buildReq(model.modelId, params);
      const wrapOpts: { serializer: ChunkSerializer<LanguageModelV3StreamPart>; ttl?: number } = {
        serializer: aiSdkStreamSerializer,
      };
      if (options.ttl !== undefined) wrapOpts.ttl = options.ttl;
      const stream = await cache.wrapStream<LanguageModelV3StreamPart>(
        req,
        async () => (await doStream()).stream,
        wrapOpts,
      );
      return { stream };
    },
  };
}

export type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from './types.js';
