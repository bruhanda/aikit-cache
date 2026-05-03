import { describe, expect, it } from 'vitest';
import {
  assertStreamApi,
  deserializeStreamEnvelope,
  replayStream,
  serializeStreamEnvelope,
  teeWithCapture,
  type StreamEnvelope,
} from '../core/stream.js';
import { StreamError } from '../errors/stream-error.js';
import type { ChunkSerializer } from '../types/stream.js';

const stringSerializer: ChunkSerializer<string> = {
  id: 'string-v1',
  serialize: (chunks) => JSON.stringify(chunks),
  deserialize: (data) =>
    JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as readonly string[],
};

const bytesSerializer: ChunkSerializer<string> = {
  id: 'bytes-v1',
  serialize: (chunks) => new TextEncoder().encode(JSON.stringify(chunks)),
  deserialize: (data) =>
    JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as readonly string[],
};

const upstreamFromArray = <T>(items: readonly T[]): ReadableStream<T> =>
  new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });

const drain = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const reader = stream.getReader();
  const out: T[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
};

describe('assertStreamApi', () => {
  it('should not throw when ReadableStream and tee are present', () => {
    expect(() => assertStreamApi()).not.toThrow();
  });
});

describe('teeWithCapture', () => {
  it('should yield consumer chunks and capture matching chunks/timings', async () => {
    let now = 0;
    const upstream = upstreamFromArray(['a', 'b', 'c']);
    const { consumer, captured } = teeWithCapture(upstream, () => {
      now += 5;
      return now;
    });
    const consumed = await drain(consumer);
    const cap = await captured;
    expect(consumed).toEqual(['a', 'b', 'c']);
    expect(cap.chunks).toEqual(['a', 'b', 'c']);
    expect(cap.timings).toHaveLength(3);
  });

  it('should expose timings reflecting inter-chunk deltas', async () => {
    let now = 0;
    const upstream = upstreamFromArray(['x', 'y']);
    const { consumer, captured } = teeWithCapture(upstream, () => {
      now += 10;
      return now;
    });
    await drain(consumer);
    const cap = await captured;
    expect(cap.timings.length).toBe(2);
    for (const t of cap.timings) expect(t).toBeGreaterThanOrEqual(0);
  });
});

describe('replayStream', () => {
  it('should emit all chunks instantly when chunkDelayMs is "instant"', async () => {
    const stream = replayStream(['a', 'b', 'c'], undefined, 'instant');
    expect(await drain(stream)).toEqual(['a', 'b', 'c']);
  });

  it('should default to instant cadence', async () => {
    const stream = replayStream(['a'], undefined);
    expect(await drain(stream)).toEqual(['a']);
  });

  it('should apply uniform delay when chunkDelayMs is a number', async () => {
    const start = Date.now();
    const stream = replayStream(['a', 'b'], undefined, 5);
    await drain(stream);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });

  it('should preserve timings when chunkDelayMs is "preserve"', async () => {
    const stream = replayStream(['a', 'b'], [0, 1], 'preserve');
    expect(await drain(stream)).toEqual(['a', 'b']);
  });

  it('should be safe when timings are undefined under preserve', async () => {
    const stream = replayStream(['a'], undefined, 'preserve');
    expect(await drain(stream)).toEqual(['a']);
  });
});

describe('serializeStreamEnvelope', () => {
  it('should produce envelope with string data when serializer returns string', () => {
    const env = serializeStreamEnvelope(stringSerializer, ['a', 'b'], undefined);
    expect(env.serializerId).toBe('string-v1');
    expect(typeof env.data).toBe('string');
    expect(env.timings).toBeUndefined();
  });

  it('should encode bytes as $bytes envelope', () => {
    const env = serializeStreamEnvelope(bytesSerializer, ['a', 'b'], undefined);
    expect(typeof env.data).toBe('object');
    expect((env.data as { $bytes: string }).$bytes).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should attach timings when provided', () => {
    const env = serializeStreamEnvelope(stringSerializer, ['a'], [10]);
    expect(env.timings).toEqual([10]);
  });

  it('should throw StreamError when serializer.serialize throws', () => {
    const broken: ChunkSerializer<string> = {
      id: 'broken',
      serialize: () => {
        throw new Error('boom');
      },
      deserialize: () => [],
    };
    expect(() => serializeStreamEnvelope(broken, ['a'], undefined)).toThrow(StreamError);
  });
});

describe('deserializeStreamEnvelope', () => {
  it('should round-trip string-data envelopes', () => {
    const env = serializeStreamEnvelope(stringSerializer, ['x', 'y'], undefined);
    const result = deserializeStreamEnvelope(stringSerializer, env);
    expect(result.chunks).toEqual(['x', 'y']);
  });

  it('should round-trip bytes-data envelopes', () => {
    const env = serializeStreamEnvelope(bytesSerializer, ['x', 'y'], undefined);
    const result = deserializeStreamEnvelope(bytesSerializer, env);
    expect(result.chunks).toEqual(['x', 'y']);
  });

  it('should preserve timings when present', () => {
    const env = serializeStreamEnvelope(stringSerializer, ['x'], [4]);
    const result = deserializeStreamEnvelope(stringSerializer, env);
    expect(result.timings).toEqual([4]);
  });

  it('should throw STREAM_SERIALIZER_MISMATCH when ids differ', () => {
    const env: StreamEnvelope = {
      serializerId: 'other-v1',
      data: '[]',
    };
    expect(() => deserializeStreamEnvelope(stringSerializer, env)).toThrow(StreamError);
  });

  it('should throw STREAM_REPLAY_FAILED when deserializer throws', () => {
    const broken: ChunkSerializer<string> = {
      id: 'string-v1',
      serialize: () => '[]',
      deserialize: () => {
        throw new Error('parse failed');
      },
    };
    const env = serializeStreamEnvelope(stringSerializer, ['x'], undefined);
    expect(() => deserializeStreamEnvelope(broken, env)).toThrow(StreamError);
  });
});
