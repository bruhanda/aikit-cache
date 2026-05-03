import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multiTierStorage } from '../storage/multi-tier.js';
import { memoryStorage } from '../storage/memory.js';
import { makeEntry } from '../core/envelope.js';
import type { CacheStorage, VectorRecord, VectorSearchHit } from '../core/types.js';

let now = 1000;
const clock = { now: () => now };

beforeEach(() => {
  now = 1000;
});

describe('multiTierStorage', () => {
  it('should throw when given an empty tier list', () => {
    expect(() => multiTierStorage([] as never)).toThrow();
  });

  it('should expose a derived name and merged capabilities', () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b]);
    expect(tier.name).toContain('multi-tier');
    expect(tier.capabilities?.prefixScan).toBe(true);
    expect(tier.capabilities?.tagIndex).toBe(true);
    expect(tier.capabilities?.vectorSearch).toBe(false);
  });

  it('should write to every tier in parallel', async () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b], { clock });
    await tier.set('k', makeEntry('v', 1000, now), 1000);
    expect(await a.get('k')).toBeDefined();
    expect(await b.get('k')).toBeDefined();
  });

  it('should backfill upper tiers on lower-tier hit', async () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b], { clock });
    await b.set('k', makeEntry('v', 1000, now), 1000);
    expect(await a.get('k')).toBeUndefined();
    await tier.get('k');
    expect(await a.get('k')).toBeDefined();
  });

  it('should swallow backfill failures without affecting the read result', async () => {
    const broken: CacheStorage = {
      ...memoryStorage({ clock }),
      name: 'broken',
      set: async () => {
        throw new Error('write boom');
      },
    };
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([broken, b], { clock });
    await b.set('k', makeEntry('v', 1000, now), 1000);
    expect(await tier.get('k')).toBeDefined();
  });

  it('should return undefined when no tier has the key', async () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b], { clock });
    expect(await tier.get('absent')).toBeUndefined();
  });

  it('should report deletion when at least one tier confirms', async () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b], { clock });
    await b.set('k', makeEntry('v', 1000, now), 1000);
    expect(await tier.delete('k')).toBe(true);
    expect(await tier.delete('absent')).toBe(false);
  });

  it('should sum invalidate and clear results across tiers', async () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b], { clock });
    await tier.set('k', makeEntry('v', 1000, now), 1000);
    expect(await tier.invalidate({ key: 'k' })).toBe(2);

    await tier.set('k1', makeEntry('v', 1000, now), 1000);
    expect(await tier.clear()).toBe(2);
  });

  it('should compute backfill TTL using injected clock', async () => {
    const a = memoryStorage({ clock });
    const b = memoryStorage({ clock });
    const tier = multiTierStorage([a, b], { clock });
    const entry = makeEntry('v', 1000, now);
    await b.set('k', entry, 1000);
    now += 500;
    await tier.get('k');
    expect(await a.get('k')).toBeDefined();
  });

  it('should expose vector methods when any tier supports vectorSearch', async () => {
    const records: VectorRecord[] = [];
    let nextHits: VectorSearchHit[] = [];
    const vectorTier: CacheStorage = {
      ...memoryStorage({ clock }),
      name: 'vec',
      capabilities: { vectorSearch: true },
      vectorUpsert: async (rs) => {
        records.push(...rs);
      },
      vectorSearch: async () => nextHits,
      vectorDelete: async (ids) => ids.length,
    };
    const tier = multiTierStorage([memoryStorage({ clock }), vectorTier], { clock });
    expect(tier.capabilities?.vectorSearch).toBe(true);
    await tier.vectorUpsert!([{ id: 'a', vector: new Float32Array([1, 0]) }]);
    expect(records).toHaveLength(1);

    nextHits = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.5 },
    ];
    const hits = await tier.vectorSearch!(new Float32Array([1, 0]), 5);
    expect(hits[0]?.score).toBe(0.9);

    expect(await tier.vectorDelete!(['a'])).toBe(1);
  });

  it('should dedupe vectorSearch hits across tiers', async () => {
    let calls = 0;
    const a: CacheStorage = {
      ...memoryStorage({ clock }),
      name: 'a',
      capabilities: { vectorSearch: true },
      vectorSearch: async () => {
        calls += 1;
        return [{ id: 'shared', score: 0.7 }];
      },
    };
    const b: CacheStorage = {
      ...memoryStorage({ clock }),
      name: 'b',
      capabilities: { vectorSearch: true },
      vectorSearch: async () => {
        calls += 1;
        return [
          { id: 'shared', score: 0.5 },
          { id: 'unique', score: 0.4 },
        ];
      },
    };
    const tier = multiTierStorage([a, b], { clock });
    const hits = await tier.vectorSearch!(new Float32Array([1, 0]), 5);
    expect(hits.map((h) => h.id)).toEqual(['shared', 'unique']);
    expect(calls).toBe(2);
  });

  it('should call dispose on every tier that supports it', async () => {
    const a: CacheStorage = { ...memoryStorage({ clock }), name: 'a', dispose: vi.fn(async () => {}) };
    const b: CacheStorage = { ...memoryStorage({ clock }), name: 'b' };
    const tier = multiTierStorage([a, b], { clock });
    await tier.dispose!();
    expect(a.dispose).toHaveBeenCalled();
  });

  it('should compute the minimum maxValueBytes across tiers', () => {
    const a: CacheStorage = {
      ...memoryStorage({ clock }),
      name: 'a',
      capabilities: { maxValueBytes: 1000 },
    };
    const b: CacheStorage = {
      ...memoryStorage({ clock }),
      name: 'b',
      capabilities: { maxValueBytes: 500 },
    };
    const tier = multiTierStorage([a, b], { clock });
    expect(tier.capabilities?.maxValueBytes).toBe(500);
  });
});
