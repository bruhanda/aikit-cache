import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisLock, redisStorage, type RedisLikeClient } from '../storage/redis.js';
import { makeEntry } from '../core/envelope.js';
import { StorageError } from '../errors/storage-error.js';
import type { TransformAtRest } from '../core/types.js';

class FakeRedis implements RedisLikeClient {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  expirations = new Map<string, number>();

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    const opts = args as Array<string | number>;
    const isNX = opts.includes('NX');
    if (isNX && this.store.has(key)) return null;
    this.store.set(key, value);
    const pxIndex = opts.indexOf('PX');
    if (pxIndex >= 0) {
      const ttl = opts[pxIndex + 1];
      if (typeof ttl === 'number' || typeof ttl === 'string') {
        this.expirations.set(key, Number(ttl));
      }
    }
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }
  async scan(_cursor: string | number, ...args: unknown[]): Promise<[string, string[]]> {
    const matchIdx = args.indexOf('MATCH');
    const pattern =
      matchIdx >= 0 && typeof args[matchIdx + 1] === 'string' ? (args[matchIdx + 1] as string) : '*';
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const keys = Array.from(this.store.keys()).filter((k) => re.test(k));
    return ['0', keys];
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    for (const m of members) set.add(m);
    this.sets.set(key, set);
    return set.size - before;
  }
  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed += 1;
    return removed;
  }
  async eval(_script: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    const lockKey = args[0]!;
    const expectedToken = args[1]!;
    if (this.store.get(lockKey) === expectedToken) {
      this.store.delete(lockKey);
      return 1;
    }
    return 0;
  }
}

const transform: TransformAtRest = {
  encode: (b) => Uint8Array.from(b, (x) => x ^ 0x42),
  decode: (b) => Uint8Array.from(b, (x) => x ^ 0x42),
};

describe('redisStorage', () => {
  let client: FakeRedis;

  beforeEach(() => {
    client = new FakeRedis();
  });

  it('should round-trip values', async () => {
    const s = redisStorage({ client });
    const entry = makeEntry('hello', 1000, 0);
    await s.set('k', entry, 1000);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should return undefined when key is absent', async () => {
    const s = redisStorage({ client });
    expect(await s.get('absent')).toBeUndefined();
  });

  it('should namespace keys via the keyPrefix', async () => {
    const s = redisStorage({ client, keyPrefix: 'pfx:' });
    await s.set('k', makeEntry('v', 1000, 0), 1000);
    expect(client.store.has('pfx:k')).toBe(true);
  });

  it('should record an expiration in milliseconds', async () => {
    const s = redisStorage({ client });
    await s.set('k', makeEntry('v', 1000, 0), 5000);
    expect(client.expirations.get('aikit:k')).toBe(5000);
  });

  it('should encode/decode through TransformAtRest', async () => {
    const s = redisStorage({ client, transformAtRest: transform });
    const entry = makeEntry('plain', 1000, 0);
    await s.set('k', entry, 1000);
    expect(client.store.get('aikit:k')!.startsWith('\x00')).toBe(true);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should index tags on set and remove them on delete', async () => {
    const s = redisStorage({ client });
    await s.set('k', makeEntry('v', 1000, 0, { tags: ['t1', 't2'] }), 1000);
    expect(await client.smembers('aikit:__tag__:t1')).toContain('k');
    expect(await s.delete('k')).toBe(true);
    expect(await client.smembers('aikit:__tag__:t1')).not.toContain('k');
  });

  it('should invalidate by key', async () => {
    const s = redisStorage({ client });
    await s.set('k', makeEntry('v', 1000, 0), 1000);
    expect(await s.invalidate({ key: 'k' })).toBe(1);
  });

  it('should invalidate by tag', async () => {
    const s = redisStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, 0, { tags: ['y'] }), 1000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
    expect(await s.get('a')).toBeUndefined();
    expect(await s.get('b')).toBeDefined();
  });

  it('should invalidate by prefix', async () => {
    const s = redisStorage({ client });
    await s.set('a:1', makeEntry('v', 1000, 0), 1000);
    await s.set('a:2', makeEntry('v', 1000, 0), 1000);
    await s.set('b:1', makeEntry('v', 1000, 0), 1000);
    expect(await s.invalidate({ prefix: 'a:' })).toBe(2);
  });

  it('should invalidate by predicate', async () => {
    const s = redisStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    const removed = await s.invalidate({
      predicate: (entry) => entry.tags.includes('x'),
    });
    expect(removed).toBe(1);
  });

  it('should clear every cache entry', async () => {
    const s = redisStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    expect(await s.clear()).toBeGreaterThanOrEqual(2);
  });

  it('should wrap underlying GET errors as StorageError', async () => {
    const broken = {
      ...client,
      get: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = redisStorage({ client: broken as never });
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should wrap underlying SET errors as StorageError', async () => {
    const broken = {
      ...client,
      set: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = redisStorage({ client: broken as never });
    await expect(s.set('k', makeEntry('v', 1000, 0), 1000)).rejects.toBeInstanceOf(StorageError);
  });

  it('should wrap underlying DELETE errors as StorageError', async () => {
    const broken = {
      ...client,
      del: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = redisStorage({ client: broken as never });
    await expect(s.delete('k')).rejects.toBeInstanceOf(StorageError);
  });
});

describe('redisLock', () => {
  let client: FakeRedis;

  beforeEach(() => {
    client = new FakeRedis();
  });

  it('should acquire when key is unset and release with compare-and-delete', async () => {
    const lock = redisLock(client);
    const handle = await lock.acquire('k');
    expect(handle.held).toBe(true);
    await handle.release();
  });

  it('should return held: false when peer holds the lock and waitMs is 0', async () => {
    const lock = redisLock(client);
    const first = await lock.acquire('k');
    expect(first.held).toBe(true);
    const second = await lock.acquire('k', { waitMs: 0 });
    expect(second.held).toBe(false);
    await second.release();
    await first.release();
  });

  it('should swallow errors during release', async () => {
    const wrapped: RedisLikeClient = {
      set: client.set.bind(client),
      get: client.get.bind(client),
      del: client.del.bind(client),
      scan: client.scan.bind(client),
      sadd: client.sadd.bind(client),
      smembers: client.smembers.bind(client),
      srem: client.srem.bind(client),
      eval: async () => {
        throw new Error('script gone');
      },
    };
    const lock = redisLock(wrapped);
    const handle = await lock.acquire('k');
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('should respect a custom keyPrefix', async () => {
    const lock = redisLock(client, { keyPrefix: 'lk:' });
    await lock.acquire('k');
    expect(Array.from(client.store.keys()).some((k) => k.startsWith('lk:'))).toBe(true);
  });
});
