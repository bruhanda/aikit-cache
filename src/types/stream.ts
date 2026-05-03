/**
 * Generic streaming chunk discriminated union — adapters can map provider
 * chunk types onto this shape, but the cache layer treats each chunk as
 * opaque and only round-trips it through the configured `ChunkSerializer`.
 */
export type Chunk<T = unknown> =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly type: 'finish'; readonly reason?: string }
  | { readonly type: 'error'; readonly error: unknown }
  | { readonly type: 'raw'; readonly raw: T };

/**
 * Pluggable serializer used by `wrapStream` to persist captured chunks and
 * deserialize them on replay.
 *
 * Every implementation must provide a stable `id`. The id is stamped onto
 * the cached envelope's `meta.serializerId`; on replay, the cache refuses
 * to deserialize an entry whose stored id does not match the configured
 * serializer's id (raises `STREAM_REPLAY_FAILED`). Without this fingerprint
 * two serializers consuming the same wire shape would silently feed garbage
 * into the wrong deserializer.
 */
export interface ChunkSerializer<TChunk> {
  /** Stable unique identifier — e.g. `'openai-stream-v1'`, `'ai-sdk-stream-v1'`. */
  readonly id: string;
  serialize(chunks: readonly TChunk[]): string | Uint8Array;
  deserialize(data: string | Uint8Array): readonly TChunk[];
}

/**
 * Optional per-chunk timing record used by `chunkDelayMs: 'preserve'` to
 * reproduce the original network cadence on replay.
 */
export interface TimedChunks<TChunk> {
  readonly chunks: readonly TChunk[];
  readonly timings?: readonly number[];
}
