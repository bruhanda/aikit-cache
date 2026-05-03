import { describe, expect, it } from 'vitest';
import {
  extractCacheRequestFromBody,
  extractParams,
} from '../adapters/_shared/extract.js';

describe('extractCacheRequestFromBody', () => {
  it('should return undefined for non-objects', () => {
    expect(extractCacheRequestFromBody(null)).toBeUndefined();
    expect(extractCacheRequestFromBody('x')).toBeUndefined();
    expect(extractCacheRequestFromBody(42)).toBeUndefined();
  });

  it('should return undefined when model is missing', () => {
    expect(extractCacheRequestFromBody({ messages: [] })).toBeUndefined();
  });

  it('should build a chat request when messages is an array', () => {
    const req = extractCacheRequestFromBody({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    });
    expect(req?.model).toBe('gpt-4o');
    expect(req?.messages).toHaveLength(1);
    expect(req?.params?.['temperature']).toBe(0.5);
  });

  it('should build an input request when messages is missing', () => {
    const req = extractCacheRequestFromBody({ model: 'gpt-4o', input: 'hi' });
    expect(req?.input).toMatchObject({ model: 'gpt-4o', input: 'hi' });
  });

  it('should expose tools when present as array', () => {
    const req = extractCacheRequestFromBody({
      model: 'gpt-4o',
      messages: [],
      tools: [{ type: 'function', name: 'fn' }],
    });
    expect(req?.tools).toHaveLength(1);
  });
});

describe('extractParams', () => {
  it('should strip model, messages, tools, stream and stream_options', () => {
    const out = extractParams({
      model: 'm',
      messages: [],
      tools: [],
      stream: true,
      stream_options: {},
      temperature: 0,
      foo: 1,
    });
    expect(out).toEqual({ temperature: 0, foo: 1 });
  });
});
