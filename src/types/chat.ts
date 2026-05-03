/**
 * Provider-neutral chat message shape used by the canonicalizer and adapter
 * fixtures. Concrete provider SDKs (`openai`, `@anthropic-ai/sdk`) ship
 * richer types; this is the common subset every adapter can map onto.
 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  readonly content: string | readonly ChatContentPart[];
  readonly name?: string;
  readonly tool_call_id?: string;
}

/**
 * Multimodal message content part. Vision / audio / file references need
 * special handling in the semantic layer's `extractText` — see §9.6 case 52
 * of `PLAN.md`.
 */
export type ChatContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image' | 'image_url';
      readonly url?: string;
      readonly image_url?: { readonly url: string };
    }
  | {
      readonly type: 'audio' | 'file' | 'input_audio';
      readonly [k: string]: unknown;
    }
  | {
      readonly type: string;
      readonly [k: string]: unknown;
    };

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly [k: string]: unknown;
}

export interface ChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly role: string; readonly content: string };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly cached_tokens?: number;
  };
  readonly [k: string]: unknown;
}
