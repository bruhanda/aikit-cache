import { ConfigError } from '../errors/config-error.js';
import type { TTLPolicy } from './types.js';

/** Default TTL when none is configured: 1 hour. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Default jitter — ±10%. */
export const DEFAULT_TTL_JITTER = 0.1;

/**
 * Resolve the TTL for a single `wrap()` call. Selection order, highest to
 * lowest specificity:
 *   1. explicit `override` from `WrapOptions.ttl`;
 *   2. `perModelTTL[model]`;
 *   3. `perNamespaceTTL[namespace]`;
 *   4. `policy.default` (or `DEFAULT_TTL_MS` if `policy` is unset).
 *
 * @param args Selection inputs.
 * @returns A positive integer TTL in milliseconds.
 * @throws {ConfigError} `CONFIG_INVALID_TTL` for negative, non-finite, or `Infinity` values.
 */
export function resolveTTL(args: {
  readonly model: string;
  readonly namespace?: string;
  readonly override?: number;
  readonly policy?: TTLPolicy;
  readonly perModelTTL?: Readonly<Record<string, number>>;
  readonly perNamespaceTTL?: Readonly<Record<string, number>>;
}): number {
  let ttl: number;
  if (args.override !== undefined) {
    ttl = args.override;
  } else {
    const fromModel = args.perModelTTL?.[args.model];
    if (fromModel !== undefined) {
      ttl = fromModel;
    } else {
      const fromNamespace = args.namespace ? args.perNamespaceTTL?.[args.namespace] : undefined;
      if (fromNamespace !== undefined) {
        ttl = fromNamespace;
      } else {
        ttl = args.policy?.default ?? DEFAULT_TTL_MS;
      }
    }
  }

  validateTTL(ttl);
  return ttl;
}

/**
 * Apply ±jitter% randomness to a TTL. Read-side TTL checks are exact; only
 * the written `exp` is jittered, so behavior is purely a write-time effect
 * to spread thundering-herd expiry.
 *
 * @param ttlMs Base TTL.
 * @param jitter Fractional jitter in `[0, 1]`. Default is `DEFAULT_TTL_JITTER`.
 * @returns Jittered TTL, never less than 1 ms.
 */
export function applyJitter(ttlMs: number, jitter: number = DEFAULT_TTL_JITTER): number {
  if (jitter <= 0) return ttlMs;
  const delta = ttlMs * jitter * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(ttlMs + delta));
}

/**
 * Validate a TTL value at config time. Throws on the obvious foot-guns:
 * negative numbers, NaN, Infinity. TTL of `0` is allowed — entries are
 * functionally not cached, which is a documented way to disable caching
 * per-call.
 *
 * @param ttlMs Candidate TTL.
 * @throws {ConfigError} `CONFIG_INVALID_TTL` when invalid.
 */
export function validateTTL(ttlMs: number): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || Number.isNaN(ttlMs) || ttlMs < 0 || !Number.isFinite(ttlMs)) {
    throw new ConfigError(
      'CONFIG_INVALID_TTL',
      `TTL must be a finite, non-negative number; got ${String(ttlMs)}`,
      { field: 'ttl' },
    );
  }
}
