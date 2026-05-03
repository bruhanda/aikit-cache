import { InvariantError } from '../errors/base.js';

/**
 * Deterministically serialize `value` to JSON for hashing. Properties:
 *   - object keys are sorted lexicographically at every depth;
 *   - `undefined`-valued properties are dropped (matching `JSON.stringify`);
 *   - explicit `null` is preserved;
 *   - `NaN`, `Infinity`, `-Infinity` throw `InvariantError` (invalid JSON);
 *   - `Date` is serialized via its ISO string;
 *   - `Uint8Array` is serialized as `{"$bytes":"<base64url>"}` so callers
 *     can hash binary inputs without forcing string conversion at the
 *     call site;
 *   - `BigInt` throws `InvariantError` (no portable JSON encoding).
 *
 * Two semantically identical objects with different key orders produce the
 * same output — this is the foundation for stable cache keys across
 * processes and library versions.
 *
 * @param value Any JSON-compatible value.
 * @returns Canonical JSON string.
 * @throws {InvariantError} when the input contains non-finite numbers, BigInt,
 *   functions, or circular references.
 */
export function canonicalJSON(value: unknown): string {
  return stringify(value, new WeakSet());
}

function stringify(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new InvariantError(
        `canonicalJSON: non-finite number encountered (${String(n)})`,
      );
    }
    return n.toString();
  }
  if (type === 'bigint') {
    throw new InvariantError('canonicalJSON: BigInt is not supported');
  }
  if (type === 'function' || type === 'symbol') {
    throw new InvariantError(`canonicalJSON: ${type} is not serializable`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new InvariantError('canonicalJSON: circular reference detected');
  }
  seen.add(obj);

  try {
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());

    if (obj instanceof Uint8Array) {
      let binary = '';
      for (let i = 0; i < obj.length; i++) binary += String.fromCharCode(obj[i]!);
      const g = globalThis as { btoa?: (s: string) => string };
      const b64 = g.btoa
        ? g.btoa(binary)
        : (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } })
            .Buffer!.from(binary, 'binary')
            .toString('base64');
      const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return JSON.stringify({ $bytes: b64url });
    }

    if (Array.isArray(obj)) {
      const parts = obj.map((v) => (v === undefined ? 'null' : stringify(v, seen)));
      return `[${parts.join(',')}]`;
    }

    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = (obj as Record<string, unknown>)[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stringify(v, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
