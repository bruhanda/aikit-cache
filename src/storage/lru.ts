interface Node<V> {
  key: string;
  value: V;
  bytes: number;
  prev: Node<V> | undefined;
  next: Node<V> | undefined;
}

/**
 * Zero-dep doubly-linked-list LRU. Insertion places at the head; eviction
 * walks from the tail. `Map` lookups are O(1) and re-link is O(1).
 *
 * Used as the backing store for `memoryStorage()` and as a building block
 * for `multiTierStorage()` L1 caches.
 */
export class LRU<V = unknown> {
  private readonly map = new Map<string, Node<V>>();
  private head: Node<V> | undefined;
  private tail: Node<V> | undefined;
  private currentBytes = 0;

  constructor(
    private readonly maxEntries: number = 1_000,
    private readonly maxBytes: number = Number.POSITIVE_INFINITY,
    private readonly onEvict?: (key: string, value: V, reason: 'capacity') => void,
  ) {}

  /**
   * Get a value, marking the entry as most-recently-used.
   *
   * @param key Cache key.
   * @returns The stored value, or `undefined` if missing.
   */
  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    this.moveToHead(node);
    return node.value;
  }

  /**
   * Get without touching recency. Used by storage adapters to peek at
   * entries (e.g. for invalidation predicates).
   *
   * @param key Cache key.
   * @returns The stored value, or `undefined` if missing.
   */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  /**
   * Insert or replace an entry, evicting LRU entries to stay under the
   * configured `max` and `maxBytes` caps.
   *
   * @param key Cache key.
   * @param value Stored value.
   * @param bytes Approximate byte size of the entry. Default `0`.
   */
  set(key: string, value: V, bytes = 0): void {
    const existing = this.map.get(key);
    if (existing) {
      this.currentBytes -= existing.bytes;
      existing.value = value;
      existing.bytes = bytes;
      this.currentBytes += bytes;
      this.moveToHead(existing);
    } else {
      const node: Node<V> = { key, value, bytes, prev: undefined, next: undefined };
      this.map.set(key, node);
      this.currentBytes += bytes;
      this.attachAtHead(node);
    }
    this.evictIfNeeded();
  }

  /**
   * Remove a single entry.
   *
   * @param key Cache key.
   * @returns `true` if anything was removed.
   */
  delete(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.detach(node);
    this.map.delete(key);
    this.currentBytes -= node.bytes;
    return true;
  }

  /** Drop every entry. */
  clear(): void {
    this.map.clear();
    this.head = undefined;
    this.tail = undefined;
    this.currentBytes = 0;
  }

  /** Number of stored entries. */
  size(): number {
    return this.map.size;
  }

  /** Approximate total bytes across stored entries. */
  bytes(): number {
    return this.currentBytes;
  }

  /** Iterate keys in MRU-first order. */
  *keys(): IterableIterator<string> {
    let node = this.head;
    while (node) {
      yield node.key;
      node = node.next;
    }
  }

  /** Iterate `[key, value]` pairs in MRU-first order. */
  *entries(): IterableIterator<[string, V]> {
    let node = this.head;
    while (node) {
      yield [node.key, node.value];
      node = node.next;
    }
  }

  private attachAtHead(node: Node<V>): void {
    node.prev = undefined;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private detach(node: Node<V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }

  private moveToHead(node: Node<V>): void {
    if (this.head === node) return;
    this.detach(node);
    this.attachAtHead(node);
  }

  private evictIfNeeded(): void {
    while (
      this.tail &&
      (this.map.size > this.maxEntries || this.currentBytes > this.maxBytes)
    ) {
      const victim = this.tail;
      this.detach(victim);
      this.map.delete(victim.key);
      this.currentBytes -= victim.bytes;
      this.onEvict?.(victim.key, victim.value, 'capacity');
    }
  }
}
