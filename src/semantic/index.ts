export { withSemantic } from './layer.js';
export { cosineSimilarity, normalize, topK } from './similarity.js';
export { MemoryVectorIndex } from './memory-index.js';
export { VectorStoreAdapter } from './store-adapter.js';
export type {
  SemanticOptions,
  SemanticCandidate,
  SemanticLayer,
  EmbeddingProvider,
  VectorRecord,
  VectorSearchHit,
} from './types.js';
