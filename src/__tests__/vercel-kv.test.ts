import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vercelKVStorage, type VercelKVClient } from '../storage/vercel-kv.js';
import { makeEntry } from '../core/envelope.js';
import { StorageError } from '../errors/storage-error.js';

class FakeVercel implements VercelKVClient {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async get<T = string>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }
  async scan(_cursor: string | number, opts?: { match?: string }): Promise<[string, string[]]> {
    const pattern = opts?.match ?? '*';
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['0', Array.from(this.store.keys()).filter((k) => re.test(k))];
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.sets.set(key, set);
    return members.length;
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
}

describe('vercelKVStorage', () => {
  let client: FakeVercel;

  beforeEach(() => {
    client = new FakeVercel();
  });

  it('should round-trip values', async () => {
    const s = vercelKVStorage({ client });
    const entry = makeEntry('v', 1000, 0);
    await s.set('k', entry, 1000);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should wrap GET errors as StorageError', async () => {
    const broken = {
      ...client,
      get: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = vercelKVStorage({ client: broken as never });
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should wrap SET errors as StorageError', async () => {
    const broken = {
      ...client,
      set: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = vercelKVStorage({ client: broken as never });
    await expect(s.set('k', makeEntry('v', 1000, 0), 1000)).rejects.toBeInstanceOf(StorageError);
  });

  it('should wrap DEL errors as StorageError', async () => {
    const broken = {
      ...client,
      del: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = vercelKVStorage({ client: broken as never });
    await expect(s.delete('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should index tags on set', async () => {
    const s = vercelKVStorage({ client });
    await s.set('k', makeEntry('v', 1000, 0, { tags: ['t'] }), 1000);
    expect(await client.smembers('aikit:__tag__:t')).toContain('k');
  });

  it('should invalidate by key, tag, prefix and predicate', async () => {
    const s = vercelKVStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    await s.set('c:1', makeEntry('v', 1000, 0), 1000);
    expect(await s.invalidate({ key: 'a' })).toBe(1);
    await s.set('a', makeEntry('v', 1000, 0, { tags: ['x'] }), 1000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
    expect(await s.invalidate({ prefix: 'c:' })).toBe(1);
    await s.set('z', makeEntry('v', 1000, 0, { tags: ['z'] }), 1000);
    expect(await s.invalidate({ predicate: (entry) => entry.tags.includes('z') })).toBe(1);
  });

  it('should clear every entry', async () => {
    const s = vercelKVStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    expect(await s.clear()).toBeGreaterThanOrEqual(2);
  });
});
