import { StreamError } from '../errors/stream-error.js';
import { fromBase64Url, toBase64Url } from '../internal/encoding.js';
import type { ChunkSerializer } from '../types/stream.js';

/**
 * Probe `ReadableStream` and `ReadableStream.tee` defensively. All supported
 * runtimes expose them — we throw a precise diagnostic otherwise instead of
 * letting the user chase a generic `TypeError`.
 */
export function assertStreamApi(): void {
  const g = globalThis as { ReadableStream?: typeof ReadableStream };
  if (typeof g.ReadableStream !== 'function') {
    throw new StreamError('STREAM_API_UNAVAILABLE', 'ReadableStream is not available in this runtime');
  }
  const proto = g.ReadableStream.prototype as { tee?: unknown };
  if (typeof proto.tee !== 'function') {
    throw new StreamError('STREAM_API_UNAVAILABLE', 'ReadableStream.prototype.tee is not available in this runtime');
  }
}

/**
 * Tee an upstream stream into a consumer-side branch and a capture branch.
 * The capture branch drains in the background, accumulating chunks (and
 * optional inter-chunk timings) for later replay.
 *
 * @param upstream Upstream `ReadableStream`.
 * @param now Clock function returning ms since epoch.
 * @returns Object with the consumer stream and a Promise that resolves with
 *   the captured chunks plus timing info on upstream close. The promise
 *   rejects only on capture-branch errors (consumer errors propagate via
 *   the consumer stream as usual).
 */
export function teeWithCapture<TChunk>(
  upstream: ReadableStream<TChunk>,
  now: () => number,
): {
  consumer: ReadableStream<TChunk>;
  captured: Promise<{ chunks: TChunk[]; timings: number[] }>;
} {
  assertStreamApi();
  const [a, b] = upstream.tee();
  const consumer = a as ReadableStream<TChunk>;
  const capture = b as ReadableStream<TChunk>;
  const captured = drainCapture(capture, now);
  return { consumer, captured };
}

async function drainCapture<TChunk>(
  branch: ReadableStream<TChunk>,
  now: () => number,
): Promise<{ chunks: TChunk[]; timings: number[] }> {
  const reader = branch.getReader();
  const chunks: TChunk[] = [];
  const timings: number[] = [];
  let last = now();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const t = now();
      timings.push(t - last);
      last = t;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { chunks, timings };
}

/**
 * Build a `ReadableStream` that replays a captured chunk array. Supports
 * three cadences via `chunkDelayMs`:
 *   - `'preserve'` reproduces the original inter-chunk timings (within ±5 ms);
 *   - `'instant'` flushes as fast as the consumer reads;
 *   - a `number` applies a uniform delay (ms) between every chunk.
 *
 * @param chunks Captured chunks.
 * @param timings Optional inter-chunk timings used when `chunkDelayMs === 'preserve'`.
 * @param chunkDelayMs Cadence policy.
 * @returns A `ReadableStream<TChunk>` ready for the consumer.
 */
export function replayStream<TChunk>(
  chunks: readonly TChunk[],
  timings: readonly number[] | undefined,
  chunkDelayMs: 'preserve' | 'instant' | number = 'instant',
): ReadableStream<TChunk> {
  return new ReadableStream<TChunk>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        const delay =
          chunkDelayMs === 'instant'
            ? 0
            : chunkDelayMs === 'preserve'
              ? timings?.[i] ?? 0
              : chunkDelayMs;
        if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
        controller.enqueue(chunks[i]!);
      }
      controller.close();
    },
  });
}

/**
 * Wire-format envelope persisted alongside streaming entries. `data` holds
 * the serializer's output (string or bytes); `serializerId` matches the
 * configured serializer so replay refuses on mismatch.
 */
export interface StreamEnvelope {
  readonly serializerId: string;
  readonly data: string | { readonly $bytes: string };
  readonly timings?: readonly number[];
}

/**
 * Serialize a captured stream into the persisted envelope shape.
 *
 * @param serializer The configured `ChunkSerializer`.
 * @param chunks Captured chunks.
 * @param timings Optional per-chunk timings.
 * @returns Serializable envelope.
 * @throws {StreamError} `STREAM_CAPTURE_FAILED` when the serializer rejects the chunks.
 */
export function serializeStreamEnvelope<TChunk>(
  serializer: ChunkSerializer<TChunk>,
  chunks: readonly TChunk[],
  timings: readonly number[] | undefined,
): StreamEnvelope {
  let serialized: string | Uint8Array;
  try {
    serialized = serializer.serialize(chunks);
  } catch (cause) {
    throw new StreamError('STREAM_CAPTURE_FAILED', 'serializer threw during capture', {
      cause,
      serializerId: serializer.id,
    });
  }
  const data: StreamEnvelope['data'] =
    typeof serialized === 'string' ? serialized : { $bytes: toBase64Url(serialized) };
  return timings ? { serializerId: serializer.id, data, timings } : { serializerId: serializer.id, data };
}

/**
 * Deserialize a persisted envelope into chunks. Refuses on serializer-id
 * mismatch with `STREAM_REPLAY_FAILED` so two serializers consuming the
 * same wire shape can never silently feed garbage into the wrong decoder.
 *
 * @param serializer Configured serializer.
 * @param envelope Loaded envelope.
 * @returns Tuple of decoded chunks and optional timings.
 * @throws {StreamError} on id mismatch or deserialization failure.
 */
export function deserializeStreamEnvelope<TChunk>(
  serializer: ChunkSerializer<TChunk>,
  envelope: StreamEnvelope,
): { chunks: readonly TChunk[]; timings?: readonly number[] } {
  if (envelope.serializerId !== serializer.id) {
    throw new StreamError(
      'STREAM_SERIALIZER_MISMATCH',
      `serializer id mismatch: stored '${envelope.serializerId}', configured '${serializer.id}'`,
      { serializerId: serializer.id, storedSerializerId: envelope.serializerId },
    );
  }
  const data: string | Uint8Array =
    typeof envelope.data === 'string' ? envelope.data : fromBase64Url(envelope.data.$bytes);
  let chunks: readonly TChunk[];
  try {
    chunks = serializer.deserialize(data);
  } catch (cause) {
    throw new StreamError('STREAM_REPLAY_FAILED', 'serializer threw during replay', {
      cause,
      serializerId: serializer.id,
    });
  }
  return envelope.timings ? { chunks, timings: envelope.timings } : { chunks };
}

