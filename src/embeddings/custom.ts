import { EmbeddingError } from '../errors/embedding-error.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Wrap a user-supplied embedding function as an `EmbeddingProvider`.
 * Accepts both `Float32Array[]` and `number[][]` returns and converts the
 * latter automatically.
 *
 * @param options Provider metadata and `embed` callback.
 * @returns A standard `EmbeddingProvider`.
 *
 * @example
 * const provider = customEmbeddings({
 *   name: 'mock', model: 'mock-1', dimensions: 4,
 *   embed: async (xs) => xs.map(() => [1, 0, 0, 0]),
 * });
 */
export function customEmbeddings(options: {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  readonly embed: (
    inputs: readonly string[],
  ) => Promise<readonly Float32Array[] | readonly number[][]>;
}): EmbeddingProvider {
  return {
    name: options.name,
    model: options.model,
    dimensions: options.dimensions,
    async embed(inputs) {
      const result = await options.embed(inputs);
      if (result.length !== inputs.length) {
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          options.name,
          `expected ${inputs.length} embeddings, got ${result.length}`,
        );
      }
      return result.map((v, i) => {
        const arr = v instanceof Float32Array ? v : Float32Array.from(v as readonly number[]);
        if (arr.length !== options.dimensions) {
          throw new EmbeddingError(
            'EMBEDDING_DIMENSION_MISMATCH',
            options.name,
            `embedding ${i} has ${arr.length} dimensions, expected ${options.dimensions}`,
            { expectedDim: options.dimensions, actualDim: arr.length },
          );
        }
        return arr;
      });
    },
  };
}
