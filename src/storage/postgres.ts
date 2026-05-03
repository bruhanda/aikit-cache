import { StorageError } from '../errors/storage-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import { utf8Decode, utf8Encode } from '../internal/encoding.js';
import type {
  CacheEntry,
  CacheStorage,
  InvalidationPattern,
  StorageCapabilities,
  TransformAtRest,
  VectorRecord,
  VectorSearchHit,
} from '../core/types.js';

/**
 * Structural shape of a Postgres client. Compatible with both `pg` (`Pool`,
 * `Client`) and `postgres` (`postgres.Sql`) — call `query` directly with a
 * SQL string and parameter array, return rows.
 */
export interface PostgresLikeClient {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly TRow[] } | { readonly rowCount?: number; readonly rows?: readonly TRow[] }>;
}

export interface PostgresStorageOptions {
  readonly client: PostgresLikeClient;
  /** Table name. Default `'aikit_cache'`. */
  readonly tableName?: string;
  /** Optional pgvector configuration. When set, `capabilities.vectorSearch === true`. */
  readonly vectorColumn?: { readonly name: string; readonly dimensions: number };
  readonly transformAtRest?: TransformAtRest;
}

interface CacheRow {
  key: string;
  value: string;
  exp: string | number;
  tags: readonly string[] | null;
}

/**
 * Postgres + pgvector storage adapter (Node-only). Stores entries as rows
 * with TEXT key, BYTEA-as-base64 value, BIGINT exp, and TEXT[] tags. When
 * `vectorColumn` is set, advertises `capabilities.vectorSearch === true`
 * and routes ANN queries to `<-> ` cosine distance for the semantic layer.
 *
 * @param options Pre-constructed Postgres client and optional pgvector config.
 * @returns A `CacheStorage` instance.
 */
