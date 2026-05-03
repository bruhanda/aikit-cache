import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { canonicalJSON } from '../internal/canonical-json.js';
import { defaultClock, type Clock } from '../internal/clock.js';
import { deepEqual } from '../internal/deep-equal.js';
import { sha256Base64Url, sha256Bytes, sha256Hex } from '../internal/digest.js';
import {
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../internal/encoding.js';
import { invariant } from '../internal/invariant.js';
import { retry } from '../internal/retry.js';
import { normalizeVector } from '../internal/vector.js';
import { InvariantError } from '../errors/base.js';

describe('invariant', () => {
  it('should not throw when condition is truthy', () => {
    expect(() => invariant(1, 'x')).not.toThrow();
    expect(() => invariant({}, 'x')).not.toThrow();
    expect(() => invariant('a', 'x')).not.toThrow();
  });

  it('should throw InvariantError when condition is falsy', () => {
    expect(() => invariant(0, 'zero')).toThrow(InvariantError);
    expect(() => invariant('', 'empty')).toThrow(InvariantError);
    expect(() => invariant(null, 'null')).toThrow(InvariantError);
    expect(() => invariant(undefined, 'und')).toThrow(InvariantError);
  });

  it('should propagate the message into the thrown error', () => {
    try {
      invariant(false, 'oops');
    } catch (e) {
      expect((e as Error).message).toContain('oops');
    }
  });

  it('should narrow types via assertion signature', () => {
    const x: string | undefined = 'hi';
    invariant(x, 'must be defined');
    expectTypeOf(x).toEqualTypeOf<string>();
  });
});

describe('defaultClock', () => {
  it('should return Date.now()-aligned values', () => {
    const before = Date.now();
    const t = defaultClock.now();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('should match the Clock interface', () => {
    expectTypeOf(defaultClock).toMatchTypeOf<Clock>();
  });
});

describe('encoding', () => {
  describe('toBase64Url / fromBase64Url', () => {
    it('should round-trip arbitrary bytes', () => {
      for (const len of [0, 1, 2, 3, 4, 16, 32, 64, 100]) {
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = i % 256;
        const encoded = toBase64Url(bytes);
        const decoded = fromBase64Url(encoded);
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
      }
    });

    it('should produce URL-safe output without + / or =', () => {
      const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xfb]);
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
    });

    it('should accept padded and unpadded base64url', () => {
      expect(Array.from(fromBase64Url(''))).toEqual([]);
      const bytes = new Uint8Array([1, 2, 3]);
      const padded = toBase64Url(bytes);
      expect(Array.from(fromBase64Url(padded))).toEqual([1, 2, 3]);
    });

    it('should handle high-byte sequences correctly', () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
      const decoded = fromBase64Url(toBase64Url(bytes));
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });
  });

  describe('utf8Encode / utf8Decode', () => {
    it('should round-trip ASCII strings', () => {
      expect(utf8Decode(utf8Encode('hello'))).toBe('hello');
    });

    it('should round-trip Unicode strings', () => {
      const s = 'héllo 🌍 你好';
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    });

    it('should round-trip empty strings', () => {
      expect(utf8Decode(utf8Encode(''))).toBe('');
    });
  });
});

