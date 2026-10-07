import {
  Ollama,
  type ChatRequest,
  type ChatResponse,
  type Config as OllamaClientConfig,
  type Options as OllamaOptions,
} from 'ollama';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { zodSchemaToJsonSchema } from '../schema.js';
import { OllamaMessageSerializer } from './serializer.js';
import { createNoRedirectFetch } from '../http.js';
import { MAX_HTTP_REQUEST_TIMEOUT_MS } from '../../http-response.js';
import { createLogger } from '../../logging-config.js';

const logger = createLogger('browser_use.llm.ollama');

// These belong on the chat() request, not inside the model `options` map.
const PASSTHROUGH_CHAT_KEYS = new Set([
  'think',
  'logprobs',
  'top_logprobs',
  'keep_alive',
]);
// ChatOllama owns structured output and requires a non-streaming response.
const IGNORED_CHAT_KEYS = new Set(['format', 'stream']);
const JSON_FENCE_RE =
  /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i;

/**
 * Strip the markdown code fence that Ollama vision models often wrap around JSON.
 */
export const unwrapOllamaJsonContent = (content: string): string => {
  const text = content.trim();
  const match = JSON_FENCE_RE.exec(text);
  return match ? (match[1] ?? '').trim() : text;
};

export type ChatOllamaModelOptions = Partial<OllamaOptions> & {
  think?: boolean | 'high' | 'medium' | 'low';
  keep_alive?: string | number;
  logprobs?: boolean;
  top_logprobs?: number;
  [key: string]: unknown;
};

export interface ChatOllamaOptions {
  model?: string;
  host?: string;
  timeout?: number | null;
  clientParams?: Partial<OllamaClientConfig> | null;
  ollamaOptions?: ChatOllamaModelOptions | null;
}

export class ChatOllama implements BaseChatModel {
  public model: string;
  public provider = 'ollama';
  private client: Ollama;
  private ollamaOptions: ChatOllamaModelOptions | null;

  constructor(
    modelOrOptions: string | ChatOllamaOptions = 'qwen2.5:latest',
    host: string = 'http://localhost:11434'
  ) {
    const normalizedOptions =
      typeof modelOrOptions === 'string'
        ? ({ model: modelOrOptions, host } as ChatOllamaOptions)
        : modelOrOptions;

    const {
      model = 'qwen2.5:latest',
      host: ollamaHost = 'http://localhost:11434',
      timeout = null,
      clientParams = null,
      ollamaOptions = null,
    } = normalizedOptions;

    this.model = model;
    this.ollamaOptions = ollamaOptions;

    const baseFetch = createNoRedirectFetch<
      NonNullable<OllamaClientConfig['fetch']>
    >(clientParams?.fetch);
    let fetchWithTimeout = baseFetch;
    if (timeout !== null && timeout !== undefined) {
      const timeoutMs = Number(timeout);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        fetchWithTimeout = this.createTimeoutFetch(
          baseFetch,
          Math.min(
            MAX_HTTP_REQUEST_TIMEOUT_MS,
            Math.max(1, Math.floor(timeoutMs))
          )
        );
      }
    }

