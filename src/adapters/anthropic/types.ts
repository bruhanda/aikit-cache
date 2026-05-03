/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Local re-typed view of Anthropic SDK shapes. `import type` only — never
 * imports the SDK at runtime.
 */
export type AnthropicLike = {
  messages: {
    create: (...args: any[]) => any;
    stream?: (...args: any[]) => any;
  };
};

/** Streamed Anthropic event union (subset). */
export interface AnthropicStreamEvent {
  readonly type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | string;
  readonly index?: number;
  readonly delta?: { readonly type?: string; readonly text?: string; readonly stop_reason?: string };
  readonly content_block?: { readonly type?: string; readonly text?: string };
  readonly message?: {
    readonly id?: string;
    readonly model?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
    };
  };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}
