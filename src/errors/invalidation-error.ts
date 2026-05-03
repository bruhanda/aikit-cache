import { CacheError, formatErrorMessage } from './base.js';

/**
 * Thrown when an invalidation pattern is malformed or the storage backend
 * does not support the requested pattern (e.g. `predicate` against a
 * key-only KV store).
 */
export class InvalidationError extends CacheError {
  readonly code: 'INVALIDATION_PATTERN_INVALID' | 'INVALIDATION_NOT_SUPPORTED';
  readonly storageName?: string;

  constructor(
    code: InvalidationError['code'],
    message: string,
    options?: { cause?: unknown; storageName?: string },
  ) {
    super(formatErrorMessage(message, code), options);
    this.code = code;
    if (options?.storageName !== undefined) this.storageName = options.storageName;
    this.name = 'InvalidationError';
  }
}