    this.client = new Ollama({
      host: ollamaHost,
      ...(clientParams ?? {}),
      ...(fetchWithTimeout ? { fetch: fetchWithTimeout } : {}),
    });
  }

  get name(): string {
    return this.model;
  }

  /**
   * Split model options from parameters that the chat() request takes at the
   * top level. `format` and `stream` are dropped because this wrapper controls
   * structured output and streaming itself.
   */
  private splitChatOptions(): {
    modelOptions: Partial<OllamaOptions> | undefined;
    topLevel: Record<string, unknown>;
  } {
    const options = this.ollamaOptions;
    if (!options || typeof options !== 'object') {
      return { modelOptions: undefined, topLevel: {} };
    }
    const modelOptions: Record<string, unknown> = {};
    const topLevel: Record<string, unknown> = {};
    const ignored: string[] = [];
    for (const [key, value] of Object.entries(options)) {
      if (PASSTHROUGH_CHAT_KEYS.has(key)) {
        topLevel[key] = value;
      } else if (IGNORED_CHAT_KEYS.has(key)) {
        ignored.push(key);
      } else {
        modelOptions[key] = value;
      }
    }
    if (ignored.length > 0) {
      logger.warning(
        `Ignoring ${ignored.sort().join(', ')} in ollamaOptions; ChatOllama controls structured output and streaming`
      );
    }
    return {
      modelOptions: Object.keys(modelOptions).length
        ? (modelOptions as Partial<OllamaOptions>)
        : undefined,
      topLevel,
    };
  }

  get model_name(): string {
    return this.model;
  }

  private getZodSchemaCandidate(
    output_format?: { parse: (input: string) => unknown } | undefined
  ) {
    const output = output_format as any;
    if (
      output &&
      typeof output === 'object' &&
      typeof output.safeParse === 'function' &&
      typeof output.parse === 'function'
    ) {
      return output;
    }
    if (
      output &&
      typeof output === 'object' &&
      output.schema &&
      typeof output.schema.safeParse === 'function' &&
      typeof output.schema.parse === 'function'
    ) {
      return output.schema;
    }
    return null;
  }

  private parseOutput<T>(
    output_format: { parse: (input: string) => T },
    payload: unknown
  ): T {
    const output = output_format as any;
    if (
      output &&
      typeof output === 'object' &&
      output.schema &&
      typeof output.schema.parse === 'function'
    ) {
      return output.schema.parse(payload);
    }
    return output.parse(payload);
  }

  private createTimeoutFetch(
    baseFetch: NonNullable<OllamaClientConfig['fetch']>,
    timeoutMs: number
  ): NonNullable<OllamaClientConfig['fetch']> {
    return async (input, init) => {
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(
        () => timeoutController.abort(),
        timeoutMs
      );
      const externalSignal = init?.signal;
      const onAbort = () => timeoutController.abort();
      try {
        if (externalSignal) {
          if (externalSignal.aborted) {
            timeoutController.abort();
          } else {
            externalSignal.addEventListener('abort', onAbort, { once: true });
          }
        }
        return await baseFetch(input, {
          ...init,
          signal: timeoutController.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
        externalSignal?.removeEventListener('abort', onAbort);
      }
    };
  }

  async ainvoke(
    messages: Message[],
    output_format?: undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<string>>;
  async ainvoke<T>(
    messages: Message[],
    output_format: { parse: (input: string) => T } | undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T>>;
  async ainvoke<T>(
    messages: Message[],
    output_format?: { parse: (input: string) => T } | undefined,
    options: ChatInvokeOptions = {}
  ): Promise<ChatInvokeCompletion<T | string>> {
    const serializer = new OllamaMessageSerializer();
    const ollamaMessages = serializer.serialize(messages);
    const zodSchemaCandidate = this.getZodSchemaCandidate(output_format);

    let format: string | object | undefined = undefined;
    if (zodSchemaCandidate) {
      format = zodSchemaToJsonSchema(zodSchemaCandidate as any, {
        name: 'Response',
        target: 'jsonSchema7',
      }) as object;
    } else if (output_format) {
      format = 'json';
    }

    const { modelOptions, topLevel } = this.splitChatOptions();
    const requestPromise: Promise<ChatResponse> = this.client.chat({
      ...topLevel,
      model: this.model,
      messages: ollamaMessages,
      format: format,
      options: modelOptions,
      stream: false,
    } as ChatRequest & { stream: false });

    const abortSignal = options.signal;
    const response = abortSignal
      ? await new Promise<ChatResponse>((resolve, reject) => {
          const onAbort = () => {
            cleanup();
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            reject(error);
          };

          const cleanup = () => {
            abortSignal.removeEventListener('abort', onAbort);
          };

          if (abortSignal.aborted) {
            onAbort();
            return;
          }

          abortSignal.addEventListener('abort', onAbort, { once: true });
          requestPromise
            .then((result) => {
              cleanup();
              resolve(result);
            })
            .catch((error) => {
              cleanup();
              reject(error);
            });
        })
      : await requestPromise;

    try {
      raiseIfStructuredOutputTruncated(output_format, response.done_reason, {
        model: this.model,
      });
      const content = response.message.content;

      let completion: T | string = content;
      if (output_format) {
        const jsonContent = unwrapOllamaJsonContent(content ?? '');
        if (zodSchemaCandidate) {
          completion = this.parseOutput(output_format, JSON.parse(jsonContent));
        } else {
          try {
            completion = this.parseOutput(
              output_format,
              JSON.parse(jsonContent)
            );
          } catch {
            completion = this.parseOutput(output_format, content);
          }
        }
      }

      const stopReason = response.done_reason ?? null;
      return new ChatInvokeCompletion(
        completion,
        {
          prompt_tokens: response.prompt_eval_count ?? 0,
          completion_tokens: response.eval_count ?? 0,
          total_tokens:
            (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
        },
        null,
        null,
        stopReason
      );
    } catch (error: any) {
      if (error instanceof ModelProviderError) {
        throw error;
      }
      throw new ModelProviderError(
        error?.message ?? String(error),
        error?.status ?? 502,
        this.model
      );
    }
  }
}
