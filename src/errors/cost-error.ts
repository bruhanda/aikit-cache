import { CacheError, formatErrorMessage } from './base.js';

/**
 * Thrown by the cost subsystem when a model is not registered or pricing
 * is invalid. Cache operations themselves are not affected — only the
 * dollar-savings stats become inaccurate.
 */
export class CostError extends CacheError {
  readonly code: 'COST_UNKNOWN_MODEL' | 'COST_INVALID_PRICING';
  readonly model?: string;

  constructor(
    code: CostError['code'],
    message: string,
    options?: { cause?: unknown; model?: string },
  ) {
    super(formatErrorMessage(message, code), options);
    this.code = code;
    if (options?.model !== undefined) this.model = options.model;
    this.name = 'CostError';
  }
}
