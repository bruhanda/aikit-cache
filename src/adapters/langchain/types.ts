/**
 * Minimal structural shape of LangChain's `BaseCache` — `import type` only,
 * we do not extend the actual class at runtime to keep the adapter free of
 * a hard `@langchain/core` dependency.
 */
export interface Generation {
  readonly text: string;
  readonly generationInfo?: Record<string, unknown>;
}
