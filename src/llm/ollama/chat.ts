import {
  Ollama,
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

export interface ChatOllamaOptions {
  model?: string;
  host?: string;
  timeout?: number | null;
  clientParams?: Partial<OllamaClientConfig> | null;
  ollamaOptions?: Partial<OllamaOptions> | null;
}

export class ChatOllama implements BaseChatModel {
  public model: string;
  public provider = 'ollama';
  private client: Ollama;
  private ollamaOptions: Partial<OllamaOptions> | null;

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
        fetchWithTimeout = this.createTimeoutFetch(baseFetch, timeoutMs);
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

    const requestPromise: Promise<ChatResponse> = this.client.chat({
      model: this.model,
      messages: ollamaMessages,
      format: format,
      options: this.ollamaOptions ?? undefined,
      stream: false,
    });

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
        if (zodSchemaCandidate) {
          completion = this.parseOutput(output_format, JSON.parse(content));
        } else {
          try {
            completion = this.parseOutput(output_format, JSON.parse(content));
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
