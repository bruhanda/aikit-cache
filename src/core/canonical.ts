import { ConfigError } from '../errors/config-error.js';
import { canonicalJSON } from '../internal/canonical-json.js';
import type { CacheRequest } from './types.js';

/**
 * Default fields stripped from the request before hashing. The entire
 * `metadata` subtree is dropped, not just nested timestamps — see PLAN §9.1
 * case 4 for the rationale.
 */
export const DEFAULT_IGNORE_FIELDS: readonly string[] = ['id', 'request_id', 'metadata'];

/**
 * Canonicalize a request into a deterministic UTF-8 string suitable for
 * hashing. Sorts object keys recursively, strips `ignoreFields`, validates
 * `messages` XOR `input`, and excludes streaming-only fields that do not
 * affect the model's output (`stream`, `stream_options`).
 *
 * Pure and synchronous. Does not touch the network or the clock.
 *
 * @param request Provider-neutral request.
 * @param options Optional override for the ignore-list.
 * @returns Canonical JSON string.
 * @throws {ConfigError} `CACHE_INVALID_OPTIONS` when both `messages` and
 *   `input` are set, when both are missing, or when `model` is empty.
 */
export function canonicalize(
  request: CacheRequest,
  options?: { readonly ignoreFields?: readonly string[] },
): string {
  if (typeof request.model !== 'string' || request.model.length === 0) {
    throw new ConfigError(
      'CACHE_INVALID_OPTIONS',
      'CacheRequest.model must be a non-empty string',
      { field: 'model' },
    );
  }

  const hasMessages = request.messages !== undefined;
  const hasInput = request.input !== undefined;

  if (hasMessages && hasInput) {
    throw new ConfigError(
      'CACHE_INVALID_OPTIONS',
      'CacheRequest accepts EITHER `messages` OR `input`, not both',
      { field: 'messages' },
    );
  }
  if (!hasMessages && !hasInput) {
    throw new ConfigError(
      'CACHE_INVALID_OPTIONS',
      'CacheRequest must include either `messages` (chat) or `input` (everything else)',
      { field: 'messages' },
    );
  }

  const ignore = new Set(options?.ignoreFields ?? DEFAULT_IGNORE_FIELDS);
  const stripped = stripFields(request as unknown as Record<string, unknown>, ignore);
  return canonicalJSON(stripped);
}

const STREAM_ONLY_FIELDS = new Set(['stream', 'stream_options']);

function stripFields(value: unknown, ignore: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripFields(v, ignore));
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (ignore.has(key)) continue;
    const nested = (value as Record<string, unknown>)[key];
    if (key === 'params' && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const cleaned: Record<string, unknown> = {};
      for (const pk of Object.keys(nested as Record<string, unknown>)) {
        if (STREAM_ONLY_FIELDS.has(pk)) continue;
        cleaned[pk] = stripFields((nested as Record<string, unknown>)[pk], ignore);
      }
      out[key] = cleaned;
      continue;
    }
    out[key] = stripFields(nested, ignore);
  }
  return out;
}
