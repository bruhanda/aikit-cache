/**
 * Retry an async operation with exponential backoff and full jitter. Used
 * by storage adapters to absorb transient network failures (Redis blip,
 * Upstash 429, KV propagation lag).
 *
 * @param fn Operation to retry. Receives the 1-based attempt number.
 * @param options Retry policy.
 * @param options.attempts Total attempts including the first call. Default `3`.
 * @param options.baseMs Base backoff in milliseconds. Default `100`.
 * @param options.maxMs Cap on backoff. Default `2000`.
 * @param options.shouldRetry Predicate; when it returns `false` the error is rethrown immediately.
 * @returns The first successful result.
 * @throws The last error encountered when every attempt fails.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    readonly attempts?: number;
    readonly baseMs?: number;
    readonly maxMs?: number;
    readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 2_000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) throw error;
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.random() * exp;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
