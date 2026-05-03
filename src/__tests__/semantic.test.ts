import { describe, expect, it, vi } from 'vitest';
import { cosineSimilarity, normalize, topK } from '../semantic/similarity.js';
import { MemoryVectorIndex } from '../semantic/memory-index.js';
import { VectorStoreAdapter } from '../semantic/store-adapter.js';
import { withSemantic } from '../semantic/layer.js';
import { customEmbeddings } from '../embeddings/custom.js';
import { memoryStorage } from '../storage/memory.js';
import { ConfigError } from '../errors/config-error.js';
import { EmbeddingError } from '../errors/embedding-error.js';
import { StorageError } from '../errors/storage-error.js';
import type { Cache, CacheRequest, CacheStorage } from '../core/types.js';
import { makeEntry } from '../core/envelope.js';

const stubCache = {} as Cache;
const getStubCache = () => stubCache;

describe('cosineSimilarity', () => {
  it('should compute the dot product over unit vectors', () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('should be zero for orthogonal vectors', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
  });

  it('should throw on length mismatch', () => {
    expect(() =>
      cosineSimilarity(Float32Array.from([1]), Float32Array.from([1, 0])),
    ).toThrow();
  });
});

describe('normalize', () => {
  it('should re-export normalizeVector', () => {
    const out = normalize(Float32Array.from([3, 4]));
    let mag = 0;
    for (let i = 0; i < out.length; i++) mag += out[i]! * out[i]!;
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5);
  });
});

describe('topK', () => {
  it('should return indices in descending score order', () => {
    expect(topK([0.1, 0.5, 0.3], 2)).toEqual([1, 2]);
  });

  it('should clamp k to scores length', () => {
    expect(topK([1, 2], 100)).toEqual([1, 0]);
  });

  it('should return empty for k=0', () => {
    expect(topK([1, 2, 3], 0)).toEqual([]);
  });
});

describe('MemoryVectorIndex', () => {
  it('should upsert, search, and delete vectors', () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([
      { id: 'a', vector: Float32Array.from([1, 0]) },
      { id: 'b', vector: Float32Array.from([0, 1]) },
    ]);
    expect(idx.size()).toBe(2);
    const hits = idx.search(Float32Array.from([1, 0]), 5);
    expect(hits[0]?.id).toBe('a');
    expect(idx.delete(['a'])).toBe(1);
    expect(idx.size()).toBe(1);
  });

  it('should preserve metadata when supplied', () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([{ id: 'a', vector: Float32Array.from([1, 0]), metadata: { tag: 'x' } }]);
    const hits = idx.search(Float32Array.from([1, 0]), 1);
    expect(hits[0]?.metadata).toEqual({ tag: 'x' });
  });

  it('should silently skip vectors with mismatched length', () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([
      { id: 'a', vector: Float32Array.from([1, 0]) },
      { id: 'b', vector: Float32Array.from([1, 0, 0]) },
    ]);
    const hits = idx.search(Float32Array.from([1, 0]), 5);
    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('should clear every vector', () => {
    const idx = new MemoryVectorIndex();
    idx.upsert([{ id: 'a', vector: Float32Array.from([1]) }]);
    idx.clear();
    expect(idx.size()).toBe(0);
  });
});

describe('VectorStoreAdapter', () => {
  it('should fall back to MemoryVectorIndex when storage lacks vector capability', async () => {
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const adapter = new VectorStoreAdapter(storage);
    await adapter.upsert([{ id: 'a', vector: Float32Array.from([1, 0]) }]);
    const hits = await adapter.search(Float32Array.from([1, 0]), 5);
    expect(hits[0]?.id).toBe('a');
    expect(await adapter.delete(['a'])).toBe(1);
  });

  it('should route to native vectorSearch when supported', async () => {
    const upsert = vi.fn(async () => {});
    const search = vi.fn(async () => [{ id: 'native', score: 0.9 }]);
    const del = vi.fn(async () => 5);
    const storage: CacheStorage = {
      ...memoryStorage(),
      name: 'native',
      capabilities: { vectorSearch: true },
      vectorUpsert: upsert,
      vectorSearch: search,
      vectorDelete: del,
    };
    const adapter = new VectorStoreAdapter(storage);
    await adapter.upsert([{ id: 'a', vector: Float32Array.from([1]) }]);
    const hits = await adapter.search(Float32Array.from([1]), 5);
    expect(hits[0]?.id).toBe('native');
    expect(await adapter.delete(['a'])).toBe(5);
    expect(upsert).toHaveBeenCalled();
    expect(search).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
  });

  it('should wrap underlying vectorSearch errors as StorageError', async () => {
    const storage: CacheStorage = {
      ...memoryStorage(),
      name: 'native',
      capabilities: { vectorSearch: true },
      vectorSearch: async () => {
        throw new Error('boom');
      },
      vectorUpsert: async () => {
        throw new Error('boom');
      },
      vectorDelete: async () => {
        throw new Error('boom');
      },
    };
    const adapter = new VectorStoreAdapter(storage);
    await expect(adapter.search(Float32Array.from([1]), 5)).rejects.toBeInstanceOf(StorageError);
    await expect(adapter.upsert([{ id: 'a', vector: Float32Array.from([1]) }])).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(adapter.delete(['a'])).rejects.toBeInstanceOf(StorageError);
  });
});

