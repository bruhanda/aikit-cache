import { CacheError, formatErrorMessage } from './base.js';

/**
 * Thrown when an embedding provider fails or its output disagrees with the
 * declared dimensionality. Graceful degradation in the cache layer turns
 * these into `'error'` events and falls through to the live `fn()` call.
 */
export class EmbeddingError extends CacheError {
  readonly code:
    | 'EMBEDDING_REQUEST_FAILED'
    | 'EMBEDDING_DIMENSION_MISMATCH'
    | 'EMBEDDING_PROVIDER_UNAVAILABLE';

  readonly providerName: string;
  readonly httpStatus?: number;
  readonly expectedDim?: number;
  readonly actualDim?: number;

  constructor(
    code: EmbeddingError['code'],
    providerName: string,
    message: string,
    options?: {
      cause?: unknown;
      httpStatus?: number;
      expectedDim?: number;
      actualDim?: number;
    },
  ) {
    super(formatErrorMessage(message, code), options);
    this.code = code;
    this.providerName = providerName;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.expectedDim !== undefined) this.expectedDim = options.expectedDim;
    if (options?.actualDim !== undefined) this.actualDim = options.actualDim;
    this.name = 'EmbeddingError';
  }
}
