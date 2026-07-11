import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import type { Message } from '../messages.js';
import { OpenAIMessageSerializer } from './serializer.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfOutputTruncated,
} from '../exceptions.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';

// Reasoning models that support reasoning_effort parameter
const DEFAULT_REASONING_MODELS = [
  'o4-mini',
  'o3',
  'o3-mini',
  'o1',
  'o1-pro',
  'o3-pro',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
];

export interface ChatOpenAIOptions {
  model?: string;
  apiKey?: string;
  organization?: string;
  project?: string;
  baseURL?: string;
  timeout?: number | null;
  temperature?: number | null;
  frequencyPenalty?: number | null;
  reasoningEffort?: 'low' | 'medium' | 'high';
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale' | null;
  maxCompletionTokens?: number | null;
  maxRetries?: number;
  defaultHeaders?: Record<string, string> | null;
  defaultQuery?: Record<string, string | undefined> | null;
  fetchImplementation?: typeof fetch;
  fetchOptions?: RequestInit | null;
  seed?: number | null;
  topP?: number | null;
  addSchemaToSystemPrompt?: boolean;
  dontForceStructuredOutput?: boolean;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
  reasoningModels?: string[] | null;
}

export class ChatOpenAI implements BaseChatModel {
  public model: string;
  public provider = 'openai';
  private client: OpenAI;
  private temperature: number | null;
  private frequencyPenalty: number | null;
  private reasoningEffort: 'low' | 'medium' | 'high';
  private serviceTier:
    | 'auto'
    | 'default'
    | 'flex'
    | 'priority'
    | 'scale'
    | null;
  private maxCompletionTokens: number | null;
  private seed: number | null;
  private topP: number | null;
  private addSchemaToSystemPrompt: boolean;
  private dontForceStructuredOutput: boolean;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;
  private reasoningModels: string[] | null;

  constructor(options: ChatOpenAIOptions = {}) {
    const {
      model = 'gpt-4o',
      apiKey,
      organization,
      project,
      baseURL,
      timeout = null,
      temperature = 0.2,
      frequencyPenalty = 0.3,
      reasoningEffort = 'low',
      serviceTier = null,
      maxCompletionTokens = 4096,
      maxRetries = 5,
      defaultHeaders = null,
      defaultQuery = null,
      fetchImplementation,
      fetchOptions = null,
      seed = null,
      topP = null,
      addSchemaToSystemPrompt = false,
      dontForceStructuredOutput = false,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
      reasoningModels = DEFAULT_REASONING_MODELS,
    } = options;

    this.model = model;
    this.temperature = temperature;
    this.frequencyPenalty = frequencyPenalty;
    this.reasoningEffort = reasoningEffort;
    this.serviceTier = serviceTier;
    this.maxCompletionTokens = maxCompletionTokens;
    this.seed = seed;
    this.topP = topP;
    this.addSchemaToSystemPrompt = addSchemaToSystemPrompt;
    this.dontForceStructuredOutput = dontForceStructuredOutput;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;
    this.reasoningModels = reasoningModels
      ? [...reasoningModels]
      : reasoningModels;

    this.client = new OpenAI({
      apiKey,
      organization,
      project,
      baseURL,
      timeout: timeout ?? undefined,
      maxRetries,
      defaultHeaders: defaultHeaders ?? undefined,
      defaultQuery: defaultQuery ?? undefined,
      fetch: fetchImplementation,
      fetchOptions: (fetchOptions ?? undefined) as any,
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private isReasoningModel(): boolean {
    return (this.reasoningModels ?? []).some((m) =>
      this.model.toLowerCase().includes(m.toLowerCase())
    );
  }

  private getUsage(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): ChatInvokeUsage | null {
    if (!response.usage) return null;

    let completionTokens = response.usage.completion_tokens;
    const details = (response.usage as any).completion_tokens_details;
    if (details?.reasoning_tokens) {
      completionTokens += details.reasoning_tokens;
    }

    return {
      prompt_tokens: response.usage.prompt_tokens,
      prompt_cached_tokens:
        (response.usage as any).prompt_tokens_details?.cached_tokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: completionTokens,
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
    const serializer = new OpenAIMessageSerializer();
    const openaiMessages = serializer.serialize(messages);

    // Build model parameters
    const modelParams: Record<string, unknown> = {};

    if (!this.isReasoningModel()) {
      // Regular models support temperature and frequency_penalty
      if (this.temperature !== null) {
        modelParams.temperature = this.temperature;
      }
      if (this.frequencyPenalty !== null) {
        modelParams.frequency_penalty = this.frequencyPenalty;
      }
    } else {
      // Reasoning models use reasoning_effort instead
      modelParams.reasoning_effort = this.reasoningEffort;
    }

    if (this.maxCompletionTokens !== null) {
      modelParams.max_completion_tokens = this.maxCompletionTokens;
    }
    if (this.seed !== null) {
      modelParams.seed = this.seed;
    }
    if (this.topP !== null) {
      modelParams.top_p = this.topP;
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

    let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] =
      undefined;
    if (zodSchemaCandidate) {
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

        const responseJsonSchema = {
          name: 'agent_output',
          schema: optimizedJsonSchema as any,
          strict: true,
        };

        if (this.addSchemaToSystemPrompt && openaiMessages.length > 0) {
          const firstMessage = openaiMessages[0] as ChatCompletionMessageParam;
          const schemaText =
            `\n<json_schema>\n` +
            `${JSON.stringify(responseJsonSchema, null, 2)}\n` +
            `</json_schema>`;
          if (firstMessage?.role === 'system') {
            if (typeof (firstMessage as any).content === 'string') {
              (firstMessage as any).content =
                ((firstMessage as any).content ?? '') + schemaText;
            } else if (Array.isArray((firstMessage as any).content)) {
              (firstMessage as any).content = [
                ...(firstMessage as any).content,
                { type: 'text', text: schemaText },
              ];
            }
          }
        }

        if (!this.dontForceStructuredOutput) {
          responseFormat = {
            type: 'json_schema',
            json_schema: responseJsonSchema,
          };
        }
      } catch {
        responseFormat = undefined;
      }
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: openaiMessages,
          response_format: responseFormat,
          ...modelParams,
        },
        options.signal ? { signal: options.signal } : undefined
      );

      raiseIfOutputTruncated(response.choices[0].finish_reason, {
        model: this.model,
        tokenLimit: this.maxCompletionTokens,
        tokenLimitName: 'max_completion_tokens',
      });
      const content = response.choices[0].message.content || '';
      const usage = this.getUsage(response);
      const stopReason = response.choices[0].finish_reason ?? null;

      let completion: T | string = content;
      if (output_format) {
        if (zodSchemaCandidate) {
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
        } else {
          completion = (output_format as any).parse(content);
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
      // Handle OpenAI-specific errors
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
