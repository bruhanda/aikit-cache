import { cosineSimilarity } from './similarity.js';
import type { VectorSearchHit } from '../core/types.js';

interface IndexEntry {
  vector: Float32Array;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * In-memory linear-scan vector index. Suitable for ≤10k vectors (sub-50 ms
 * search). For larger collections, route through a vector-capable storage
 * adapter (`pgvector`, Upstash Vector, Redis Search).
 */
export class MemoryVectorIndex {
  private readonly entries = new Map<string, IndexEntry>();

  /** Upsert vectors into the index. */
  upsert(records: ReadonlyArray<{ id: string; vector: Float32Array; metadata?: Readonly<Record<string, unknown>> }>): void {
    for (const record of records) {
      const entry: IndexEntry = { vector: record.vector };
      if (record.metadata !== undefined) entry.metadata = record.metadata;
      this.entries.set(record.id, entry);
    }
  }

  /** Remove vectors by id. Returns the number of removed entries. */
  delete(ids: readonly string[]): number {
    let removed = 0;
    for (const id of ids) if (this.entries.delete(id)) removed += 1;
    return removed;
  }

  /** Number of indexed vectors. */
  size(): number {
    return this.entries.size;
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Top-K cosine search.
   *
   * @param query Query vector (assumed unit-normalized).
   * @param k Number of results.
   * @returns Hits sorted by descending score.
   */
  search(query: Float32Array, k: number): readonly VectorSearchHit[] {
    const hits: VectorSearchHit[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.vector.length !== query.length) continue;
      const score = cosineSimilarity(query, entry.vector);
      const hit: VectorSearchHit =
        entry.metadata !== undefined ? { id, score, metadata: entry.metadata } : { id, score };
      hits.push(hit);
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
