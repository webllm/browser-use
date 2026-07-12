import OpenAI from 'openai';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import type { Message } from '../messages.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import { zodSchemaToJsonSchema } from '../schema.js';
import { OpenAIMessageSerializer } from '../openai/serializer.js';
import { MistralSchemaOptimizer } from './schema.js';

export interface ChatMistralOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeout?: number | null;
  defaultHeaders?: Record<string, string> | null;
  defaultQuery?: Record<string, string | undefined> | null;
  fetchImplementation?: typeof fetch;
  fetchOptions?: RequestInit | null;
  clientParams?: Record<string, unknown> | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  seed?: number | null;
  safePrompt?: boolean;
  maxRetries?: number;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatMistral implements BaseChatModel {
  public model: string;
  public provider = 'mistral';
  private client: OpenAI;
  private temperature: number | null;
  private maxTokens: number | null;
  private topP: number | null;
  private seed: number | null;
  private safePrompt: boolean;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatMistralOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'mistral-medium-latest',
      apiKey = process.env.MISTRAL_API_KEY,
      baseURL = process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
      timeout = null,
      defaultHeaders = null,
      defaultQuery = null,
      fetchImplementation,
      fetchOptions = null,
      clientParams = null,
      temperature = 0.2,
      maxTokens = 4096,
      topP = null,
      seed = null,
      safePrompt = false,
      maxRetries = 5,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.seed = seed;
    this.safePrompt = safePrompt;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    this.client = new OpenAI({
      apiKey,
      baseURL,
      ...(timeout !== null ? { timeout } : {}),
      maxRetries,
      defaultHeaders: defaultHeaders ?? undefined,
      defaultQuery: defaultQuery ?? undefined,
      fetch: fetchImplementation,
      fetchOptions: (fetchOptions ?? undefined) as any,
      ...(clientParams ?? {}),
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

  private getSchemaCandidate(output_format: unknown) {
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
    const serializer = new OpenAIMessageSerializer();
    const mistralMessages = serializer.serialize(messages);

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
    if (this.safePrompt) {
      modelParams.safe_prompt = true;
    }

    const zodSchemaCandidate = this.getSchemaCandidate(output_format);
    let responseFormat:
      | OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']
      | undefined = undefined;

    if (zodSchemaCandidate) {
      try {
        const rawJsonSchema = zodSchemaToJsonSchema(zodSchemaCandidate, {
          name: 'agent_output',
          target: 'jsonSchema7',
        });
        const optimizedJsonSchema =
          MistralSchemaOptimizer.createMistralCompatibleSchema(
            rawJsonSchema as Record<string, unknown>,
            {
              removeMinItems: this.removeMinItemsFromSchema,
              removeDefaults: this.removeDefaultsFromSchema,
            }
          );
        responseFormat = {
          type: 'json_schema',
          json_schema: {
            name: 'agent_output',
            schema: optimizedJsonSchema as any,
            strict: true,
          },
        };
      } catch {
        responseFormat = undefined;
      }
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: mistralMessages,
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
          completion = output.parse(parsedJson);
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
      throw new ModelProviderError(
        error?.message ?? String(error),
        error?.status ?? 500,
        this.model
      );
    }
  }
}
