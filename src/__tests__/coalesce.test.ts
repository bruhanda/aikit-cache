import { describe, expect, it, vi } from 'vitest';
import { Coalescer, noopDistributedLock, withDistributedLock } from '../core/coalesce.js';

describe('Coalescer', () => {
  it('should call fn only once when many waiters race for the same key', async () => {
    const c = new Coalescer<number>();
    const fn = vi.fn().mockResolvedValue(7);
    const promises = [c.dedupe('k', fn), c.dedupe('k', fn), c.dedupe('k', fn)];
    const results = await Promise.all(promises);
    expect(results).toEqual([7, 7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should track waiters count for in-flight key', async () => {
    const c = new Coalescer<number>();
    let resolveFn!: (v: number) => void;
    const fnPromise = new Promise<number>((r) => {
      resolveFn = r;
    });
    const p1 = c.dedupe('k', () => fnPromise);
    const p2 = c.dedupe('k', () => fnPromise);
    const p3 = c.dedupe('k', () => fnPromise);
    expect(c.waiters('k')).toBe(2);
    expect(c.has('k')).toBe(true);
    expect(c.size()).toBe(1);
    resolveFn(1);
    await Promise.all([p1, p2, p3]);
  });

  it('should report zero waiters for unknown keys', () => {
    const c = new Coalescer();
    expect(c.waiters('absent')).toBe(0);
    expect(c.has('absent')).toBe(false);
    expect(c.size()).toBe(0);
  });

  it('should clean up after fn resolves so the next call re-runs fn', async () => {
    const c = new Coalescer<number>();
    const fn = vi.fn().mockResolvedValue(1);
    await c.dedupe('k', fn);
    await c.dedupe('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(c.has('k')).toBe(false);
  });

  it('should clean up after fn rejects so callers see the original error', async () => {
    const c = new Coalescer<number>();
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);
    const p1 = c.dedupe('k', fn);
    const p2 = c.dedupe('k', fn);
    await expect(p1).rejects.toBe(err);
    await expect(p2).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.has('k')).toBe(false);
  });

  it('should NOT surface UnhandledPromiseRejection when fn rejects', async () => {
    // Regression test for REVIEW.md §5: discarding the .finally() chained
    // promise used to surface as UnhandledPromiseRejection. We listen for
    // the event during this test and assert it never fires.
    const c = new Coalescer<number>();
    const handler = vi.fn();
    process.on('unhandledRejection', handler);
    try {
      await expect(c.dedupe('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
      // Allow microtasks/queued tasks to flush.
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('should drain pending entries when drain is awaited', async () => {
    const c = new Coalescer<number>();
    let resolveA!: () => void;
    let resolveB!: () => void;
    c.dedupe('a', () => new Promise<number>((r) => { resolveA = () => r(1); }));
    c.dedupe('b', () => new Promise<number>((r) => { resolveB = () => r(2); }));
    expect(c.size()).toBe(2);
    setTimeout(() => {
      resolveA();
      resolveB();
    }, 0);
    await c.drain();
    expect(c.size()).toBe(0);
  });

  it('should drain even when an in-flight promise rejects', async () => {
    const c = new Coalescer<number>();
    c.dedupe('a', async () => {
      throw new Error('nope');
    }).catch(() => {});
    await c.drain();
    expect(c.size()).toBe(0);
  });
});

describe('noopDistributedLock', () => {
  it('should always report held: true', async () => {
    const handle = await noopDistributedLock.acquire('k');
    expect(handle.held).toBe(true);
    await handle.release();
  });
});

describe('withDistributedLock', () => {
  it('should run fn when lock is held by leader', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const result = await withDistributedLock('k', noopDistributedLock, fn);
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should release the lock even when fn throws', async () => {
    const release = vi.fn(async () => {});
    const lock = {
      async acquire() {
        return { held: true, release };
      },
    };
    await expect(
      withDistributedLock('k', lock, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('should call recheck when lock is held by another peer', async () => {
    const lock = {
      async acquire() {
        return { held: false, release: async () => {} };
      },
    };
    const recheck = vi.fn().mockResolvedValue('cached');
    const fn = vi.fn().mockResolvedValue('live');
    const result = await withDistributedLock('k', lock, fn, recheck);
    expect(result).toBe('cached');
    expect(fn).not.toHaveBeenCalled();
  });

  it('should fall through to fn when recheck returns undefined', async () => {
    const lock = {
      async acquire() {
        return { held: false, release: async () => {} };
      },
    };
    const recheck = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue('live');
    const result = await withDistributedLock('k', lock, fn, recheck);
    expect(result).toBe('live');
    expect(fn).toHaveBeenCalled();
  });

  it('should call fn even with no recheck when lock is not held', async () => {
    const lock = {
      async acquire() {
        return { held: false, release: async () => {} };
      },
    };
    const fn = vi.fn().mockResolvedValue('live');
    const result = await withDistributedLock('k', lock, fn);
    expect(result).toBe('live');
    expect(fn).toHaveBeenCalled();
  });
});