export function postgresStorage(options: PostgresStorageOptions): CacheStorage {
  const client = options.client;
  const table = options.tableName ?? 'aikit_cache';
  const transform = options.transformAtRest;
  const vectorCol = options.vectorColumn;

  const capabilities: StorageCapabilities = Object.freeze({
    prefixScan: true,
    tagIndex: true,
    vectorSearch: vectorCol !== undefined,
  });

  const ensureSchema = async (): Promise<void> => {
    const cols = `key TEXT PRIMARY KEY, value TEXT NOT NULL, exp BIGINT NOT NULL, tags TEXT[]`;
    const vectorClause = vectorCol ? `, ${vectorCol.name} vector(${vectorCol.dimensions})` : '';
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (${cols}${vectorClause});`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_${table}_exp ON ${table}(exp);`);
  };

  let schemaReady: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    schemaReady ??= ensureSchema();
    return schemaReady;
  };

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

  const rowsOf = (result: Awaited<ReturnType<PostgresLikeClient['query']>>): readonly CacheRow[] => {
    if ('rows' in result && result.rows) return result.rows as readonly CacheRow[];
    return [];
  };

  const storage: CacheStorage = {
    name: 'postgres',
    capabilities,

    async get(key) {
      try {
        await ready();
        const result = await client.query<CacheRow>(
          `SELECT key, value, exp, tags FROM ${table} WHERE key = $1`,
          [key],
        );
        const rows = rowsOf(result);
        const row = rows[0];
        if (!row) return undefined;
        const exp = typeof row.exp === 'string' ? Number.parseInt(row.exp, 10) : row.exp;
        if (exp <= Date.now()) {
          await client.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
          return undefined;
        }
        return await decode(row.value);
      } catch (cause) {
        throw new StorageError('STORAGE_GET_FAILED', 'get', 'postgres', `postgres GET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async set(key, entry, _ttlMs) {
      try {
        await ready();
        const value = await encode(entry);
        const tags = entry.tags ?? null;
        await client.query(
          `INSERT INTO ${table} (key, value, exp, tags) VALUES ($1, $2, $3, $4)
           ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, exp = EXCLUDED.exp, tags = EXCLUDED.tags`,
          [key, value, entry.exp, tags],
        );
      } catch (cause) {
        throw new StorageError('STORAGE_SET_FAILED', 'set', 'postgres', `postgres SET failed: ${describe(cause)}`, {
          cause,
          key,
        });
      }
    },

    async delete(key) {
      try {
        await ready();
        const result = await client.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
        if ('rowCount' in result && typeof result.rowCount === 'number') return result.rowCount > 0;
        return true;
      } catch (cause) {
        throw new StorageError(
          'STORAGE_DELETE_FAILED',
          'delete',
          'postgres',
          `postgres DELETE failed: ${describe(cause)}`,
          { cause, key },
        );
      }
    },

    async invalidate(pattern: InvalidationPattern) {
      await ready();
      if ('key' in pattern) return (await storage.delete(pattern.key)) ? 1 : 0;
      if ('prefix' in pattern) {
        const escaped = pattern.prefix.replace(/[%_\\]/g, '\\$&');
        const result = await client.query(`DELETE FROM ${table} WHERE key LIKE $1`, [`${escaped}%`]);
        return 'rowCount' in result && typeof result.rowCount === 'number' ? result.rowCount : 0;
      }
      if ('tag' in pattern) {
        const result = await client.query(`DELETE FROM ${table} WHERE $1 = ANY(tags)`, [pattern.tag]);
        return 'rowCount' in result && typeof result.rowCount === 'number' ? result.rowCount : 0;
      }
      const all = await client.query<CacheRow>(`SELECT key, value, exp, tags FROM ${table}`);
      const rows = rowsOf(all);
      let removed = 0;
      for (const row of rows) {
        try {
          const entry = await decode(row.value);
          const view = {
            key: row.key,
            tags: entry.tags ?? [],
            createdAt: entry.createdAt,
            exp: entry.exp,
            meta: entry.meta ?? {},
          };
          if (pattern.predicate(view) && (await storage.delete(row.key))) removed += 1;
        } catch {
          // skip
        }
      }
      return removed;
    },

    async clear() {
      await ready();
      const result = await client.query(`DELETE FROM ${table}`);
      return 'rowCount' in result && typeof result.rowCount === 'number' ? result.rowCount : 0;
    },
  };

  if (vectorCol) {
    storage.vectorUpsert = async (records: readonly VectorRecord[]) => {
      await ready();
      for (const record of records) {
        const vector = `[${Array.from(record.vector).join(',')}]`;
        await client.query(
          `UPDATE ${table} SET ${vectorCol.name} = $1::vector WHERE key = $2`,
          [vector, record.id],
        );
      }
    };

    storage.vectorDelete = async (ids: readonly string[]) => {
      await ready();
      if (ids.length === 0) return 0;
      const result = await client.query(
        `UPDATE ${table} SET ${vectorCol.name} = NULL WHERE key = ANY($1)`,
        [ids],
      );
      return 'rowCount' in result && typeof result.rowCount === 'number' ? result.rowCount : 0;
    };

    storage.vectorSearch = async (query, topK) => {
      await ready();
      const vector = `[${Array.from(query).join(',')}]`;
      const result = await client.query<{ key: string; score: number }>(
        `SELECT key, 1 - (${vectorCol.name} <=> $1::vector) AS score
         FROM ${table}
         WHERE ${vectorCol.name} IS NOT NULL AND exp > $2
         ORDER BY ${vectorCol.name} <=> $1::vector ASC
         LIMIT $3`,
        [vector, Date.now(), topK],
      );
      const rows = 'rows' in result && result.rows ? result.rows : [];
      return rows.map<VectorSearchHit>((row) => ({
        id: row.key,
        score: typeof row.score === 'string' ? Number.parseFloat(row.score) : row.score,
      }));
    };
  }

  return storage;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
