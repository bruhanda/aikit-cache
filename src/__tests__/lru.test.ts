import { describe, expect, it, vi } from 'vitest';
import { LRU } from '../storage/lru.js';

describe('LRU', () => {
  it('should store and retrieve values', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A');
    expect(lru.get('a')).toBe('A');
  });

  it('should return undefined for missing keys', () => {
    const lru = new LRU<string>();
    expect(lru.get('absent')).toBeUndefined();
  });

  it('should evict the least-recently-used entry past max', () => {
    const lru = new LRU<string>(2);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.set('c', 'C');
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe('B');
    expect(lru.get('c')).toBe('C');
  });

  it('should mark touched entries as MRU', () => {
    const lru = new LRU<string>(2);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.get('a');
    lru.set('c', 'C');
    expect(lru.get('a')).toBe('A');
    expect(lru.get('b')).toBeUndefined();
  });

  it('should support peek without changing recency', () => {
    const lru = new LRU<string>(2);
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.peek('a');
    lru.set('c', 'C');
    expect(lru.get('a')).toBeUndefined();
  });

  it('should evict by maxBytes cap', () => {
    const lru = new LRU<string>(100, 5);
    lru.set('a', 'A', 3);
    lru.set('b', 'B', 3);
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe('B');
  });

  it('should call onEvict on capacity-driven eviction', () => {
    const onEvict = vi.fn();
    const lru = new LRU<string>(1, Infinity, onEvict);
    lru.set('a', 'A', 1);
    lru.set('b', 'B', 1);
    expect(onEvict).toHaveBeenCalledWith('a', 'A', 'capacity');
  });

  it('should accumulate bytes correctly', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A', 5);
    lru.set('b', 'B', 7);
    expect(lru.bytes()).toBe(12);
  });

  it('should adjust bytes when overwriting an entry', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A', 5);
    lru.set('a', 'A2', 10);
    expect(lru.bytes()).toBe(10);
    expect(lru.size()).toBe(1);
    expect(lru.get('a')).toBe('A2');
  });

  it('should delete entries and return whether one existed', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A', 3);
    expect(lru.delete('a')).toBe(true);
    expect(lru.delete('a')).toBe(false);
    expect(lru.size()).toBe(0);
    expect(lru.bytes()).toBe(0);
  });

  it('should clear every entry', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.clear();
    expect(lru.size()).toBe(0);
    expect(lru.bytes()).toBe(0);
    expect(lru.get('a')).toBeUndefined();
  });

  it('should iterate keys in MRU-first order', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A');
    lru.set('b', 'B');
    lru.set('c', 'C');
    lru.get('a');
    expect(Array.from(lru.keys())).toEqual(['a', 'c', 'b']);
  });

  it('should iterate entries in MRU-first order', () => {
    const lru = new LRU<string>();
    lru.set('a', 'A');
    lru.set('b', 'B');
    expect(Array.from(lru.entries())).toEqual([
      ['b', 'B'],
      ['a', 'A'],
    ]);
  });

  it('should return size of stored entries', () => {
    const lru = new LRU<string>();
    expect(lru.size()).toBe(0);
    lru.set('a', 'A');
    expect(lru.size()).toBe(1);
  });
});
