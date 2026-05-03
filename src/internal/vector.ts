/**
 * Normalize a vector to unit length. Returns the original vector when its
 * magnitude is `0` (avoids division-by-zero — caller's data was empty).
 *
 * Internal helper shared by every embedding provider so a fix to the
 * normalization edge case lands in one place. `semantic/similarity.ts`
 * re-exports this for the public semantic surface.
 *
 * @param v Source vector.
 * @returns A new `Float32Array` of length `v.length`.
 */
export function normalizeVector(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
