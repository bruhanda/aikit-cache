/**
 * Literal union of every error code the library can raise. Forms the
 * discriminator on `CacheError.code` so consumers can switch exhaustively
 * over failure modes.
 */
export type ErrorCode =
  | 'INVARIANT'
  | 'CACHE_DISPOSED'
  | 'CACHE_INVALID_OPTIONS'
  | 'WEB_CRYPTO_UNAVAILABLE'
  | 'STORAGE_GET_FAILED'
  | 'STORAGE_SET_FAILED'
  | 'STORAGE_DELETE_FAILED'
  | 'STORAGE_INVALIDATE_FAILED'
  | 'STORAGE_BACKEND_UNAVAILABLE'
  | 'STORAGE_VALUE_TOO_LARGE'
  | 'STORAGE_PARSE_FAILED'
  | 'STORAGE_VECTOR_UNSUPPORTED'
  | 'EMBEDDING_REQUEST_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_PROVIDER_UNAVAILABLE'
  | 'STREAM_CAPTURE_FAILED'
  | 'STREAM_REPLAY_FAILED'
  | 'STREAM_SERIALIZER_MISSING'
  | 'STREAM_SERIALIZER_MISMATCH'
  | 'STREAM_UPSTREAM_ABORTED'
  | 'STREAM_API_UNAVAILABLE'
  | 'INVALIDATION_PATTERN_INVALID'
  | 'INVALIDATION_NOT_SUPPORTED'
  | 'COST_UNKNOWN_MODEL'
  | 'COST_INVALID_PRICING'
  | 'CONFIG_INVALID_TTL'
  | 'CONFIG_INVALID_THRESHOLD'
  | 'CONFIG_INVALID_NAMESPACE'
  | 'ADAPTER_UNSUPPORTED_METHOD';

/** Edge-safe `process.env.NODE_ENV` probe — Workers/Edge throw on bare access. */
const isProduction = (): boolean => {
  try {
    return (
      typeof process !== 'undefined' &&
      typeof process.env !== 'undefined' &&
      process.env['NODE_ENV'] === 'production'
    );
  } catch {
    return false;
  }
};

/**
 * Append a docs link to error messages outside production. The check is
 * gated to avoid `ReferenceError` on runtimes (Cloudflare Workers, Vercel
 * Edge) that don't expose `process` at all.
 */
export const formatErrorMessage = (message: string, code: ErrorCode): string => {
  if (isProduction()) return message;
  return `${message} (see https://github.com/j09822475-dev/aikit-cache#error-${code.toLowerCase()})`;
};

/**
 * Abstract base class for every error thrown by the library. Carries a
 * literal `code` discriminator so `instanceof CacheError` plus a `switch`
 * on `error.code` is sufficient for exhaustive handling.
 *
 * The constructor calls `Object.setPrototypeOf` so `instanceof` works
 * across realms and after transpilation that loses the ES `class` chain.
 */
export abstract class CacheError extends Error {
  abstract readonly code: ErrorCode;
  override name: string = 'CacheError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Programmer-error class for unreachable branches and invariant violations. */
export class InvariantError extends CacheError {
  readonly code = 'INVARIANT' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(formatErrorMessage(message, 'INVARIANT'), options);
    this.name = 'InvariantError';
  }
}

/**
 * Thrown when the underlying runtime does not expose Web Crypto. Theoretical
 * on supported runtimes (Node 18+, Bun, Deno, browsers, edge) — kept as a
 * defensive guard so users get a precise diagnostic.
 */
export class WebCryptoUnavailableError extends CacheError {
  readonly code = 'WEB_CRYPTO_UNAVAILABLE' as const;
  constructor(message = 'globalThis.crypto.subtle is not available in this runtime') {
    super(formatErrorMessage(message, 'WEB_CRYPTO_UNAVAILABLE'));
    this.name = 'WebCryptoUnavailableError';
  }
}

