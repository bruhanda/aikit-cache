import { WebCryptoUnavailableError } from '../errors/base.js';
import { toBase64Url, utf8Encode } from './encoding.js';

/** Probe `globalThis.crypto.subtle` defensively — Workers and Node 18+ both expose it. */
const subtle = (): SubtleCrypto => {
  const g = globalThis as { crypto?: { subtle?: SubtleCrypto } };
  const s = g.crypto?.subtle;
  if (!s) throw new WebCryptoUnavailableError();
  return s;
};

/**
 * Compute SHA-256 over a string or `Uint8Array` and return the digest as
 * raw bytes. Uses Web Crypto's `SubtleCrypto.digest` — universal across
 * Node 18+, Bun, Deno, browsers, Cloudflare Workers and Vercel Edge.
 *
 * @param input UTF-8 string or pre-encoded bytes.
 * @returns 32-byte SHA-256 digest.
 * @throws {WebCryptoUnavailableError} when `globalThis.crypto.subtle` is missing.
 */
export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? utf8Encode(input) : input;
  // Web Crypto's BufferSource accepts Uint8Array at runtime; the cast resolves
  // a structural mismatch between Node's `ArrayBufferLike` and the DOM's
  // `ArrayBuffer` shape under `lib: ["DOM"]`.
  const buf = await subtle().digest('SHA-256', data as unknown as ArrayBuffer);
  return new Uint8Array(buf);
}

/**
 * SHA-256 returning a lowercase hex string. Reserved for diagnostics —
 * cache keys use base64url for URL-safety.
 *
 * @param input UTF-8 string or pre-encoded bytes.
 * @returns 64-character lowercase hex string.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = await sha256Bytes(input);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256 digest encoded as base64url — the canonical cache-key encoding.
 *
 * @param input UTF-8 string or pre-encoded bytes.
 * @returns 43-character base64url string (32 bytes, no padding).
 */
export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
  const bytes = await sha256Bytes(input);
  return toBase64Url(bytes);
}
