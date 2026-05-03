import { ConfigError } from '../../errors/config-error.js';
import type { Cache, CacheRequest } from '../../core/types.js';
import type { Generation } from './types.js';

const LC_MODEL = 'langchain';

/**
 * Drop-in replacement for LangChain's `RedisCache` / `UpstashRedisCache`.
 * Implements `lookup(prompt, llmKey)` and `update(prompt, llmKey, value)`
 * against any `Cache` from this library.
 *
 * Designed structurally — does not `extends BaseCache` so the adapter has
 * zero runtime dependency on `@langchain/core`. Pass an instance to
 * LangChain's `cache: new LangChainCache({ cache })` option directly.
 *
 * @example
 * import { ChatOpenAI } from '@langchain/openai';
 * const llm = new ChatOpenAI({ cache: new LangChainCache({ cache }) });
 */
export class LangChainCache {
  private readonly cache: Cache;
  private readonly namespace: string | undefined;

  constructor(options: { readonly cache: Cache; readonly namespace?: string }) {
    if (!options?.cache) {
      throw new ConfigError('CACHE_INVALID_OPTIONS', 'LangChainCache requires a `cache` option', { field: 'cache' });
    }
    this.cache = options.cache;
    if (options.namespace !== undefined) this.namespace = options.namespace;
  }

  /**
   * LangChain calls this on every LLM invocation. `prompt` is a serialized
   * conversation string; `llmKey` identifies the model + params. Together
   * they form a stable cache key.
   *
   * @param prompt Serialized prompt string from LangChain.
   * @param llmKey Serialized model+params string from LangChain.
   * @returns Cached `Generation[]` or `null` for misses (LangChain's contract).
   */
  async lookup(prompt: string, llmKey: string): Promise<readonly Generation[] | null> {
    const req = this.buildRequest(prompt, llmKey);
    const value = await this.cache.get<readonly Generation[]>(req);
    return value ?? null;
  }

  /**
   * Store a freshly computed `Generation[]` under the same key as the
   * lookup. LangChain calls this only on cache misses.
   *
   * @param prompt Serialized prompt string.
   * @param llmKey Serialized model+params string.
   * @param value Generation array to cache.
   */
  async update(prompt: string, llmKey: string, value: readonly Generation[]): Promise<void> {
    const req = this.buildRequest(prompt, llmKey);
    await this.cache.set(req, value);
  }

  private buildRequest(prompt: string, llmKey: string): CacheRequest {
    const out: { -readonly [K in keyof CacheRequest]: CacheRequest[K] } = {
      model: LC_MODEL,
      input: { prompt, llmKey },
    };
    if (this.namespace) out.namespace = this.namespace;
    return out;
  }
}

export type { Generation } from './types.js';
