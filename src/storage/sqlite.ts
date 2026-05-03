import { StorageError } from '../errors/storage-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import { utf8Decode, utf8Encode } from '../internal/encoding.js';
import type {
  CacheEntry,
  CacheStorage,
  InvalidationPattern,
  StorageCapabilities,
  TransformAtRest,
} from '../core/types.js';

/**
 * Structural shape of a `better-sqlite3` Database. We do not import the
 * package — users construct the DB and pass it in. Types are intentionally
 * minimal and `any`-permissive at the boundary because better-sqlite3's
 * statement results are dynamic at runtime.
 */
export interface SqliteDatabaseLike {
  prepare<TParams = unknown[], TRow = unknown>(sql: string): SqliteStatementLike<TParams, TRow>;
  exec(sql: string): unknown;
}

export interface SqliteStatementLike<TParams = unknown[], TRow = unknown> {
  run(...params: TParams extends unknown[] ? TParams : [TParams]): { changes?: number };
  get(...params: TParams extends unknown[] ? TParams : [TParams]): TRow | undefined;
  all(...params: TParams extends unknown[] ? TParams : [TParams]): readonly TRow[];
  iterate?(...params: TParams extends unknown[] ? TParams : [TParams]): IterableIterator<TRow>;
}

export interface SqliteStorageOptions {
  readonly database: SqliteDatabaseLike;
  /** Table name. Default `'aikit_cache'`. */
  readonly tableName?: string;
  readonly transformAtRest?: TransformAtRest;
}

interface CacheRow {
  key: string;
  value: string;
  exp: number;
  tags: string | null;
}

/**
 * SQLite (better-sqlite3) storage adapter. Node-only. Schema:
 *
 * ```sql
 * CREATE TABLE aikit_cache (
 *   key TEXT PRIMARY KEY,
 *   value TEXT NOT NULL,
 *   exp INTEGER NOT NULL,
 *   tags TEXT
 * );
 * CREATE INDEX idx_aikit_cache_exp ON aikit_cache(exp);
 * ```
 *
 * Tags are stored as a JSON-encoded string in the same row; predicate /
 * tag invalidation iterates the table.
 *
 * @param options Pre-constructed `better-sqlite3` Database and table name.
 * @returns A `CacheStorage` instance.
 */
export function sqliteStorage(options: SqliteStorageOptions): CacheStorage {
  const db = options.database;
  const table = options.tableName ?? 'aikit_cache';
  const transform = options.transformAtRest;

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       exp INTEGER NOT NULL,
       tags TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_${table}_exp ON ${table}(exp);`,
  );

  const stmtGet = db.prepare<[string], CacheRow>(`SELECT key, value, exp, tags FROM ${table} WHERE key = ?`);
  const stmtSet = db.prepare<[string, string, number, string | null]>(
    `INSERT INTO ${table} (key, value, exp, tags) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, exp=excluded.exp, tags=excluded.tags`,
  );
  const stmtDelete = db.prepare<[string]>(`DELETE FROM ${table} WHERE key = ?`);
  const stmtClear = db.prepare(`DELETE FROM ${table}`);
  const stmtAll = db.prepare<[], CacheRow>(`SELECT key, value, exp, tags FROM ${table}`);
  const stmtPrefix = db.prepare<[string], CacheRow>(`SELECT key, value, exp, tags FROM ${table} WHERE key LIKE ?`);

  const encode = async (entry: CacheEntry<unknown>): Promise<string> => {
    const json = canonicalJSON(entry);
    if (!transform) return json;
    const out = await transform.encode(utf8Encode(json));
    return `\x00${utf8Decode(out)}`;
  };

  const decode = async (raw: string): Promise<CacheEntry<unknown>> => {
    let json = raw;
    if (raw.startsWith('\x00') && transform) {
      const plain = await transform.decode(utf8Encode(raw.slice(1)));
      json = utf8Decode(plain);
    }
    return JSON.parse(json) as CacheEntry<unknown>;
  };

  const capabilities: StorageCapabilities = Object.freeze({
    prefixScan: true,
    tagIndex: false,
    vectorSearch: false,
  });

  return {
    name: 'sqlite',
    capabilities,

    async get(key) {
      try {
        const row = stmtGet.get(key);
        if (!row) return undefined;
        if (row.exp <= Date.now()) {
          stmtDelete.run(key);
          return undefined;
        }
        return await decode(row.value);
      } catch (cause) {
        throw new StorageError('STORAGE_GET_FAILED', 'get', 'sqlite', `sqlite GET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async set(key, entry, _ttlMs) {
      try {
        const value = await encode(entry);
        const tags = entry.tags ? JSON.stringify(entry.tags) : null;
        stmtSet.run(key, value, entry.exp, tags);
      } catch (cause) {
        throw new StorageError('STORAGE_SET_FAILED', 'set', 'sqlite', `sqlite SET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async delete(key) {
      try {
        const result = stmtDelete.run(key);
        return (result.changes ?? 0) > 0;
      } catch (cause) {
        throw new StorageError(
          'STORAGE_DELETE_FAILED',
          'delete',
          'sqlite',
          `sqlite DELETE failed: ${describe(cause)}`,
          { cause, key },
        );
      }
    },

    async invalidate(pattern: InvalidationPattern) {
      if ('key' in pattern) return (await this.delete(pattern.key)) ? 1 : 0;
      if ('prefix' in pattern) {
        const rows = stmtPrefix.all(`${pattern.prefix.replace(/[%_]/g, '\\$&')}%`);
        let removed = 0;
        for (const row of rows) if ((await this.delete(row.key))) removed += 1;
        return removed;
      }
      const rows = stmtAll.all();
      let removed = 0;
      for (const row of rows) {
        if ('tag' in pattern) {
          const tags: string[] = row.tags ? (JSON.parse(row.tags) as string[]) : [];
          if (tags.includes(pattern.tag) && (await this.delete(row.key))) removed += 1;
          continue;
        }
        try {
          const entry = await decode(row.value);
          const view = {
            key: row.key,
            tags: entry.tags ?? [],
            createdAt: entry.createdAt,
            exp: entry.exp,
            meta: entry.meta ?? {},
          };
          if (pattern.predicate(view) && (await this.delete(row.key))) removed += 1;
        } catch {
          // skip
        }
      }
      return removed;
    },

    async clear() {
      const result = stmtClear.run();
      return result.changes ?? 0;
    },
  };
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
