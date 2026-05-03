import type { CacheEntry, TokenUsage } from './types.js';

/** Current envelope version. Bumping invalidates all stored entries on read. */
export const ENVELOPE_VERSION = 1 as const;

/**
 * Build a fresh `CacheEntry` from the value, TTL, and optional metadata.
 *
 * @param value The value to store.
 * @param ttlMs TTL in milliseconds — added to `now` to compute `exp`.
 * @param now Current timestamp (ms since epoch).
 * @param extras Optional `tags`, `meta`, `usage`.
 * @returns A versioned envelope ready for `storage.set()`.
 */
export function makeEntry<T>(
  value: T,
  ttlMs: number,
  now: number,
  extras?: {
    readonly tags?: readonly string[];
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly usage?: TokenUsage;
  },
): CacheEntry<T> {
  const entry: {
    v: 1;
    value: T;
    exp: number;
    createdAt: number;
    tags?: readonly string[];
    meta?: Readonly<Record<string, unknown>>;
    usage?: TokenUsage;
  } = {
    v: ENVELOPE_VERSION,
    value,
    exp: now + ttlMs,
    createdAt: now,
  };
  if (extras?.tags && extras.tags.length > 0) entry.tags = extras.tags;
  if (extras?.meta) entry.meta = extras.meta;
  if (extras?.usage) entry.usage = extras.usage;
  return entry;
}

/**
 * Validate that a loaded envelope is well-formed and current. A `false`
 * return tells the cache layer to treat the lookup as a miss and emit an
 * `'error'` event for observability.
 *
 * @param raw Loaded envelope candidate.
 * @returns `true` when `raw` matches the current `CacheEntry<unknown>` shape.
 */
export function isValidEntry(raw: unknown): raw is CacheEntry<unknown> {
  if (raw === null || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    e['v'] === ENVELOPE_VERSION &&
    typeof e['exp'] === 'number' &&
    typeof e['createdAt'] === 'number' &&
    'value' in e
  );
}

/**
 * Refresh `exp` on a hit when sliding TTL is enabled. Bounded by
 * `maxAgeMs` so entries cannot live forever under continuous traffic.
 *
 * @param entry Loaded envelope.
 * @param ttlMs Configured TTL to apply.
 * @param now Current timestamp.
 * @param maxAgeMs Optional cap on age beyond which the entry stops refreshing.
 * @returns A new envelope with updated `exp`, or the original if refreshing is disallowed.
 */
export function refreshSliding<T>(
  entry: CacheEntry<T>,
  ttlMs: number,
  now: number,
  maxAgeMs?: number,
): CacheEntry<T> {
  if (maxAgeMs !== undefined && now - entry.createdAt >= maxAgeMs) return entry;
  return { ...entry, exp: now + ttlMs };
}
