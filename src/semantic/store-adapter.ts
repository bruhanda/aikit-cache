import { StorageError } from '../errors/storage-error.js';
import type { CacheStorage, VectorRecord, VectorSearchHit } from '../core/types.js';
import { MemoryVectorIndex } from './memory-index.js';

/**
 * Adapter that uses the storage's native vector search if available, else
 * falls back to an in-process `MemoryVectorIndex`.
 */
export class VectorStoreAdapter {
  private readonly fallback: MemoryVectorIndex | undefined;
  private readonly nativeAvailable: boolean;

  constructor(private readonly storage: CacheStorage) {
    this.nativeAvailable = storage.capabilities?.vectorSearch === true && typeof storage.vectorSearch === 'function';
    this.fallback = this.nativeAvailable ? undefined : new MemoryVectorIndex();
  }

  /** Upsert vectors via the most efficient path. */
  async upsert(records: readonly VectorRecord[]): Promise<void> {
    if (this.nativeAvailable && this.storage.vectorUpsert) {
      try {
        await this.storage.vectorUpsert(records);
        return;
      } catch (cause) {
        throw new StorageError(
          'STORAGE_VECTOR_UNSUPPORTED',
          'vectorUpsert',
          this.storage.name,
          `vectorUpsert failed: ${describe(cause)}`,
          { cause },
        );
      }
    }
    this.fallback!.upsert(records);
  }

  /** Top-K search via the most efficient path. */
  async search(query: Float32Array, topK: number, namespace?: string): Promise<readonly VectorSearchHit[]> {
    if (this.nativeAvailable && this.storage.vectorSearch) {
      try {
        return await this.storage.vectorSearch(query, topK, namespace);
      } catch (cause) {
        throw new StorageError(
          'STORAGE_VECTOR_UNSUPPORTED',
          'vectorSearch',
          this.storage.name,
          `vectorSearch failed: ${describe(cause)}`,
          { cause },
        );
      }
    }
    return this.fallback!.search(query, topK);
  }

  /** Delete vectors by id. */
  async delete(ids: readonly string[]): Promise<number> {
    if (this.nativeAvailable && this.storage.vectorDelete) {
      try {
        return await this.storage.vectorDelete(ids);
      } catch (cause) {
        throw new StorageError(
          'STORAGE_VECTOR_UNSUPPORTED',
          'vectorDelete',
          this.storage.name,
          `vectorDelete failed: ${describe(cause)}`,
          { cause },
        );
      }
    }
    return this.fallback!.delete(ids);
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
