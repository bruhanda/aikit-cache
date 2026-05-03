import { describe, expect, it } from 'vitest';
import { assertValidPattern } from '../core/invalidate.js';
import { InvalidationError } from '../errors/invalidation-error.js';

describe('assertValidPattern', () => {
  it('should accept { key } pattern', () => {
    expect(assertValidPattern({ key: 'k' })).toEqual({ key: 'k' });
  });

  it('should accept { prefix } pattern', () => {
    expect(assertValidPattern({ prefix: 'p' })).toEqual({ prefix: 'p' });
  });

  it('should accept { tag } pattern', () => {
    expect(assertValidPattern({ tag: 't' })).toEqual({ tag: 't' });
  });

  it('should accept { predicate } pattern', () => {
    const fn = () => true;
    const result = assertValidPattern({ predicate: fn });
    expect((result as { predicate: (e: unknown) => boolean }).predicate).toBe(fn);
  });

  it('should reject null', () => {
    expect(() => assertValidPattern(null)).toThrow(InvalidationError);
  });

  it('should reject primitive values', () => {
    expect(() => assertValidPattern('x')).toThrow(InvalidationError);
    expect(() => assertValidPattern(42)).toThrow(InvalidationError);
    expect(() => assertValidPattern(true)).toThrow(InvalidationError);
  });

  it('should reject object missing all known fields', () => {
    expect(() => assertValidPattern({})).toThrow(InvalidationError);
    expect(() => assertValidPattern({ unknown: 1 })).toThrow(InvalidationError);
  });

  it('should prefer key over prefix when both supplied', () => {
    expect(assertValidPattern({ key: 'k', prefix: 'p' })).toEqual({ key: 'k' });
  });
});
