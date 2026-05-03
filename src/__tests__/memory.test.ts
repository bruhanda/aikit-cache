import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../storage/memory.js';
import { makeEntry } from '../core/envelope.js';

let now = 0;
const clock = { now: () => now };

beforeEach(() => {
  now = 0;
});

describe('memoryStorage', () => {
  it('should advertise prefixScan and tagIndex capabilities', () => {
    const s = memoryStorage();
    expect(s.capabilities?.prefixScan).toBe(true);
    expect(s.capabilities?.tagIndex).toBe(true);
    expect(s.capabilities?.vectorSearch).toBe(false);
  });

  it('should round-trip values', async () => {
    const s = memoryStorage({ clock });
    const entry = makeEntry('v', 1000, now);
    await s.set('k', entry, 1000);
    const got = await s.get('k');
    expect(got).toEqual(entry);
  });

  it('should return undefined for missing keys', async () => {
    const s = memoryStorage({ clock });
    expect(await s.get('absent')).toBeUndefined();
  });

  it('should expire entries lazily on get', async () => {
    const s = memoryStorage({ clock });
    const entry = makeEntry('v', 100, now);
    await s.set('k', entry, 100);
    now += 200;
    expect(await s.get('k')).toBeUndefined();
  });

  it('should delete keys', async () => {
    const s = memoryStorage({ clock });
    const entry = makeEntry('v', 1000, now);
    await s.set('k', entry, 1000);
    expect(await s.delete('k')).toBe(true);
    expect(await s.delete('k')).toBe(false);
  });

  it('should invalidate by key', async () => {
    const s = memoryStorage({ clock });
    await s.set('k', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ key: 'k' })).toBe(1);
    expect(await s.invalidate({ key: 'absent' })).toBe(0);
  });

  it('should invalidate by prefix', async () => {
    const s = memoryStorage({ clock });
    await s.set('a:1', makeEntry('v', 1000, now), 1000);
    await s.set('a:2', makeEntry('v', 1000, now), 1000);
    await s.set('b:1', makeEntry('v', 1000, now), 1000);
    expect(await s.invalidate({ prefix: 'a:' })).toBe(2);
  });

  it('should invalidate by tag', async () => {
    const s = memoryStorage({ clock });
    await s.set('k1', makeEntry('v', 1000, now, { tags: ['x'] }), 1000);
    await s.set('k2', makeEntry('v', 1000, now, { tags: ['y'] }), 1000);
    expect(await s.invalidate({ tag: 'x' })).toBe(1);
    expect(await s.get('k1')).toBeUndefined();
    expect(await s.get('k2')).toBeDefined();
  });

  it('should invalidate by predicate', async () => {
    const s = memoryStorage({ clock });
    await s.set('k1', makeEntry('v', 1000, now), 1000);
    await s.set('k2', makeEntry('v', 1000, now), 1000);
    const removed = await s.invalidate({
      predicate: (entry) => entry.key === 'k1',
    });
    expect(removed).toBe(1);
  });

  it('should clear and report removed count', async () => {
    const s = memoryStorage({ clock });
    await s.set('k1', makeEntry('v', 1000, now), 1000);
    await s.set('k2', makeEntry('v', 1000, now), 1000);
    expect(await s.clear()).toBe(2);
  });

  it('should fire onEvict for capacity and ttl evictions', async () => {
    const onEvict = vi.fn();
    const s = memoryStorage({ clock, max: 1, onEvict });
    await s.set('a', makeEntry('v', 1000, now), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(onEvict).toHaveBeenCalledWith('a', 'capacity');
    now += 2000;
    await s.get('b'); // triggers TTL eviction
    expect(onEvict).toHaveBeenCalledWith('b', 'ttl');
  });

  it('should accept a custom sizeOf', async () => {
    const s = memoryStorage({ clock, sizeOf: () => 1, maxBytes: 1, max: Infinity });
    await s.set('a', makeEntry('v', 1000, now), 1000);
    await s.set('b', makeEntry('v', 1000, now), 1000);
    expect(await s.get('a')).toBeUndefined();
    expect(await s.get('b')).toBeDefined();
  });

  it('should fall back to 0 bytes when sizeOf throws', async () => {
    const s = memoryStorage({
      clock,
      sizeOf: () => {
        throw new Error('size boom');
      },
    });
    await expect(s.set('a', makeEntry('v', 1000, now), 1000)).resolves.toBeUndefined();
  });

  it('should fall back to 0 bytes when canonical default sizeOf throws', async () => {
    const s = memoryStorage({ clock });
    // Inject a value that breaks canonicalJSON (NaN throws InvariantError).
    const entry = makeEntry(NaN, 1000, now);
    // This just exercises the safeSizeOf path; the set itself should succeed.
    await s.set('a', entry, 1000);
    expect(await s.get('a')).toBeDefined();
  });
});
