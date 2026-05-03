import { describe, expect, expectTypeOf, it } from 'vitest';
import { err, isErr, isOk, ok, type Result } from '../types/result.js';

describe('Result helpers', () => {
  describe('ok', () => {
    it('should wrap a value in the success arm when called', () => {
      const r = ok(42);
      expect(r).toEqual({ ok: true, value: 42 });
    });

    it('should support null and undefined values when wrapped', () => {
      expect(ok(null)).toEqual({ ok: true, value: null });
      expect(ok(undefined)).toEqual({ ok: true, value: undefined });
    });

    it('should preserve object identity when wrapping objects', () => {
      const obj = { foo: 'bar' };
      const r = ok(obj);
      expect(r.value).toBe(obj);
    });
  });

  describe('err', () => {
    it('should wrap an error in the failure arm when called', () => {
      const e = new Error('boom');
      const r = err(e);
      expect(r).toEqual({ ok: false, error: e });
    });

    it('should support arbitrary error types', () => {
      const r = err('string error');
      expect(r).toEqual({ ok: false, error: 'string error' });
    });
  });

  describe('isOk', () => {
    it('should return true for success arm when input is ok', () => {
      expect(isOk(ok(1))).toBe(true);
    });

    it('should return false for failure arm when input is err', () => {
      expect(isOk(err(1))).toBe(false);
    });

    it('should narrow the type to the success arm', () => {
      const r: Result<number, string> = ok(1);
      if (isOk(r)) {
        expectTypeOf(r.value).toEqualTypeOf<number>();
      }
    });
  });

  describe('isErr', () => {
    it('should return true for failure arm when input is err', () => {
      expect(isErr(err('x'))).toBe(true);
    });

    it('should return false for success arm when input is ok', () => {
      expect(isErr(ok(1))).toBe(false);
    });

    it('should narrow the type to the failure arm', () => {
      const r: Result<number, string> = err('e');
      if (isErr(r)) {
        expectTypeOf(r.error).toEqualTypeOf<string>();
      }
    });
  });

  describe('Result type', () => {
    it('should be a discriminated union over `ok`', () => {
      expectTypeOf<Result<number, string>>().toEqualTypeOf<
        { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string }
      >();
    });
  });
});
