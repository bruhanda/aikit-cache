/**
 * A discriminated-union helper for fallible operations that prefer not to
 * throw. The cache exposes `tryWrap` and `tryWrapStream` mirrors of `wrap` /
 * `wrapStream` that return `Result<T, CacheError>` so callers who set
 * `onError: 'throw'` globally can still opt into graceful handling at a
 * specific call site.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Type guard for the success arm of a `Result`.
 *
 * @example
 * const r = await cache.tryWrap(req, fn);
 * if (isOk(r)) console.log(r.value);
 */
export const isOk = <T, E>(
  r: Result<T, E>,
): r is { readonly ok: true; readonly value: T } => r.ok;

/**
 * Type guard for the error arm of a `Result`.
 *
 * @example
 * const r = await cache.tryWrap(req, fn);
 * if (isErr(r)) console.error(r.error.code);
 */
export const isErr = <T, E>(
  r: Result<T, E>,
): r is { readonly ok: false; readonly error: E } => !r.ok;

/** Wrap a value in the success arm. */
export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({
  ok: true,
  value,
});

/** Wrap an error in the failure arm. */
export const err = <E>(error: E): { readonly ok: false; readonly error: E } => ({
  ok: false,
  error,
});