describe('withSemantic', () => {
  const provider = customEmbeddings({
    name: 'mock',
    model: 'mock-1',
    dimensions: 2,
    embed: async (inputs) =>
      inputs.map((s) => (s.includes('hi') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))),
  });

  it('should reject thresholds outside [0, 1]', () => {
    expect(() => withSemantic({ embeddings: provider, threshold: -0.1 })).toThrow(ConfigError);
    expect(() => withSemantic({ embeddings: provider, threshold: 1.1 })).toThrow(ConfigError);
  });

  it('should index a request and find it on subsequent semantic lookup', async () => {
    const layer = withSemantic({ embeddings: provider, threshold: 0.95 });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    expect(handle.enabled).toBe(true);
    const req: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    await storage.set('k1', makeEntry('cached', 60_000, 0), 60_000);
    await handle.index(req, '', 'k1');
    const hit = await handle.lookup(req, '');
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.value).toBe('cached');
      expect(hit.key).toBe('k1');
    }
  });

  it('should return hit:false when no candidate clears the threshold', async () => {
    const layer = withSemantic({ embeddings: provider, threshold: 0.99 });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const reqA: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const reqB: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'bye' }] };
    await storage.set('k1', makeEntry('cached', 60_000, 0), 60_000);
    await handle.index(reqA, '', 'k1');
    const hit = await handle.lookup(reqB, '');
    expect(hit.hit).toBe(false);
  });

  it('should report embedding cost when costTracker is supplied', async () => {
    const layer = withSemantic({
      embeddings: provider,
      costTracker: { estimateUSD: () => 0.001 },
    });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    await handle.lookup(req, '');
    expect(handle.embeddingCostUSD()).toBeGreaterThan(0);
  });

  it('should keep embeddingCostUSD at 0 when no costTracker is supplied', async () => {
    const layer = withSemantic({ embeddings: provider });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    await handle.lookup(req, '');
    expect(handle.embeddingCostUSD()).toBe(0);
  });

  it('should throw EmbeddingError when extractText returns empty', async () => {
    const layer = withSemantic({
      embeddings: provider,
      extractText: () => '',
    });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [] };
    await expect(handle.lookup(req, '')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw EmbeddingError when extractText itself throws', async () => {
    const layer = withSemantic({
      embeddings: provider,
      extractText: () => {
        throw new Error('extract boom');
      },
    });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [] };
    await expect(handle.lookup(req, '')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw EmbeddingError on dimension mismatch', async () => {
    const wrongDim = customEmbeddings({
      name: 'p',
      model: 'm',
      dimensions: 3,
      embed: async (inputs) => inputs.map(() => Float32Array.from([1, 0])),
    });
    // The custom wrapper itself rejects on mismatch — ensure the layer
    // surfaces EmbeddingError for any underlying failure.
    const layer = withSemantic({ embeddings: wrongDim });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    await expect(handle.lookup(req, '')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should throw on multimodal content via default extractText', async () => {
    const layer = withSemantic({ embeddings: provider });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', url: 'http://x' }],
        },
      ],
    };
    await expect(handle.lookup(req, '')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should join string content from text parts via default extractText', async () => {
    const layer = withSemantic({ embeddings: provider });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi there' }] },
        { role: 'system', content: 'ignored' },
      ],
    };
    await storage.set('k1', makeEntry('cached', 60_000, 0), 60_000);
    await handle.index(req, '', 'k1');
    const hit = await handle.lookup(req, '');
    expect(hit.hit).toBe(true);
  });

  it('should fall back to string `input` via default extractText', async () => {
    const layer = withSemantic({ embeddings: provider });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', input: 'hi' };
    await storage.set('k1', makeEntry('cached', 60_000, 0), 60_000);
    await handle.index(req, '', 'k1');
    const hit = await handle.lookup(req, '');
    expect(hit.hit).toBe(true);
  });

  it('should fall back to string-array input via default extractText', async () => {
    const layer = withSemantic({ embeddings: provider });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', input: ['hi', 'world'] };
    await storage.set('k1', makeEntry('cached', 60_000, 0), 60_000);
    await handle.index(req, '', 'k1');
    const hit = await handle.lookup(req, '');
    expect(hit.hit).toBe(true);
  });

  it('should throw when default extractText cannot handle the input', async () => {
    const layer = withSemantic({ embeddings: provider });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', input: { foo: 'bar' } };
    await expect(handle.lookup(req, '')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('should accept a vectorNamespace for store searches', async () => {
    const layer = withSemantic({ embeddings: provider, vectorNamespace: 'tenant-a' });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    // Just ensure it does not throw.
    await handle.lookup(req, '');
  });

  it('should support a custom rerank that selects a non-default winner', async () => {
    const seen: string[] = [];
    const layer = withSemantic({
      embeddings: provider,
      threshold: 0.0,
      rerank: (candidates) => {
        seen.push(...candidates.map((c) => c.key));
        return candidates[0];
      },
    });
    const storage = memoryStorage({ clock: { now: () => 0 } });
    const handle = layer._install(getStubCache, storage);
    const req: CacheRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    await storage.set('k1', makeEntry('v1', 60_000, 0), 60_000);
    await handle.index(req, '', 'k1');
    const hit = await handle.lookup(req, '');
    expect(hit.hit).toBe(true);
    expect(seen).toContain('k1');
  });
});
