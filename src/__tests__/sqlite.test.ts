import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sqliteStorage,
  type SqliteDatabaseLike,
  type SqliteStatementLike,
} from '../storage/sqlite.js';
import { makeEntry } from '../core/envelope.js';
import { StorageError } from '../errors/storage-error.js';

interface Row {
  key: string;
  value: string;
  exp: number;
  tags: string | null;
}

class FakeDb implements SqliteDatabaseLike {
  rows = new Map<string, Row>();
  prepare<TParams = unknown[], TRow = unknown>(sql: string): SqliteStatementLike<TParams, TRow> {
    if (sql.startsWith('SELECT key, value, exp, tags FROM')) {
      if (sql.includes('WHERE key = ?')) {
        return {
          run: () => ({ changes: 0 }),
          get: (...params: unknown[]) => {
            const key = params[0] as string;
            return (this.rows.get(key) ?? undefined) as TRow | undefined;
          },
          all: () => [] as readonly TRow[],
        } as SqliteStatementLike<TParams, TRow>;
      }
      if (sql.includes('WHERE key LIKE ?')) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: (...params: unknown[]) => {
            const pattern = (params[0] as string).replace('%', '');
            return Array.from(this.rows.values()).filter((r) =>
              r.key.startsWith(pattern),
            ) as unknown as readonly TRow[];
          },
        } as SqliteStatementLike<TParams, TRow>;
      }
      return {
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: () => Array.from(this.rows.values()) as unknown as readonly TRow[],
      } as SqliteStatementLike<TParams, TRow>;
    }
    if (sql.startsWith('INSERT')) {
      return {
        run: (...params: unknown[]) => {
          const [key, value, exp, tags] = params as [string, string, number, string | null];
          this.rows.set(key, { key, value, exp, tags });
          return { changes: 1 };
        },
        get: () => undefined,
        all: () => [],
      } as SqliteStatementLike<TParams, TRow>;
    }
    if (sql.startsWith('DELETE FROM') && sql.includes('WHERE key = ?')) {
      return {
        run: (...params: unknown[]) => {
          const key = params[0] as string;
          const removed = this.rows.delete(key) ? 1 : 0;
          return { changes: removed };
        },
        get: () => undefined,
        all: () => [],
      } as SqliteStatementLike<TParams, TRow>;
    }
    if (sql.startsWith('DELETE FROM')) {
      return {
        run: () => {
          const n = this.rows.size;
          this.rows.clear();
          return { changes: n };
        },
        get: () => undefined,
        all: () => [],
      } as SqliteStatementLike<TParams, TRow>;
    }
    return {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    } as SqliteStatementLike<TParams, TRow>;
  }
  exec(_sql: string): unknown {
    return undefined;
  }
}

let now = 0;
const clock = { now: () => now };

beforeEach(() => {
  now = 0;
});

describe('sqliteStorage', () => {
  it('should round-trip values', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    const entry = makeEntry('v', 1000, now);
    await s.set('k', entry, 1000);
    expect(await s.get('k')).toEqual(entry);
  });

  it('should report missing keys as undefined', async () => {
    const s = sqliteStorage({ database: new FakeDb(), clock });
    expect(await s.get('absent')).toBeUndefined();
  });

  it('should expire entries lazily on get', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('k', makeEntry('v', 100, now), 100);
    now += 200;
    expect(await s.get('k')).toBeUndefined();
  });

  it('should report deletion success/failure', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('k', makeEntry('v', 1000, now), 1000);
    expect(await s.delete('k')).toBe(true);
    expect(await s.delete('k')).toBe(false);
  });

  it('should invalidate by key', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('k', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ key: 'k' })).toBe(1);
  });

  it('should invalidate by prefix', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('a:1', makeEntry('v', 1000, now), 1000);
    await s.set('a:2', makeEntry('v', 1000, now), 1000);
    await s.set('b:1', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ prefix: 'a:' })).toBe(2);
  });

  it('should invalidate by tag', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('a', makeEntry('v', 1000, now, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
    expect(await s.get('a')).toBeUndefined();
  });

  it('should invalidate by predicate', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('a', makeEntry('v', 1000, now, { tags: ['x'] }), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ predicate: (entry) => entry.tags.includes('x') })).toBe(1);
  });

  it('should clear every row', async () => {
    const db = new FakeDb();
    const s = sqliteStorage({ database: db, clock });
    await s.set('a', makeEntry('v', 1000, now), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.clear()).toBe(2);
  });

  it('should wrap SET errors as StorageError', async () => {
    const db = new FakeDb();
    const broken = {
      ...db,
      prepare: vi.fn().mockImplementation(() => ({
        run: () => {
          throw new Error('boom');
        },
        get: () => undefined,
        all: () => [],
      })),
      exec: () => undefined,
    };
    const s = sqliteStorage({ database: broken as never, clock });
    await expect(s.set('k', makeEntry('v', 1000, now), 1000)).rejects.toBeInstanceOf(StorageError);
  });

  it('should expose memory capabilities', () => {
    const s = sqliteStorage({ database: new FakeDb(), clock });
    expect(s.capabilities?.prefixScan).toBe(true);
    expect(s.capabilities?.tagIndex).toBe(false);
  });
});
