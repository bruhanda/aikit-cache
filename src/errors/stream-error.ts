import { CacheError, formatErrorMessage } from './base.js';

/**
 * Thrown when streaming capture or replay fails. Most commonly:
 *   - upstream emits a non-serializable value;
 *   - replay encounters a serializer-id mismatch;
 *   - the runtime lacks `ReadableStream.tee()` (theoretical).
 */
export class StreamError extends CacheError {
  readonly code:
    | 'STREAM_CAPTURE_FAILED'
    | 'STREAM_REPLAY_FAILED'
    | 'STREAM_SERIALIZER_MISSING'
    | 'STREAM_SERIALIZER_MISMATCH'
    | 'STREAM_UPSTREAM_ABORTED'
    | 'STREAM_API_UNAVAILABLE';

  readonly serializerId?: string;
  readonly storedSerializerId?: string;

  constructor(
    code: StreamError['code'],
    message: string,
    options?: {
      cause?: unknown;
      serializerId?: string;
      storedSerializerId?: string;
    },
  ) {
    super(formatErrorMessage(message, code), options);
    this.code = code;
    if (options?.serializerId !== undefined) this.serializerId = options.serializerId;
    if (options?.storedSerializerId !== undefined) {
      this.storedSerializerId = options.storedSerializerId;
    }
    this.name = 'StreamError';
  }
}
