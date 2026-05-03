import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudflareKVStorage,
  type KVNamespaceLike,
} from '../storage/cloudflare-kv.js';
import { makeEntry } from '../core/envelope.js';
import { StorageError } from '../errors/storage-error.js';

class FakeKV implements KVNamespaceLike {
  store = new Map<string, string>();
  metadata = new Map<string, unknown>();
  ttls = new Map<string, number>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void> {
    this.store.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
    if (options?.metadata !== undefined) this.metadata.set(key, options.metadata);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.metadata.delete(key);
  }
  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const keys = Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name, metadata: this.metadata.get(name) }));
    return { keys, list_complete: true };
  }
}

describe('cloudflareKVStorage', () => {
  let kv: FakeKV;

  beforeEach(() => {
    kv = new FakeKV();
  });

  it('should round-trip values', async () => {
    const s = cloudflareKVStorage(kv);
    const entry = makeEntry('hello', 60_000, 0);
    await s.set('k', entry, 60_000);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should namespace keys via keyPrefix', async () => {
    const s = cloudflareKVStorage(kv, { keyPrefix: 'pfx:' });
    await s.set('k', makeEntry('v', 60_000, 0), 60_000);
    expect(kv.store.has('pfx:k')).toBe(true);
  });

  it('should set expirationTtl in seconds', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('k', makeEntry('v', 60_000, 0), 60_000);
    expect(kv.ttls.get('aikit:k')).toBe(60);
  });

  it('should round sub-60s TTLs up and warn once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = cloudflareKVStorage(kv);
    await s.set('k1', makeEntry('v', 5_000, 0), 5_000);
    await s.set('k2', makeEntry('v', 1_000, 0), 1_000);
    expect(kv.ttls.get('aikit:k1')).toBe(60);
    expect(kv.ttls.get('aikit:k2')).toBe(60);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('should NOT round when enforceMinimumTtl is false', async () => {
    const s = cloudflareKVStorage(kv, { enforceMinimumTtl: false });
    await s.set('k', makeEntry('v', 5_000, 0), 5_000);
    expect(kv.ttls.get('aikit:k')).toBe(5);
  });

  it('should attach tags as metadata when entry has tags', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('k', makeEntry('v', 60_000, 0, { tags: ['t'] }), 60_000);
    expect(kv.metadata.get('aikit:k')).toEqual({ tags: ['t'] });
  });

  it('should report deletion as true', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('k', makeEntry('v', 60_000, 0), 60_000);
    expect(await s.delete('k')).toBe(true);
  });

  it('should invalidate by key', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('k', makeEntry('v', 60_000, 0), 60_000);
    expect(await s.invalidate({ key: 'k' })).toBe(1);
  });

  it('should invalidate by tag using stored metadata', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('a', makeEntry('v', 60_000, 0, { tags: ['x'] }), 60_000);
    await s.set('b', makeEntry('v', 60_000, 0, { tags: ['y'] }), 60_000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
    expect(await s.get('a')).toBeUndefined();
    expect(await s.get('b')).toBeDefined();
  });

  it('should invalidate by prefix', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('a:1', makeEntry('v', 60_000, 0), 60_000);
    await s.set('a:2', makeEntry('v', 60_000, 0), 60_000);
    await s.set('b:1', makeEntry('v', 60_000, 0), 60_000);
    expect(await s.invalidate({ prefix: 'a:' })).toBe(2);
  });

  it('should invalidate by predicate', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('a', makeEntry('v', 60_000, 0, { tags: ['x'] }), 60_000);
    await s.set('b', makeEntry('v', 60_000, 0), 60_000);
    const removed = await s.invalidate({
      predicate: (entry) => entry.tags.includes('x'),
    });
    expect(removed).toBe(1);
  });

  it('should clear every entry', async () => {
    const s = cloudflareKVStorage(kv);
    await s.set('a', makeEntry('v', 60_000, 0), 60_000);
    await s.set('b', makeEntry('v', 60_000, 0), 60_000);
    expect(await s.clear()).toBe(2);
  });

  it('should wrap underlying GET errors', async () => {
    const broken: KVNamespaceLike = {
      get: async () => {
        throw new Error('boom');
      },
      put: kv.put.bind(kv),
      delete: kv.delete.bind(kv),
      list: kv.list.bind(kv),
    };
    const s = cloudflareKVStorage(broken);
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should wrap underlying PUT errors', async () => {
    const broken: KVNamespaceLike = {
      get: kv.get.bind(kv),
      put: async () => {
        throw new Error('boom');
      },
      delete: kv.delete.bind(kv),
      list: kv.list.bind(kv),
    };
    const s = cloudflareKVStorage(broken);
    await expect(s.set('k', makeEntry('v', 60_000, 0), 60_000)).rejects.toBeInstanceOf(StorageError);
  });

  it('should pass background put to ctx.waitUntil when provided', async () => {
    const waitUntil = vi.fn();
    const s = cloudflareKVStorage(kv, { ctx: { waitUntil } });
    await s.set('k', makeEntry('v', 60_000, 0), 60_000);
    expect(waitUntil).toHaveBeenCalled();
  });
});