describe('digest', () => {
  it('should produce a 32-byte digest from a string with sha256Bytes', async () => {
    const bytes = await sha256Bytes('hello');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it('should accept Uint8Array input', async () => {
    const a = await sha256Bytes('hello');
    const b = await sha256Bytes(utf8Encode('hello'));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('should produce a 64-char lowercase hex with sha256Hex', async () => {
    const hex = await sha256Hex('hello');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce a 43-char base64url with sha256Base64Url', async () => {
    const b64 = await sha256Base64Url('hello');
    expect(b64).toHaveLength(43);
    expect(b64).not.toMatch(/[+/=]/);
  });

  it('should be deterministic across calls', async () => {
    const a = await sha256Hex('x');
    const b = await sha256Hex('x');
    expect(a).toBe(b);
  });

  it('should differ across different inputs', async () => {
    const a = await sha256Hex('x');
    const b = await sha256Hex('y');
    expect(a).not.toBe(b);
  });
});

describe('canonicalJSON', () => {
  it('should sort object keys lexicographically', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('should produce identical output for objects with different key orders', () => {
    expect(canonicalJSON({ a: { c: 1, b: 2 }, b: 3 })).toBe(
      canonicalJSON({ b: 3, a: { b: 2, c: 1 } }),
    );
  });

  it('should drop undefined-valued properties', () => {
    expect(canonicalJSON({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('should preserve null', () => {
    expect(canonicalJSON({ a: null })).toBe('{"a":null}');
  });

  it('should encode booleans and numbers', () => {
    expect(canonicalJSON({ a: true, b: false, c: 1.5, d: 0 })).toBe(
      '{"a":true,"b":false,"c":1.5,"d":0}',
    );
  });

  it('should serialize Date as ISO string', () => {
    const d = new Date('2026-05-03T00:00:00Z');
    expect(canonicalJSON({ d })).toBe(`{"d":"${d.toISOString()}"}`);
  });

  it('should serialize Uint8Array as $bytes envelope', () => {
    const out = canonicalJSON({ b: new Uint8Array([1, 2, 3]) });
    expect(out).toMatch(/^\{"b":\{"\$bytes":"[A-Za-z0-9_-]+"\}\}$/);
  });

  it('should encode arrays preserving order with undefined replaced by null', () => {
    expect(canonicalJSON([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('should throw InvariantError on NaN', () => {
    expect(() => canonicalJSON(NaN)).toThrow(InvariantError);
  });

  it('should throw InvariantError on Infinity', () => {
    expect(() => canonicalJSON(Infinity)).toThrow(InvariantError);
    expect(() => canonicalJSON(-Infinity)).toThrow(InvariantError);
  });

  it('should throw InvariantError on BigInt', () => {
    expect(() => canonicalJSON(BigInt(1))).toThrow(InvariantError);
  });

  it('should throw InvariantError on functions and symbols', () => {
    expect(() => canonicalJSON(() => 1)).toThrow(InvariantError);
    expect(() => canonicalJSON(Symbol('s'))).toThrow(InvariantError);
  });

  it('should throw on circular references', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalJSON(a)).toThrow(InvariantError);
  });

  it('should NOT throw on the same frozen object referenced twice (DAG)', () => {
    // Regression test for REVIEW.md §14: distinct DAG references with the
    // same frozen object should serialize without circular detection firing.
    const shared = Object.freeze({ a: 1 });
    const root = { left: shared, right: shared };
    expect(() => canonicalJSON(root)).not.toThrow();
    expect(canonicalJSON(root)).toBe('{"left":{"a":1},"right":{"a":1}}');
  });

  it('should support strings with special chars', () => {
    expect(canonicalJSON('"quote"')).toBe('"\\"quote\\""');
  });
});

describe('deepEqual', () => {
  it('should compare primitives by value', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
  });

  it('should treat NaN as not equal (matches strict ===)', () => {
    expect(deepEqual(NaN, NaN)).toBe(false);
  });

  it('should return false when one side is null and the other is not', () => {
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it('should return false when types differ', () => {
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual({}, 1)).toBe(false);
  });

  it('should compare Date by getTime', () => {
    expect(deepEqual(new Date(0), new Date(0))).toBe(true);
    expect(deepEqual(new Date(0), new Date(1))).toBe(false);
  });

  it('should compare Uint8Array by content', () => {
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(deepEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('should compare arrays recursively', () => {
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], { 0: 1, 1: 2, 2: 3, length: 3 })).toBe(false);
  });

  it('should compare plain objects recursively', () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('should treat differently-shaped values asymmetrically', () => {
    expect(deepEqual({ 0: 1 }, [1])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});

describe('retry', () => {
  it('should resolve immediately when fn succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retry(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry until success when transient failures occur', async () => {
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce('ok');
    const out = await retry(fn, { baseMs: 1 });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should rethrow the last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(retry(fn, { attempts: 2, baseMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should respect shouldRetry when it returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('skip'));
    await expect(
      retry(fn, { attempts: 5, baseMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow('skip');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should pass the 1-based attempt number to fn', async () => {
    const seen: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new Error('again');
      return 'done';
    });
    await retry(fn, { attempts: 3, baseMs: 1 });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('normalizeVector', () => {
  it('should produce a unit-length vector when input is non-zero', () => {
    const v = new Float32Array([3, 4]);
    const u = normalizeVector(v);
    let mag = 0;
    for (let i = 0; i < u.length; i++) mag += u[i]! * u[i]!;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
    expect(u[0]).toBeCloseTo(0.6, 5);
    expect(u[1]).toBeCloseTo(0.8, 5);
  });

  it('should return the original vector when its magnitude is zero', () => {
    const v = new Float32Array([0, 0, 0]);
    const u = normalizeVector(v);
    expect(u).toBe(v);
  });

  it('should not mutate the input', () => {
    const v = new Float32Array([1, 2, 3]);
    const before = Array.from(v);
    normalizeVector(v);
    expect(Array.from(v)).toEqual(before);
  });

  it('should handle a 1-element vector', () => {
    const v = new Float32Array([5]);
    const u = normalizeVector(v);
    expect(u[0]).toBeCloseTo(1, 5);
  });
});
