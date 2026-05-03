import { CacheError, formatErrorMessage } from './base.js';

/**
 * Thrown synchronously at `createCache()` time — and at every method call
 * after `dispose()` — for invalid configuration. These represent
 * programmer error and should fail loudly during development.
 */
export class ConfigError extends CacheError {
  readonly code:
    | 'CACHE_DISPOSED'
    | 'CACHE_INVALID_OPTIONS'
    | 'CONFIG_INVALID_TTL'
    | 'CONFIG_INVALID_THRESHOLD'
    | 'CONFIG_INVALID_NAMESPACE'
    | 'ADAPTER_UNSUPPORTED_METHOD';

  readonly field?: string;

  constructor(
    code: ConfigError['code'],
    message: string,
    options?: { cause?: unknown; field?: string },
  ) {
    super(formatErrorMessage(message, code), options);
    this.code = code;
    if (options?.field !== undefined) this.field = options.field;
    this.name = 'ConfigError';
  }
}
