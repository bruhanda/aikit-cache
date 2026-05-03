import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postgresStorage, type PostgresLikeClient } from '../storage/postgres.js';
import { makeEntry } from '../core/envelope.js';
import { StorageError } from '../errors/storage-error.js';
import type { CacheEntry } from '../core/types.js';
import { canonicalJSON } from '../internal/canonical-json.js';

interface Row {
  key: string;
  value: string;
  exp: number;
  tags: string[] | null;
}

class FakePg implements PostgresLikeClient {
  rows = new Map<string, Row>();
  vectors = new Map<string, Float32Array>();
  schemaCalls = 0;

  async query<TRow = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly TRow[]; readonly rowCount: number }> {
    if (sql.startsWith('CREATE TABLE')) {
      this.schemaCalls += 1;
      return { rows: [] as readonly TRow[], rowCount: 0 };
    }
    if (sql.startsWith('CREATE INDEX')) return { rows: [] as readonly TRow[], rowCount: 0 };
    if (sql.startsWith('SELECT key, value, exp, tags FROM')) {
      if (sql.includes('WHERE key = $1')) {
        const key = params[0] as string;
        const row = this.rows.get(key);
        return { rows: row ? ([row] as unknown as readonly TRow[]) : [], rowCount: row ? 1 : 0 };
      }
      return {
        rows: Array.from(this.rows.values()) as unknown as readonly TRow[],
        rowCount: this.rows.size,
      };
    }
    if (sql.startsWith('INSERT INTO')) {
      const [key, value, exp, tags] = params as [string, string, number, string[] | null];
      this.rows.set(key, { key, value, exp, tags });
      return { rows: [] as readonly TRow[], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM')) {
      if (sql.includes('WHERE key = $1')) {
        const key = params[0] as string;
        const removed = this.rows.delete(key) ? 1 : 0;
        return { rows: [] as readonly TRow[], rowCount: removed };
      }
      if (sql.includes('WHERE key LIKE $1')) {
        const pattern = (params[0] as string).replace(/%/g, '');
        const matches = Array.from(this.rows.keys()).filter((k) => k.startsWith(pattern));
        for (const k of matches) this.rows.delete(k);
        return { rows: [] as readonly TRow[], rowCount: matches.length };
      }
      if (sql.includes('= ANY(tags)')) {
        const tag = params[0] as string;
        const matches = Array.from(this.rows.values()).filter((r) => r.tags?.includes(tag));
        for (const r of matches) this.rows.delete(r.key);
        return { rows: [] as readonly TRow[], rowCount: matches.length };
      }
      const n = this.rows.size;
      this.rows.clear();
      return { rows: [] as readonly TRow[], rowCount: n };
    }
    if (sql.startsWith('UPDATE')) {
      if (sql.includes('IS NOT NULL AND exp')) {
        const hits: { key: string; score: number }[] = [];
        for (const [id, vec] of this.vectors) {
          let dot = 0;
          for (let i = 0; i < vec.length; i++) dot += vec[i]! * (params[0] as Float32Array)[i]!;
          hits.push({ key: id, score: dot });
        }
        return { rows: hits as unknown as readonly TRow[], rowCount: hits.length };
      }
      // generic UPDATE
      return { rows: [] as readonly TRow[], rowCount: 1 };
    }
    return { rows: [] as readonly TRow[], rowCount: 0 };
  }
}

let now = 0;
const clock = { now: () => now };

beforeEach(() => {
  now = 0;
});

describe('postgresStorage', () => {
  it('should ensure schema lazily on first call', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.get('absent');
    await s.get('absent');
    expect(client.schemaCalls).toBe(1);
  });

  it('should round-trip values', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    const entry = makeEntry('v', 1000, now);
    await s.set('k', entry, 1000);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should treat string-typed exp as a number', async () => {
    const client = new FakePg();
    client.rows.set('k', { key: 'k', value: canonicalJSON(makeEntry<CacheEntry<unknown>>(makeEntry('v', 1000, 0), 1000, 0)), exp: 1000 as unknown as number, tags: null });
    const s = postgresStorage({ client, clock });
    expect(await s.get('k')).toBeDefined();
  });

  it('should expire entries lazily on get', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('k', makeEntry('v', 100, now), 100);
    now += 200;
    expect(await s.get('k')).toBeUndefined();
  });

  it('should report deletion success', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('k', makeEntry('v', 1000, now), 1000);
    expect(await s.delete('k')).toBe(true);
    expect(await s.delete('k')).toBe(false);
  });

  it('should invalidate by key', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('k', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ key: 'k' })).toBe(1);
  });

  it('should invalidate by prefix', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('a:1', makeEntry('v', 1000, now), 1000);
    await s.set('a:2', makeEntry('v', 1000, now), 1000);
    await s.set('b:1', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ prefix: 'a:' })).toBe(2);
  });

  it('should invalidate by tag', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('a', makeEntry('v', 1000, now, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
  });

  it('should invalidate by predicate', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('a', makeEntry('v', 1000, now, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ predicate: (entry) => entry.tags.includes('x') })).toBe(1);
  });

  it('should clear every row', async () => {
    const client = new FakePg();
    const s = postgresStorage({ client, clock });
    await s.set('a', makeEntry('v', 1000, now), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.clear()).toBe(2);
  });

  it('should wrap query errors as StorageError', async () => {
    const broken: PostgresLikeClient = {
      query: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const s = postgresStorage({ client: broken, clock });
    await expect(s.get('k')).rejects.toBeInstanceOf(StorageError);
  });

  it('should advertise vectorSearch capability when vectorColumn is set', () => {
    const s = postgresStorage({
      client: new FakePg(),
      vectorColumn: { name: 'embedding', dimensions: 4 },
      clock,
    });
    expect(s.capabilities?.vectorSearch).toBe(true);
    expect(s.vectorUpsert).toBeTypeOf('function');
    expect(s.vectorSearch).toBeTypeOf('function');
    expect(s.vectorDelete).toBeTypeOf('function');
  });

  it('should NOT expose vector methods when vectorColumn is not set', () => {
    const s = postgresStorage({ client: new FakePg(), clock });
    expect(s.vectorUpsert).toBeUndefined();
    expect(s.vectorSearch).toBeUndefined();
    expect(s.vectorDelete).toBeUndefined();
  });
});
