import { CacheError, formatErrorMessage } from './base.js';

/** Operations the storage layer can fail on. Used for structured logging. */
export type StorageOperation =
  | 'get'
  | 'set'
  | 'delete'
  | 'invalidate'
  | 'clear'
  | 'mget'
  | 'mset'
  | 'mdelete'
  | 'vectorSearch'
  | 'vectorUpsert'
  | 'vectorDelete';

/**
 * Thrown when a storage backend fails. Carries the failing operation and
 * the storage adapter's `name` so observability tooling can route alerts
 * (e.g. by adapter family).
 */
export class StorageError extends CacheError {
  readonly code:
    | 'STORAGE_GET_FAILED'
    | 'STORAGE_SET_FAILED'
    | 'STORAGE_DELETE_FAILED'
    | 'STORAGE_INVALIDATE_FAILED'
    | 'STORAGE_BACKEND_UNAVAILABLE'
    | 'STORAGE_VALUE_TOO_LARGE'
    | 'STORAGE_PARSE_FAILED'
    | 'STORAGE_VECTOR_UNSUPPORTED';

  readonly operation: StorageOperation;
  readonly storageName: string;
  readonly key?: string;
  readonly bytes?: number;

  constructor(
    code: StorageError['code'],
    operation: StorageOperation,
    storageName: string,
    message: string,
    options?: { cause?: unknown; key?: string; bytes?: number },
  ) {
    super(formatErrorMessage(message, code), options);
    this.code = code;
    this.operation = operation;
    this.storageName = storageName;
    if (options?.key !== undefined) this.key = options.key;
    if (options?.bytes !== undefined) this.bytes = options.bytes;
    this.name = 'StorageError';
  }
}
