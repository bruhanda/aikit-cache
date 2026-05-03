import { EmbeddingError } from '../errors/embedding-error.js';
import { normalizeVector } from '../internal/vector.js';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'voyage-3';
const DEFAULT_DIMENSIONS: Readonly<Record<string, number>> = Object.freeze({
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
  'voyage-large-2': 1536,
});

/**
 * Voyage AI embeddings via the REST API.
 *
 * @param options API key and optional model / fetch override.
 * @returns A standard `EmbeddingProvider`.
 */
export function voyageEmbeddings(options: {
  readonly apiKey: string;
  readonly model?: 'voyage-3' | 'voyage-3-lite' | 'voyage-code-3' | (string & {});
  readonly fetch?: typeof fetch;
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = DEFAULT_DIMENSIONS[model] ?? 1024;
  const f = options.fetch ?? fetch;

  return {
    name: 'voyage',
    model,
    dimensions,
    async embed(inputs) {
      if (inputs.length === 0) return [];
      const res = await f('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: inputs }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          'voyage',
          `voyage embeddings failed (${res.status}): ${text}`,
          { httpStatus: res.status },
        );
      }
      const json = (await res.json()) as { data?: ReadonlyArray<{ embedding: readonly number[] }> };
      if (!json.data || json.data.length !== inputs.length) {
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          'voyage',
          `voyage returned ${json.data?.length ?? 0} embeddings, expected ${inputs.length}`,
        );
      }
      return json.data.map((row) => normalizeVector(Float32Array.from(row.embedding)));
    },
  };
}
