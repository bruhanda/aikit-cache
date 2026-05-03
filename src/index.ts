export { createCache } from './core/cache.js';
export { hashRequest, canonicalRequest } from './core/key.js';
export { canonicalize, DEFAULT_IGNORE_FIELDS } from './core/canonical.js';
export { resolveTTL, applyJitter, validateTTL, DEFAULT_TTL_MS, DEFAULT_TTL_JITTER } from './core/ttl.js';
export { makeEntry, isValidEntry, refreshSliding, ENVELOPE_VERSION } from './core/envelope.js';

export { CacheError } from './errors/base.js';
export type { ErrorCode } from './errors/base.js';

export { isOk, isErr, ok, err } from './types/result.js';
export type { Result } from './types/result.js';
export type { Prettify } from './types/prettify.js';
export type { ChatMessage, ChatContentPart, ChatRequest, ChatResponse } from './types/chat.js';
export type { Chunk, ChunkSerializer, TimedChunks } from './types/stream.js';

export type {
  Cache,
  LLMCache,
  CacheOptions,
  CacheRequest,
  CacheEntry,
  CacheEntryView,
  CacheEventName,
  CacheEventListener,
  CacheStatsSnapshot,
  CacheStorage,
  CostSavings,
  CostTracker,
  DistributedLock,
  InvalidationPattern,
  ModelPricing,
  SemanticLayer,
  SemanticLayerHandle,
  SetOptions,
  StorageCapabilities,
  TTLPolicy,
  TokenUsage,
  TransformAtRest,
  VectorRecord,
  VectorSearchHit,
  WrapOptions,
  WrapStreamOptions,
} from './core/types.js';
