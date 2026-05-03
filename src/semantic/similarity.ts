import { normalizeVector } from '../internal/vector.js';

/**
 * Cosine similarity over **already-normalized** unit vectors. Equal to a
 * dot product because both magnitudes are 1. Throws when the dimensions
 * mismatch — a programming error rather than a runtime condition.
 *
 * @param a First unit vector.
 * @param b Second unit vector.
 * @returns Cosine similarity in `[-1, 1]`; for unit vectors typically `[0, 1]`.
 * @throws {Error} when `a.length !== b.length`.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Normalize a vector to unit length. Re-exported from the internal helper
 * so embedding adapters and the semantic surface share a single
 * implementation.
 *
 * @param v Source vector.
 * @returns A new `Float32Array` of length `v.length`.
 */
export const normalize = normalizeVector;

/**
 * Top-K selection by score. Returns indices in descending-score order.
 *
 * @param scores Per-candidate scores.
 * @param k Maximum count to return.
 * @returns Sorted indices.
 */
export function topK(scores: readonly number[], k: number): readonly number[] {
  const indexed = scores.map<[number, number]>((s, i) => [s, i]);
  indexed.sort((a, b) => b[0] - a[0]);
  return indexed.slice(0, k).map(([, i]) => i);
}
