/**
 * Local re-typed view of OpenAI request/response shapes — `import type` only,
 * never imports the SDK at runtime. The `OpenAILike` structural bound below
 * accepts any concrete `openai` SDK version via structural subtyping.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type OpenAILike = {
  chat: { completions: { create: (...args: any[]) => any } };
  embeddings?: { create: (...args: any[]) => any };
  responses?: { create: (...args: any[]) => any };
};

/** Provider chunk shape for `chat.completions.create({ stream: true })`. */
export interface OpenAIStreamChunk {
  readonly id?: string;
  readonly object?: string;
  readonly created?: number;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly index?: number;
    readonly delta?: { readonly role?: string; readonly content?: string; readonly tool_calls?: unknown };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}
