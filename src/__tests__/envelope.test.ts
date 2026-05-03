import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_VERSION,
  isValidEntry,
  makeEntry,
  refreshSliding,
} from '../core/envelope.js';

describe('ENVELOPE_VERSION', () => {
  it('should be 1', () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});

describe('makeEntry', () => {
  it('should produce a versioned envelope with computed exp', () => {
    const entry = makeEntry('value', 1000, 100);
    expect(entry).toMatchObject({
      v: 1,
      value: 'value',
      exp: 1100,
      createdAt: 100,
    });
    expect(entry.tags).toBeUndefined();
    expect(entry.meta).toBeUndefined();
    expect(entry.usage).toBeUndefined();
  });

  it('should attach tags only when non-empty', () => {
    expect(makeEntry('v', 1, 0, { tags: [] }).tags).toBeUndefined();
    expect(makeEntry('v', 1, 0, { tags: ['a'] }).tags).toEqual(['a']);
  });

  it('should attach meta and usage when supplied', () => {
    const entry = makeEntry('v', 1, 0, {
      meta: { x: 1 },
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    expect(entry.meta).toEqual({ x: 1 });
    expect(entry.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it('should allow generic typing of value', () => {
    const entry = makeEntry({ foo: 'bar' }, 1, 0);
    expect(entry.value.foo).toBe('bar');
  });
});

describe('isValidEntry', () => {
  it('should accept current-version envelopes', () => {
    expect(isValidEntry({ v: 1, value: 'x', exp: 1, createdAt: 0 })).toBe(true);
  });

  it('should reject null and primitives', () => {
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry(undefined)).toBe(false);
    expect(isValidEntry('x')).toBe(false);
    expect(isValidEntry(42)).toBe(false);
  });

  it('should reject envelopes with mismatched version', () => {
    expect(isValidEntry({ v: 0, value: 'x', exp: 1, createdAt: 0 })).toBe(false);
    expect(isValidEntry({ v: 2, value: 'x', exp: 1, createdAt: 0 })).toBe(false);
  });

  it('should reject envelopes missing exp/createdAt/value', () => {
    expect(isValidEntry({ v: 1, exp: 1, createdAt: 0 })).toBe(false);
    expect(isValidEntry({ v: 1, value: 'x', createdAt: 0 })).toBe(false);
    expect(isValidEntry({ v: 1, value: 'x', exp: 1 })).toBe(false);
  });

  it('should reject envelopes with non-number exp/createdAt', () => {
    expect(isValidEntry({ v: 1, value: 'x', exp: '1', createdAt: 0 })).toBe(false);
    expect(isValidEntry({ v: 1, value: 'x', exp: 1, createdAt: '0' })).toBe(false);
  });
});

describe('refreshSliding', () => {
  it('should extend exp by ttlMs from now', () => {
    const original = makeEntry('v', 1000, 0);
    const refreshed = refreshSliding(original, 2000, 500);
    expect(refreshed.exp).toBe(2500);
    expect(refreshed.createdAt).toBe(0);
  });

  it('should NOT mutate the input', () => {
    const original = makeEntry('v', 1000, 0);
    const beforeExp = original.exp;
    refreshSliding(original, 2000, 500);
    expect(original.exp).toBe(beforeExp);
  });

  it('should return the original entry once maxAge is exceeded', () => {
    const original = makeEntry('v', 1000, 0);
    const refreshed = refreshSliding(original, 2000, 5000, 1000);
    expect(refreshed).toBe(original);
  });

  it('should refresh when below maxAge', () => {
    const original = makeEntry('v', 1000, 0);
    const refreshed = refreshSliding(original, 2000, 500, 5000);
    expect(refreshed.exp).toBe(2500);
    expect(refreshed).not.toBe(original);
  });
});
