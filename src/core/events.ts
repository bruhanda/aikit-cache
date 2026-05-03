import type { CacheError } from '../errors/base.js';
import type { CacheEventListener, CacheEventName } from './types.js';

type AnyListener = (payload: unknown) => void;

/**
 * Tiny typed event bus used by the cache to surface lifecycle and error
 * events. Listener exceptions are caught and re-emitted as synthetic
 * `'error'` events with `operation: 'event-listener'` so a buggy
 * subscriber cannot kill the cache.
 */
export class EventBus {
  private readonly listeners: Map<CacheEventName, Set<AnyListener>> = new Map();

  /**
   * Subscribe to a typed event.
   *
   * @param event Event name.
   * @param listener Typed listener.
   * @returns Synchronous unsubscribe.
   */
  on<E extends CacheEventName>(event: E, listener: CacheEventListener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = listener as AnyListener;
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
    };
  }

  /**
   * Emit a typed event. Listener exceptions become synthetic `'error'`
   * events instead of bubbling out of the emit site.
   *
   * @param event Event name.
   * @param payload Typed payload.
   */
  emit<E extends CacheEventName>(event: E, payload: Parameters<CacheEventListener<E>>[0]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of Array.from(set)) {
      try {
        listener(payload);
      } catch (err) {
        if (event === 'error') continue;
        const errorSet = this.listeners.get('error');
        if (!errorSet) continue;
        const synth = {
          error: err as CacheError,
          operation: 'event-listener',
        };
        for (const errorListener of Array.from(errorSet)) {
          try {
            errorListener(synth);
          } catch {
            // swallow recursive listener bugs
          }
        }
      }
    }
  }

  /** Drop every listener. Used by `cache.dispose()`. */
  clear(): void {
    this.listeners.clear();
  }
}
