import { describe, expect, it } from 'vitest';
import {
  CacheError,
  ConfigError,
  CostError,
  EmbeddingError,
  formatErrorMessage,
  InvalidationError,
  InvariantError,
  StorageError,
  StreamError,
  WebCryptoUnavailableError,
} from '../errors/index.js';

describe('formatErrorMessage', () => {
  it('should append the docs link when not in production', () => {
    const env = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    try {
      const msg = formatErrorMessage('boom', 'INVARIANT');
      expect(msg).toContain('boom');
      expect(msg).toContain('error-invariant');
    } finally {
      if (env === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = env;
    }
  });

  it('should suppress the docs link when in production', () => {
    const env = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(formatErrorMessage('boom', 'INVARIANT')).toBe('boom');
    } finally {
      if (env === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = env;
    }
  });
});

describe('InvariantError', () => {
  it('should set code INVARIANT and inherit from CacheError', () => {
    const e = new InvariantError('x');
    expect(e).toBeInstanceOf(CacheError);
    expect(e).toBeInstanceOf(InvariantError);
    expect(e.code).toBe('INVARIANT');
    expect(e.name).toBe('InvariantError');
    expect(e.message).toContain('x');
  });

  it('should preserve the cause when supplied', () => {
    const cause = new Error('root');
    const e = new InvariantError('x', { cause });
    expect(e.cause).toBe(cause);
  });
});

describe('WebCryptoUnavailableError', () => {
  it('should set code WEB_CRYPTO_UNAVAILABLE with default message when none given', () => {
    const e = new WebCryptoUnavailableError();
    expect(e.code).toBe('WEB_CRYPTO_UNAVAILABLE');
    expect(e.name).toBe('WebCryptoUnavailableError');
    expect(e.message).toContain('crypto');
  });

  it('should accept a custom message when supplied', () => {
    const e = new WebCryptoUnavailableError('custom');
    expect(e.message).toContain('custom');
  });
});

describe('StorageError', () => {
  it('should expose code, operation, storageName and optional fields', () => {
    const e = new StorageError('STORAGE_GET_FAILED', 'get', 'redis', 'oops', {
      key: 'k',
      bytes: 12,
    });
    expect(e).toBeInstanceOf(CacheError);
    expect(e.code).toBe('STORAGE_GET_FAILED');
    expect(e.operation).toBe('get');
    expect(e.storageName).toBe('redis');
    expect(e.key).toBe('k');
    expect(e.bytes).toBe(12);
    expect(e.name).toBe('StorageError');
  });

  it('should omit optional fields when not supplied', () => {
    const e = new StorageError('STORAGE_SET_FAILED', 'set', 'memory', 'oops');
    expect(e.key).toBeUndefined();
    expect(e.bytes).toBeUndefined();
  });

  it('should preserve a cause', () => {
    const cause = new Error('boom');
    const e = new StorageError('STORAGE_SET_FAILED', 'set', 'memory', 'oops', { cause });
    expect(e.cause).toBe(cause);
  });
});

describe('EmbeddingError', () => {
  it('should expose code, providerName and optional fields', () => {
    const e = new EmbeddingError('EMBEDDING_DIMENSION_MISMATCH', 'openai', 'mismatch', {
      expectedDim: 1536,
      actualDim: 100,
      httpStatus: 500,
    });
    expect(e.code).toBe('EMBEDDING_DIMENSION_MISMATCH');
    expect(e.providerName).toBe('openai');
    expect(e.expectedDim).toBe(1536);
    expect(e.actualDim).toBe(100);
    expect(e.httpStatus).toBe(500);
  });

  it('should omit optional fields when not supplied', () => {
    const e = new EmbeddingError('EMBEDDING_REQUEST_FAILED', 'voyage', 'oops');
    expect(e.expectedDim).toBeUndefined();
    expect(e.actualDim).toBeUndefined();
    expect(e.httpStatus).toBeUndefined();
  });
});

describe('StreamError', () => {
  it('should expose code and optional serializer ids', () => {
    const e = new StreamError('STREAM_SERIALIZER_MISMATCH', 'mismatch', {
      serializerId: 'a',
      storedSerializerId: 'b',
    });
    expect(e.code).toBe('STREAM_SERIALIZER_MISMATCH');
    expect(e.serializerId).toBe('a');
    expect(e.storedSerializerId).toBe('b');
  });

  it('should omit ids when not supplied', () => {
    const e = new StreamError('STREAM_API_UNAVAILABLE', 'no api');
    expect(e.serializerId).toBeUndefined();
    expect(e.storedSerializerId).toBeUndefined();
  });
});

describe('InvalidationError', () => {
  it('should expose code and optional storageName', () => {
    const e = new InvalidationError('INVALIDATION_NOT_SUPPORTED', 'no', { storageName: 'kv' });
    expect(e.code).toBe('INVALIDATION_NOT_SUPPORTED');
    expect(e.storageName).toBe('kv');
  });

  it('should omit storageName when not supplied', () => {
    const e = new InvalidationError('INVALIDATION_PATTERN_INVALID', 'bad');
    expect(e.storageName).toBeUndefined();
  });
});

describe('ConfigError', () => {
  it('should expose code and optional field', () => {
    const e = new ConfigError('CACHE_INVALID_OPTIONS', 'oops', { field: 'storage' });
    expect(e.code).toBe('CACHE_INVALID_OPTIONS');
    expect(e.field).toBe('storage');
  });

  it('should omit field when not supplied', () => {
    const e = new ConfigError('CACHE_DISPOSED', 'gone');
    expect(e.field).toBeUndefined();
  });
});

describe('CostError', () => {
  it('should expose code and optional model', () => {
    const e = new CostError('COST_UNKNOWN_MODEL', 'no model', { model: 'gpt-zz' });
    expect(e.code).toBe('COST_UNKNOWN_MODEL');
    expect(e.model).toBe('gpt-zz');
  });

  it('should omit model when not supplied', () => {
    const e = new CostError('COST_INVALID_PRICING', 'bad');
    expect(e.model).toBeUndefined();
  });
});

describe('CacheError instanceof contract', () => {
  it('should support cross-realm style instanceof for every subclass', () => {
    const errors: CacheError[] = [
      new InvariantError('x'),
      new WebCryptoUnavailableError(),
      new StorageError('STORAGE_GET_FAILED', 'get', 's', 'm'),
      new EmbeddingError('EMBEDDING_REQUEST_FAILED', 'p', 'm'),
      new StreamError('STREAM_API_UNAVAILABLE', 'm'),
      new InvalidationError('INVALIDATION_PATTERN_INVALID', 'm'),
      new ConfigError('CACHE_DISPOSED', 'm'),
      new CostError('COST_UNKNOWN_MODEL', 'm'),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(CacheError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});
