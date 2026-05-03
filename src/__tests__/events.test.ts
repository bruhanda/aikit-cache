import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/events.js';

describe('EventBus', () => {
  it('should fire registered listeners with the typed payload', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on('hit', listener);
    bus.emit('hit', {
      key: 'k',
      from: 'exact',
      entry: { key: 'k', tags: [], createdAt: 0, exp: 1, meta: {} },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ key: 'k', from: 'exact' });
  });

  it('should support multiple listeners on the same event', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('miss', a);
    bus.on('miss', b);
    bus.emit('miss', { key: 'k', reason: 'not-found' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe via the returned disposer', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const off = bus.on('set', listener);
    off();
    bus.emit('set', { key: 'k', ttl: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('should be a no-op when emitting with no listeners', () => {
    const bus = new EventBus();
    expect(() => bus.emit('miss', { key: 'k', reason: 'not-found' })).not.toThrow();
  });

  it('should clear every listener via clear()', () => {
    const bus = new EventBus();
    const a = vi.fn();
    bus.on('hit', a);
    bus.clear();
    bus.emit('hit', {
      key: 'k',
      from: 'exact',
      entry: { key: 'k', tags: [], createdAt: 0, exp: 1, meta: {} },
    });
    expect(a).not.toHaveBeenCalled();
  });

  it('should re-route a listener exception into a synthetic error event', () => {
    const bus = new EventBus();
    const errorListener = vi.fn();
    bus.on('error', errorListener);
    bus.on('miss', () => {
      throw new Error('boom');
    });
    bus.emit('miss', { key: 'k', reason: 'not-found' });
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(errorListener.mock.calls[0]?.[0]).toMatchObject({ operation: 'event-listener' });
  });

  it('should NOT recurse when an error listener itself throws', () => {
    const bus = new EventBus();
    bus.on('error', () => {
      throw new Error('error listener boom');
    });
    bus.on('miss', () => {
      throw new Error('miss boom');
    });
    expect(() => bus.emit('miss', { key: 'k', reason: 'not-found' })).not.toThrow();
  });

  it('should swallow exceptions thrown by error listeners themselves', () => {
    const bus = new EventBus();
    bus.on('error', () => {
      throw new Error('x');
    });
    expect(() => bus.emit('error', { error: new Error('y') as never, operation: 'op' })).not.toThrow();
  });
});
