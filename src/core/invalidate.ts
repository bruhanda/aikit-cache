import { InvalidationError } from '../errors/invalidation-error.js';
import type { InvalidationPattern } from './types.js';

/**
 * Validate that an invalidation pattern matches the discriminated union.
 *
 * @param pattern Candidate pattern.
 * @returns The pattern, narrowed to a known shape.
 * @throws {InvalidationError} `INVALIDATION_PATTERN_INVALID` for malformed input.
 */
export function assertValidPattern(pattern: unknown): InvalidationPattern {
  if (pattern === null || typeof pattern !== 'object') {
    throw new InvalidationError('INVALIDATION_PATTERN_INVALID', 'invalidation pattern must be an object');
  }
  const p = pattern as Record<string, unknown>;
  if (typeof p['key'] === 'string') return { key: p['key'] };
  if (typeof p['prefix'] === 'string') return { prefix: p['prefix'] };
  if (typeof p['tag'] === 'string') return { tag: p['tag'] };
  if (typeof p['predicate'] === 'function') {
    return { predicate: p['predicate'] as InvalidationPattern extends { predicate: infer F } ? F : never };
  }
  throw new InvalidationError(
    'INVALIDATION_PATTERN_INVALID',
    'invalidation pattern must include exactly one of `key`, `prefix`, `tag`, `predicate`',
  );
}
