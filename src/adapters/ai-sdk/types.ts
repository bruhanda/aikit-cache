/**
 * Vercel AI SDK middleware shape (v3+). We only depend on `import type`
 * from `ai`; the package is a peer dep and never imported at runtime.
 */
export interface LanguageModelV3CallOptions {
  readonly inputFormat?: 'messages' | 'prompt' | string;
  readonly mode?: { readonly type: string; readonly [k: string]: unknown };
  readonly prompt?: unknown;
  readonly messages?: unknown;
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly [k: string]: unknown;
}

export interface LanguageModelV3StreamPart {
  readonly type: string;
  readonly [k: string]: unknown;
}

export interface LanguageModelV3GenerateResult {
  readonly text?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly [k: string]: unknown;
}

export interface LanguageModelV3Middleware {
  readonly middlewareVersion?: 'v3';
  wrapGenerate?(options: {
    readonly doGenerate: () => Promise<LanguageModelV3GenerateResult>;
    readonly params: LanguageModelV3CallOptions;
    readonly model: { readonly modelId: string };
  }): Promise<LanguageModelV3GenerateResult>;
  wrapStream?(options: {
    readonly doStream: () => Promise<{
      stream: ReadableStream<LanguageModelV3StreamPart>;
      [k: string]: unknown;
    }>;
    readonly params: LanguageModelV3CallOptions;
    readonly model: { readonly modelId: string };
  }): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart>; [k: string]: unknown }>;
}
