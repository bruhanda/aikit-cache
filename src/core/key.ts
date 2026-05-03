import { sha256Base64Url } from '../internal/digest.js';
import { canonicalize } from './canonical.js';
import type { CacheRequest } from './types.js';

/**
 * Compute the namespaced cache key for a request. The result is
 * `<namespace>:<model>:<digest>` where `<digest>` is base64url-encoded
 * SHA-256 over the canonical JSON form of `request`.
 *
 * Async because `SubtleCrypto.digest` is async — practically free inside
 * the already-async `wrap()` flow.
 *
 * @param request Provider-neutral request.
 * @param options Optional `namespace` and `ignoreFields` overrides.
 * @returns A stable, URL-safe cache key.
 * @throws {ConfigError} on invalid request shape (propagated from `canonicalize`).
 *
 * @example
 * const key = await hashRequest(
 *   { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] },
 *   { namespace: 'support-bot' },
 * );
 * // → 'support-bot:gpt-4o:8RKvQQ-…'
 */
export async function hashRequest(
  request: CacheRequest,
  options?: {
    readonly namespace?: string;
    readonly ignoreFields?: readonly string[];
  },
): Promise<string> {
  const canonical = canonicalize(
    request,
    options?.ignoreFields !== undefined ? { ignoreFields: options.ignoreFields } : undefined,
  );
  const digest = await sha256Base64Url(canonical);
  const ns = options?.namespace ?? request.namespace;
  const prefix = ns ? `${ns}:` : '';
  return `${prefix}${request.model}:${digest}`;
}

/**
 * Pure helper exposing the canonical JSON form for a request. Useful in
 * tests and when implementing custom storage adapters that want to log
 * what was hashed.
 *
 * @param request Provider-neutral request.
 * @param options Optional `ignoreFields` override.
 * @returns Canonical JSON string.
 */
export function canonicalRequest(
  request: CacheRequest,
  options?: { readonly ignoreFields?: readonly string[] },
): string {
  return canonicalize(
    request,
    options?.ignoreFields !== undefined ? { ignoreFields: options.ignoreFields } : undefined,
  );
}
