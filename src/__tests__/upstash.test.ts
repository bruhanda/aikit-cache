import { beforeEach, describe, expect, it, vi } from 'vitest';
import { upstashLock, upstashStorage, type UpstashClient } from '../storage/upstash.js';
import { makeEntry } from '../core/envelope.js';
import { StorageError } from '../errors/storage-error.js';

class FakeUpstash implements UpstashClient {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async set(key: string, value: string, opts?: { px?: number; ex?: number }): Promise<unknown> {
    void opts;
    this.store.set(key, value);
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

describe('upstashStorage', () => {
  let client: FakeUpstash;

  beforeEach(() => {
    client = new FakeUpstash();
  });

  it('should accept a pre-constructed client and round-trip values', async () => {
    const s = upstashStorage({ client });
    const entry = makeEntry('hello', 1000, 0);
    await s.set('k', entry, 1000);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should namespace keys via keyPrefix', async () => {
    const s = upstashStorage({ client, keyPrefix: 'pfx:' });
    await s.set('k', makeEntry('v', 1000, 0), 1000);
    expect(client.store.has('pfx:k')).toBe(true);
  });

  it('should index tags on set and remove them on delete', async () => {
    const s = upstashStorage({ client });
    await s.set('k', makeEntry('v', 1000, 0, { tags: ['t'] }), 1000);
    expect(await client.smembers('aikit:__tag__:t')).toContain('k');
    await s.delete('k');
    expect(await client.smembers('aikit:__tag__:t')).not.toContain('k');
  });

  it('should invalidate by key', async () => {
    const s = upstashStorage({ client });
    await s.set('k', makeEntry('v', 1000, 0), 1000);
    expect(await s.invalidate({ key: 'k' })).toBe(1);
  });

  it('should invalidate by tag', async () => {
    const s = upstashStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
    expect(await s.get('a')).toBeUndefined();
  });

  it('should invalidate by prefix', async () => {
    const s = upstashStorage({ client });
    await s.set('a:1', makeEntry('v', 1000, 0), 1000);
    await s.set('a:2', makeEntry('v', 1000, 0), 1000);
    await s.set('b:1', makeEntry('v', 1000, 0), 1000);
    expect(await s.invalidate({ prefix: 'a:' })).toBe(2);
  });

  it('should invalidate by predicate', async () => {
    const s = upstashStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    const removed = await s.invalidate({
      predicate: (entry) => entry.tags.includes('x'),
    });
    expect(removed).toBe(1);
  });

  it('should clear every entry', async () => {
    const s = upstashStorage({ client });
    await s.set('a', makeEntry('v', 1000, 0), 1000);
    await s.set('b', makeEntry('v', 1000, 0), 1000);
    expect(await s.clear()).toBeGreaterThanOrEqual(2);
  });

  it('should wrap underlying GET errors as StorageError', async () => {
    const broken = {
      ...client,
      get: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = upstashStorage({ client: broken as never });
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should accept REST credentials and call the supplied fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
      text: async () => '',
    });
    const s = upstashStorage({
      url: 'https://example.com',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await s.get('k')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('should throw when REST returns a non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'down',
    });
    const s = upstashStorage({
      url: 'https://example.com',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should throw when REST response includes an error field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'bad command' }),
      text: async () => '',
    });
    const s = upstashStorage({
      url: 'https://example.com',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });
});

describe('upstashLock', () => {
  it('should acquire the lock when SET ... NX returns OK', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const cmd = JSON.parse(init?.body ?? '[]') as string[];
      if (cmd[0] === 'SET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: 'OK' }),
          text: async () => '',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: 0 }),
        text: async () => '',
      } as unknown as Response;
    });
    const lock = upstashLock({
      url: 'https://example.com',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const handle = await lock.acquire('k');
    expect(handle.held).toBe(true);
    await handle.release();
  });

  it('should return held: false when SET fails and waitMs is 0', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
      text: async () => '',
    }));
    const lock = upstashLock({
      url: 'https://example.com',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const handle = await lock.acquire('k', { waitMs: 0 });
    expect(handle.held).toBe(false);
    await handle.release();
  });
});
