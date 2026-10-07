import type { ChatInvokeCompletion } from './views.js';
import type { Message } from './messages.js';

export interface ChatInvokeOptions {
  signal?: AbortSignal;
  request_type?: string;
  [key: string]: unknown;
}

export interface BaseChatModel {
  model: string;
  _verified_api_keys?: boolean;

  get provider(): string;
  get name(): string;

  get model_name(): string;

  ainvoke(
    messages: Message[],
    output_format?: undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<string>>;
  ainvoke<T>(
    messages: Message[],
    output_format: { parse: (input: string) => T } | undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T>>;
}

/**
 * Return whether a model matches a non-empty reasoning-model pattern. An empty
 * pattern would otherwise match every model name.
 */
export const isReasoningModel = (
  model: unknown,
  reasoningModels: Iterable<unknown> | null | undefined
): boolean => {
  if (!reasoningModels) {
    return false;
  }
  const modelName = String(model).toLowerCase();
  for (const pattern of reasoningModels) {
    const patternName = String(pattern).toLowerCase();
    if (patternName.trim() && modelName.includes(patternName)) {
      return true;
    }
  }
  return false;
};
