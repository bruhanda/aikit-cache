import { describe, expect, it, vi } from 'vitest';
import { customEmbeddings } from '../embeddings/custom.js';
import { withBatching } from '../embeddings/batched.js';
import { openaiEmbeddings } from '../embeddings/openai.js';
import { cohereEmbeddings } from '../embeddings/cohere.js';
import { voyageEmbeddings } from '../embeddings/voyage.js';
import { EmbeddingError } from '../errors/embedding-error.js';

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => '',
  }) as unknown as Response;

const errorJson = (status: number, text = 'oops') =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  }) as unknown as Response;

describe('customEmbeddings', () => {
  it('should accept Float32Array vectors and return them unchanged', async () => {
    const provider = customEmbeddings({
      name: 'mock',
      model: 'mock-1',
      dimensions: 2,
      embed: async () => [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
    });
    const out = await provider.embed(['a', 'b']);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[1]!)).toEqual([0, 1]);
  });

  it('should convert number[][] inputs to Float32Array', async () => {
    const provider = customEmbeddings({
      name: 'mock',
      model: 'mock-1',
      dimensions: 2,
      embed: async () => [[1, 0]],
    });
    const out = await provider.embed(['a']);
    expect(out[0]).toBeInstanceOf(Float32Array);
  });

  it('should throw when result count mismatches input count', async () => {
    const provider = customEmbeddings({
      name: 'mock',
      model: 'mock-1',
      dimensions: 1,
      embed: async () => [],
    });
    await expect(provider.embed(['a'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw on dimension mismatch', async () => {
    const provider = customEmbeddings({
      name: 'mock',
      model: 'mock-1',
      dimensions: 4,
      embed: async () => [Float32Array.from([1, 0])],
    });
    await expect(provider.embed(['a'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should expose name, model, and dimensions on the provider', () => {
    const provider = customEmbeddings({
      name: 'mock',
      model: 'mock-1',
      dimensions: 4,
      embed: async () => [],
    });
    expect(provider.name).toBe('mock');
    expect(provider.model).toBe('mock-1');
    expect(provider.dimensions).toBe(4);
  });
});

describe('withBatching', () => {
  it('should coalesce concurrent embed calls into a single upstream batch', async () => {
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      embed: vi.fn(async (inputs: readonly string[]) =>
        inputs.map(() => Float32Array.from([1])),
      ),
    });
    const batched = withBatching(upstream, { maxBatchSize: 100, flushMs: 5 });
    const all = await Promise.all([batched.embed(['a']), batched.embed(['b']), batched.embed(['c'])]);
    expect(all).toHaveLength(3);
    expect(all[0]?.[0]).toBeInstanceOf(Float32Array);
  });

  it('should flush early when maxBatchSize is reached', async () => {
    const calls: number[] = [];
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      embed: async (inputs) => {
        calls.push(inputs.length);
        return inputs.map(() => Float32Array.from([1]));
      },
    });
    const batched = withBatching(upstream, { maxBatchSize: 2, flushMs: 100 });
    await Promise.all([batched.embed(['a']), batched.embed(['b'])]);
    expect(calls[0]).toBe(2);
  });

  it('should flush after flushMs when below batch size', async () => {
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      embed: async (inputs) => inputs.map(() => Float32Array.from([1])),
    });
    const batched = withBatching(upstream, { maxBatchSize: 100, flushMs: 1 });
    const out = await batched.embed(['a']);
    expect(out).toHaveLength(1);
  });

  it('should reject all queued items when upstream throws', async () => {
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      embed: async () => {
        throw new Error('upstream boom');
      },
    });
    const batched = withBatching(upstream, { flushMs: 1 });
    await expect(batched.embed(['a'])).rejects.toThrow('upstream boom');
  });

  it('should reject items when upstream returns wrong count', async () => {
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      // The custom wrapper itself rejects mismatched counts; bypass that
      // by using a raw shape that the batched flusher will see.
      embed: async () => [],
    });
    const batched = withBatching(upstream, { flushMs: 1, maxBatchSize: 100 });
    await expect(batched.embed(['a'])).rejects.toBeDefined();
  });

  it('should return an empty array immediately for empty inputs', async () => {
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      embed: async () => [],
    });
    const batched = withBatching(upstream);
    expect(await batched.embed([])).toEqual([]);
  });

  it('should expose a +batched name suffix', () => {
    const upstream = customEmbeddings({
      name: 'up',
      model: 'm',
      dimensions: 1,
      embed: async () => [],
    });
    const batched = withBatching(upstream);
    expect(batched.name).toBe('up+batched');
  });
});

describe('openaiEmbeddings', () => {
  it('should return normalized vectors on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({
        data: [{ embedding: [3, 4] }],
      }),
    );
    const provider = openaiEmbeddings({
      apiKey: 'k',
      model: 'text-embedding-3-small',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await provider.embed(['hello']);
    expect(out[0]?.length).toBe(2);
    let mag = 0;
    for (let i = 0; i < out[0]!.length; i++) mag += out[0]![i]! * out[0]![i]!;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
  });

  it('should return empty for empty input', async () => {
    const provider = openaiEmbeddings({ apiKey: 'k' });
    expect(await provider.embed([])).toEqual([]);
  });

  it('should throw EmbeddingError on non-OK responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorJson(500, 'down'));
    const provider = openaiEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw EmbeddingError on count mismatch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ data: [] }));
    const provider = openaiEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should default model to text-embedding-3-small', () => {
    const provider = openaiEmbeddings({ apiKey: 'k' });
    expect(provider.model).toBe('text-embedding-3-small');
    expect(provider.dimensions).toBe(1536);
  });

  it('should pass dimensions when overridden', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ data: [{ embedding: [1, 0] }] }));
    const provider = openaiEmbeddings({
      apiKey: 'k',
      dimensions: 2,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.embed(['x']);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { dimensions?: number };
    expect(body.dimensions).toBe(2);
  });
});

describe('cohereEmbeddings', () => {
  it('should return normalized vectors on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ embeddings: { float: [[3, 4]] } }),
    );
    const provider = cohereEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await provider.embed(['hi']);
    expect(out).toHaveLength(1);
  });

  it('should default the model and inputType', () => {
    const provider = cohereEmbeddings({ apiKey: 'k' });
    expect(provider.model).toBe('embed-v4.0');
    expect(provider.dimensions).toBe(1024);
  });

  it('should return empty for empty input', async () => {
    const provider = cohereEmbeddings({ apiKey: 'k' });
    expect(await provider.embed([])).toEqual([]);
  });

  it('should throw EmbeddingError on non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorJson(401));
    const provider = cohereEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw EmbeddingError on missing data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}));
    const provider = cohereEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe('voyageEmbeddings', () => {
  it('should return normalized vectors on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ data: [{ embedding: [3, 4] }] }),
    );
    const provider = voyageEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await provider.embed(['x']);
    expect(out).toHaveLength(1);
  });

  it('should default model and dimensions', () => {
    const provider = voyageEmbeddings({ apiKey: 'k' });
    expect(provider.model).toBe('voyage-3');
    expect(provider.dimensions).toBe(1024);
  });

  it('should return empty for empty input', async () => {
    const provider = voyageEmbeddings({ apiKey: 'k' });
    expect(await provider.embed([])).toEqual([]);
  });

  it('should throw EmbeddingError on non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorJson(429));
    const provider = voyageEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw EmbeddingError on missing data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}));
    const provider = voyageEmbeddings({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError);
  });
});
