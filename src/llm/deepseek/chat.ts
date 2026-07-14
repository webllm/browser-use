import OpenAI from 'openai';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import type { Message } from '../messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import { DeepSeekMessageSerializer } from './serializer.js';
import { rejectRedirectsInFetchOptions } from '../http.js';
import { validateMaxRetries } from '../retry.js';

export interface ChatDeepSeekOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeout?: number | null;
  clientParams?: Record<string, unknown> | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
}

export class ChatDeepSeek implements BaseChatModel {
  public model: string;
  public provider = 'deepseek';
  private client: OpenAI;
  private temperature: number | null;
  private maxTokens: number | null;
  private topP: number | null;
  private seed: number | null;

  constructor(options: string | ChatDeepSeekOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'deepseek-chat',
      apiKey = process.env.DEEPSEEK_API_KEY,
      baseURL = 'https://api.deepseek.com/v1',
      timeout = null,
      clientParams = null,
      temperature = null,
      maxTokens = null,
      topP = null,
      seed = null,
      maxRetries = 10,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.seed = seed;

    const configuredMaxRetries =
      (clientParams as any)?.maxRetries ?? maxRetries;

    this.client = new OpenAI({
      apiKey,
      baseURL,
      ...(timeout !== null ? { timeout } : {}),
      ...(clientParams ?? {}),
      maxRetries: validateMaxRetries(configuredMaxRetries),
      fetchOptions: rejectRedirectsInFetchOptions(
        (clientParams as any)?.fetchOptions as RequestInit | undefined
      ) as any,
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getUsage(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): ChatInvokeUsage | null {
    if (!response.usage) {
      return null;
    }

    return {
      prompt_tokens: response.usage.prompt_tokens,
      prompt_cached_tokens:
        (response.usage as any).prompt_tokens_details?.cached_tokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
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
    const serializer = new DeepSeekMessageSerializer();
    const deepseekMessages = serializer.serialize(messages);

    const modelParams: Record<string, unknown> = {};
    if (this.temperature !== null) {
      modelParams.temperature = this.temperature;
    }
    if (this.maxTokens !== null) {
      modelParams.max_tokens = this.maxTokens;
    }
    if (this.topP !== null) {
      modelParams.top_p = this.topP;
    }
    if (this.seed !== null) {
      modelParams.seed = this.seed;
    }

    const zodSchemaCandidate = (() => {
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
    })();

    try {
      if (output_format && zodSchemaCandidate) {
        const rawSchema = zodSchemaToJsonSchema(zodSchemaCandidate as any, {
          name: 'response',
          target: 'jsonSchema7',
        });
        const optimizedSchema = SchemaOptimizer.createOptimizedJsonSchema(
          rawSchema as Record<string, unknown>
        ) as Record<string, unknown>;
        delete optimizedSchema.title;

        const response = await this.client.chat.completions.create(
          {
            model: this.model,
            messages: deepseekMessages,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'response',
                  description: 'Return a JSON object of type response',
                  parameters: optimizedSchema as any,
                },
              },
            ],
            tool_choice: {
              type: 'function',
              function: { name: 'response' },
            } as any,
            ...modelParams,
          },
          options.signal ? { signal: options.signal } : undefined
        );

        const usage = this.getUsage(response);
        const stopReason = response.choices[0].finish_reason ?? null;
        raiseIfStructuredOutputTruncated(output_format, stopReason, {
          model: this.model,
          tokenLimit: this.maxTokens,
        });
        const toolCalls = response.choices[0].message.tool_calls;
        if (!toolCalls?.length) {
          throw new ModelProviderError(
            'Expected tool_calls in response but got none',
            502,
            this.model
          );
        }

        const rawArguments = (toolCalls[0] as any)?.function?.arguments;
        const parsedArguments =
          typeof rawArguments === 'string'
            ? JSON.parse(rawArguments)
            : rawArguments;
        const output = output_format as any;
        const completion =
          output &&
          typeof output === 'object' &&
          output.schema &&
          typeof output.schema.parse === 'function'
            ? output.schema.parse(parsedArguments)
            : output.parse(parsedArguments);

        return new ChatInvokeCompletion(
          completion,
          usage,
          null,
          null,
          stopReason
        );
      }

      const responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] =
        output_format ? { type: 'json_object' } : undefined;
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: deepseekMessages,
          response_format: responseFormat,
          ...modelParams,
        },
        options.signal ? { signal: options.signal } : undefined
      );

      raiseIfStructuredOutputTruncated(
        output_format,
        response.choices[0].finish_reason,
        {
          model: this.model,
          tokenLimit: this.maxTokens,
        }
      );
      const content = response.choices[0].message.content || '';
      const usage = this.getUsage(response);
      const stopReason = response.choices[0].finish_reason ?? null;

      let completion: T | string = content;
      if (output_format) {
        const parsedJson = JSON.parse(content);
        const output = output_format as any;
        if (
          output &&
          typeof output === 'object' &&
          output.schema &&
          typeof output.schema.parse === 'function'
        ) {
          completion = output.schema.parse(parsedJson);
        } else {
          completion = (output_format as any).parse(parsedJson);
        }
      }

      return new ChatInvokeCompletion(
        completion,
        usage,
        null,
        null,
        stopReason
      );
    } catch (error: any) {
      if (error instanceof ModelProviderError) {
        throw error;
      }
      if (error?.status === 429) {
        throw new ModelRateLimitError(
          error?.message ?? 'Rate limit exceeded',
          429,
          this.model
        );
      }
      if (error?.status >= 500) {
        throw new ModelProviderError(
          error?.message ?? 'Server error',
          error.status,
          this.model
        );
      }
      throw new ModelProviderError(
        error?.message ?? String(error),
        error?.status ?? 500,
        this.model
      );
    }
  }
}
