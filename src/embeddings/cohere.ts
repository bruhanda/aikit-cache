import { EmbeddingError } from '../errors/embedding-error.js';
import { normalizeVector } from '../internal/vector.js';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'embed-v4.0';
const DEFAULT_DIMENSIONS: Readonly<Record<string, number>> = Object.freeze({
  'embed-v4.0': 1024,
  'embed-multilingual-v3.0': 1024,
  'embed-english-v3.0': 1024,
  'embed-english-light-v3.0': 384,
});

/**
 * Cohere embeddings via the REST API.
 *
 * @param options API key, model, and inputType (Cohere requires this).
 * @returns A standard `EmbeddingProvider`.
 */
export function cohereEmbeddings(options: {
  readonly apiKey: string;
  readonly model?:
    | 'embed-v4.0'
    | 'embed-multilingual-v3.0'
    | 'embed-english-v3.0'
    | 'embed-english-light-v3.0'
    | (string & {});
  readonly inputType?: 'search_query' | 'search_document' | 'classification' | 'clustering';
  readonly fetch?: typeof fetch;
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = DEFAULT_DIMENSIONS[model] ?? 1024;
  const inputType = options.inputType ?? 'search_query';
  const f = options.fetch ?? fetch;

  return {
    name: 'cohere',
    model,
    dimensions,
    async embed(inputs) {
      if (inputs.length === 0) return [];
      const res = await f('https://api.cohere.ai/v2/embed', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          texts: inputs,
          input_type: inputType,
          embedding_types: ['float'],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          'cohere',
          `cohere embeddings failed (${res.status}): ${text}`,
          { httpStatus: res.status },
        );
      }
      const json = (await res.json()) as { embeddings?: { float?: ReadonlyArray<readonly number[]> } };
      const arr = json.embeddings?.float;
      if (!arr || arr.length !== inputs.length) {
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          'cohere',
          `cohere returned ${arr?.length ?? 0} embeddings, expected ${inputs.length}`,
        );
      }
      return arr.map((row) => normalizeVector(Float32Array.from(row)));
    },
  };
}
