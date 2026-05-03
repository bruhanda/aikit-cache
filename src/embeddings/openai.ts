import { EmbeddingError } from '../errors/embedding-error.js';
import { normalizeVector } from '../internal/vector.js';
import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS: Readonly<Record<string, number>> = Object.freeze({
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
});

/**
 * OpenAI embeddings via the REST API. No SDK runtime dependency — uses
 * `fetch` directly so the adapter works in edge runtimes.
 *
 * @param options API key and optional model / dimensions / fetch override.
 * @returns A standard `EmbeddingProvider`.
 *
 * @example
 * const embeddings = openaiEmbeddings({ apiKey: process.env.OPENAI_API_KEY! });
 */
export function openaiEmbeddings(options: {
  readonly apiKey: string;
  readonly model?:
    | 'text-embedding-3-small'
    | 'text-embedding-3-large'
    | 'text-embedding-ada-002'
    | (string & {});
  readonly dimensions?: number;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS[model] ?? 1536;
  const f = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');

  return {
    name: 'openai',
    model,
    dimensions,
    async embed(inputs) {
      if (inputs.length === 0) return [];
      const body: { model: string; input: readonly string[]; dimensions?: number } = {
        model,
        input: inputs,
      };
      if (options.dimensions !== undefined) body.dimensions = options.dimensions;

      const res = await f(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          'openai',
          `openai embeddings failed (${res.status}): ${text}`,
          { httpStatus: res.status },
        );
      }
      const json = (await res.json()) as { data?: ReadonlyArray<{ embedding: readonly number[] }> };
      if (!json.data || json.data.length !== inputs.length) {
        throw new EmbeddingError(
          'EMBEDDING_REQUEST_FAILED',
          'openai',
          `openai returned ${json.data?.length ?? 0} embeddings, expected ${inputs.length}`,
        );
      }
      return json.data.map((row) => normalizeVector(Float32Array.from(row.embedding)));
    },
  };
}
