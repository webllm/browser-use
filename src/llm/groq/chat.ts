import Groq from 'groq-sdk';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import type { Message } from '../messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import { GroqMessageSerializer } from './serializer.js';
import { createNoRedirectFetch } from '../http.js';
import { validateMaxRetries } from '../retry.js';

const JsonSchemaModels = [
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
];

export interface ChatGroqOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number | null;
  serviceTier?: 'auto' | 'on_demand' | 'flex' | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
  fetchImplementation?: typeof fetch;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatGroq implements BaseChatModel {
  public model: string;
  public provider = 'groq';
  private client: Groq;
  private temperature: number | null;
  private serviceTier: 'auto' | 'on_demand' | 'flex' | null;
  private topP: number | null;
  private seed: number | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatGroqOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'llama-3.1-70b-versatile',
      apiKey = process.env.GROQ_API_KEY,
      baseURL,
      temperature = null,
      serviceTier = null,
      topP = null,
      seed = null,
      maxRetries = 10,
      fetchImplementation,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.serviceTier = serviceTier;
    this.topP = topP;
    this.seed = seed;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    this.client = new Groq({
      apiKey,
      baseURL,
      maxRetries: validateMaxRetries(maxRetries),
      fetch: createNoRedirectFetch(fetchImplementation),
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getUsage(response: any): ChatInvokeUsage | null {
    if (!response?.usage) {
      return null;
    }

    return {
      prompt_tokens: response.usage.prompt_tokens,
      prompt_cached_tokens: null,
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
    const serializer = new GroqMessageSerializer();
    const groqMessages = serializer.serialize(messages);

    const modelParams: Record<string, unknown> = {};
    if (this.temperature !== null) {
      modelParams.temperature = this.temperature;
    }
    if (this.topP !== null) {
      modelParams.top_p = this.topP;
    }
    if (this.seed !== null) {
      modelParams.seed = this.seed;
    }
    if (this.serviceTier !== null) {
      modelParams.service_tier = this.serviceTier;
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

    let responseFormat:
      | Record<string, unknown>
      | Groq.Chat.Completions.CompletionCreateParams.ResponseFormatJsonObject
      | undefined = undefined;
    if (zodSchemaCandidate) {
      if (JsonSchemaModels.includes(this.model)) {
        try {
          const rawJsonSchema = zodSchemaToJsonSchema(zodSchemaCandidate, {
            name: 'agent_output',
            target: 'jsonSchema7',
          });
          const optimizedJsonSchema = SchemaOptimizer.createOptimizedJsonSchema(
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
              schema: optimizedJsonSchema,
            },
          };
        } catch {
          responseFormat = { type: 'json_object' };
        }
      } else {
        responseFormat = { type: 'json_object' };
      }
    }

    try {
      const response = await (this.client.chat.completions as any).create(
        {
          model: this.model,
          messages: groqMessages,
          response_format: responseFormat,
          ...modelParams,
        },
        options.signal ? { signal: options.signal } : undefined
      );

      raiseIfStructuredOutputTruncated(
        output_format,
        response.choices[0].finish_reason,
        { model: this.model }
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
