import { describe, expect, it } from 'vitest';
import { canonicalize, DEFAULT_IGNORE_FIELDS } from '../core/canonical.js';
import { canonicalRequest, hashRequest } from '../core/key.js';
import { ConfigError } from '../errors/config-error.js';
import type { CacheRequest } from '../core/types.js';

describe('canonicalize', () => {
  it('should produce stable output regardless of param order', () => {
    const a: CacheRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0, top_p: 1 },
    };
    const b: CacheRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      params: { top_p: 1, temperature: 0 },
    };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('should drop default ignore fields (id, request_id, metadata)', () => {
    const r: CacheRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { traceId: 't1' },
    };
    const out = canonicalize(r);
    expect(out).not.toContain('traceId');
    expect(out).not.toContain('metadata');
  });

  it('should drop stream and stream_options inside params', () => {
    const r: CacheRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0, stream: true, stream_options: { include_usage: true } },
    };
    const out = canonicalize(r);
    expect(out).not.toContain('"stream"');
    expect(out).not.toContain('stream_options');
    expect(out).toContain('temperature');
  });

  it('should respect custom ignoreFields', () => {
    const r: CacheRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { x: 1 },
    };
    expect(canonicalize(r, { ignoreFields: ['metadata'] })).not.toContain('metadata');
    // Without metadata in ignore list, it shows up.
    expect(canonicalize(r, { ignoreFields: [] })).toContain('metadata');
  });

  it('should throw when model is missing or empty', () => {
    expect(() => canonicalize({ model: '', messages: [] })).toThrow(ConfigError);
    expect(() =>
      canonicalize({ model: undefined as unknown as string, messages: [] }),
    ).toThrow(ConfigError);
  });

  it('should throw when both messages and input are present', () => {
    expect(() =>
      canonicalize({ model: 'm', messages: [], input: 'x' } as CacheRequest),
    ).toThrow(ConfigError);
  });

  it('should throw when neither messages nor input are present', () => {
    expect(() => canonicalize({ model: 'm' } as CacheRequest)).toThrow(ConfigError);
  });

  it('should support `input` payloads as the chat alternative', () => {
    const out = canonicalize({ model: 'm', input: { foo: 1 } });
    expect(out).toContain('"input"');
    expect(out).toContain('"foo":1');
  });

  it('should preserve dates and Uint8Array in nested fields', () => {
    const out = canonicalize({
      model: 'm',
      input: { d: new Date('2026-05-03T00:00:00Z'), b: new Uint8Array([1, 2, 3]) },
    });
    expect(out).toContain('2026-05-03T00:00:00');
    expect(out).toContain('$bytes');
  });
});

describe('DEFAULT_IGNORE_FIELDS', () => {
  it('should include id, request_id, and metadata', () => {
    expect(DEFAULT_IGNORE_FIELDS).toContain('id');
    expect(DEFAULT_IGNORE_FIELDS).toContain('request_id');
    expect(DEFAULT_IGNORE_FIELDS).toContain('metadata');
  });
});

describe('canonicalRequest', () => {
  it('should match canonicalize output', () => {
    const r: CacheRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(canonicalRequest(r)).toBe(canonicalize(r));
  });

  it('should support custom ignoreFields', () => {
    const r: CacheRequest = {
      model: 'm',
      messages: [],
      metadata: { x: 1 },
    };
    expect(canonicalRequest(r, { ignoreFields: [] })).toContain('metadata');
  });
});

describe('hashRequest', () => {
  it('should produce deterministic keys across calls', async () => {
    const r: CacheRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const a = await hashRequest(r);
    const b = await hashRequest(r);
    expect(a).toBe(b);
  });

  it('should include the model name in the key', async () => {
    const r: CacheRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    const k = await hashRequest(r);
    expect(k.startsWith('gpt-4o:')).toBe(true);
  });

  it('should include the namespace prefix when supplied via options', async () => {
    const r: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const k = await hashRequest(r, { namespace: 'ns' });
    expect(k.startsWith('ns:m:')).toBe(true);
  });

  it('should fall back to the request namespace when options namespace is missing', async () => {
    const r: CacheRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      namespace: 'tenant-a',
    };
    const k = await hashRequest(r);
    expect(k.startsWith('tenant-a:m:')).toBe(true);
  });

  it('should differ when params differ', async () => {
    const a = await hashRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0 },
    });
    const b = await hashRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 1 },
    });
    expect(a).not.toBe(b);
  });

  it('should produce identical keys for requests differing only in metadata', async () => {
    const a = await hashRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { traceId: 'a' },
    });
    const b = await hashRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { traceId: 'b' },
    });
    expect(a).toBe(b);
  });

  it('should produce different keys when ignoreFields differ', async () => {
    const r: CacheRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { x: 1 },
    };
    const withMetadata = await hashRequest(r, { ignoreFields: [] });
    const withoutMetadata = await hashRequest(r);
    expect(withMetadata).not.toBe(withoutMetadata);
  });
});
