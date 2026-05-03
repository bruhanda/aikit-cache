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
 * Normalize a vector to unit length. Returns the original vector when its
 * magnitude is `0` (avoids division-by-zero — caller's data was empty).
 *
 * @param v Source vector.
 * @returns A new `Float32Array` of length `v.length`.
 */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

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
