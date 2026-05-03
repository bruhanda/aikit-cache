/**
 * Encode a `Uint8Array` as base64url (RFC 4648 §5) — URL- and filename-safe,
 * no padding. Used by `hashRequest` so cache keys are safe in headers,
 * Redis keys, file paths, and URLs without escaping.
 *
 * @param bytes Raw bytes to encode.
 * @returns Base64url string.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 = typeof btoa === 'function' ? btoa(binary) : nodeBtoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string back into a `Uint8Array`. Tolerates absent
 * padding (which `toBase64Url` strips) by re-padding before decoding.
 *
 * @param str Base64url string.
 * @returns Decoded bytes.
 * @throws {Error} when the input is not valid base64url.
 */
export function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = typeof atob === 'function' ? atob(padded + padding) : nodeAtob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode a UTF-8 string to bytes via the universal `TextEncoder`.
 *
 * @param str Source string.
 * @returns UTF-8 bytes.
 */
export function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Decode UTF-8 bytes back into a string. Falls through to the universal
 * `TextDecoder` (Node 18+, Bun, Deno, browsers, edge).
 *
 * @param bytes UTF-8 bytes.
 * @returns Decoded string.
 */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const nodeBtoa = (s: string): string => {
  const g = globalThis as unknown as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(s, 'binary').toString('base64');
  throw new Error('btoa is not available in this runtime');
};

const nodeAtob = (s: string): string => {
  const g = globalThis as unknown as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(s, 'base64').toString('binary');
  throw new Error('atob is not available in this runtime');
};
