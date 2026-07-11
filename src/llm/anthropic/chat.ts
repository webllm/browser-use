import Anthropic, {
  APIConnectionError,
  APIError,
  RateLimitError,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { type Message } from '../messages.js';
import { AnthropicMessageSerializer } from './serializer.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfOutputTruncated,
} from '../exceptions.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';

export interface ChatAnthropicOptions {
  model?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  timeout?: number;
  maxTokens?: number;
  temperature?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  defaultQuery?: Record<string, string | undefined>;
  fetchImplementation?: ClientOptions['fetch'];
  fetchOptions?: ClientOptions['fetchOptions'];
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatAnthropic implements BaseChatModel {
  public model: string;
  public provider = 'anthropic';
  private client: Anthropic;
  private maxTokens: number;
  private temperature: number | null;
  private topP: number | null;
  private seed: number | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatAnthropicOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'claude-sonnet-4-20250514',
      apiKey = process.env.ANTHROPIC_API_KEY,
      authToken = process.env.ANTHROPIC_AUTH_TOKEN,
      baseURL,
      timeout,
      maxTokens = 8192,
      temperature = null,
      topP = null,
      seed = null,
      maxRetries = 10,
      defaultHeaders,
      defaultQuery,
      fetchImplementation,
      fetchOptions,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.topP = topP;
    this.seed = seed;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    this.client = new Anthropic({
      apiKey,
      authToken,
      baseURL,
      timeout,
      maxRetries,
      defaultHeaders,
      defaultQuery,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
      ...(fetchOptions ? { fetchOptions } : {}),
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getModelParams(): Record<string, unknown> {
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
    return modelParams;
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

  private getTextCompletion(response: Anthropic.Message): string {
    const textBlock = response.content.find((block) => block.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      return textBlock.text;
    }
    const firstBlock = response.content[0];
    return firstBlock ? String(firstBlock) : '';
  }

  private getUsage(response: Anthropic.Message): ChatInvokeUsage {
    const cacheReadTokens =
      (response.usage as any).cache_read_input_tokens ?? 0;
    const cacheCreationTokens =
      (response.usage as any).cache_creation_input_tokens ?? 0;

    return {
      prompt_tokens: response.usage.input_tokens + cacheReadTokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      prompt_cached_tokens: cacheReadTokens || null,
      prompt_cache_creation_tokens: cacheCreationTokens || null,
      prompt_image_tokens: null,
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
    const serializer = new AnthropicMessageSerializer();
    const [anthropicMessages, systemPrompt] =
      serializer.serializeMessages(messages);
    const zodSchemaCandidate = this.getZodSchemaCandidate(output_format);

    let tools: Anthropic.Tool[] | undefined = undefined;
    let toolChoice: Anthropic.ToolChoice | undefined = undefined;

    if (output_format && zodSchemaCandidate) {
      try {
        const rawJsonSchema = zodSchemaToJsonSchema(zodSchemaCandidate as any, {
          name: 'Response',
          target: 'jsonSchema7',
        });
        const optimizedJsonSchema = SchemaOptimizer.createOptimizedJsonSchema(
          rawJsonSchema as Record<string, unknown>,
          {
            removeMinItems: this.removeMinItemsFromSchema,
            removeDefaults: this.removeDefaultsFromSchema,
          }
        ) as Record<string, unknown>;
        delete optimizedJsonSchema.title;

        const toolName = (output_format as any)?.name || 'response';

        tools = [
          {
            name: toolName,
            description: `Extract information in the format of ${toolName}`,
            input_schema: optimizedJsonSchema as any,
            cache_control: { type: 'ephemeral' } as any,
          },
        ];
        toolChoice = { type: 'tool', name: toolName };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for Anthropic',
          e
        );
      }
    }

    const requestPayload: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      ...this.getModelParams(),
    };
    if (systemPrompt !== undefined) {
      requestPayload.system = systemPrompt;
    }
    if (tools?.length) {
      requestPayload.tools = tools;
      requestPayload.tool_choice = toolChoice;
    }

    try {
      const response = await this.client.messages.create(
        requestPayload as any,
        options.signal ? { signal: options.signal } : undefined
      );

      raiseIfOutputTruncated((response as any).stop_reason, {
        model: this.model,
        tokenLimit: this.maxTokens,
      });

      let completion: T | string = this.getTextCompletion(response);

      if (output_format) {
        const toolUseBlock = response.content.find(
          (block) => block.type === 'tool_use'
        );

        if (toolUseBlock && toolUseBlock.type === 'tool_use') {
          try {
            completion = this.parseOutput(output_format, toolUseBlock.input);
          } catch (error) {
            if (typeof toolUseBlock.input === 'string') {
              completion = this.parseOutput(
                output_format,
                JSON.parse(toolUseBlock.input)
              );
            } else {
              throw error;
            }
          }
        } else if (tools?.length) {
          throw new ModelProviderError(
            'Expected tool use in response but none found',
            502,
            this.model
          );
        } else {
          completion = this.parseOutput(output_format, completion);
        }
      } else {
        completion = this.getTextCompletion(response);
      }

      const usage = this.getUsage(response);
      const stopReason = (response as any).stop_reason ?? null;

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
      if (error instanceof RateLimitError || error?.status === 429) {
        throw new ModelRateLimitError(
          error?.message ?? 'Rate limit exceeded',
          429,
          this.model
        );
      }
      if (error instanceof APIConnectionError) {
        throw new ModelProviderError(
          error?.message ?? 'Connection error',
          502,
          this.model
        );
      }
      if (error instanceof APIError) {
        throw new ModelProviderError(
          error?.message ?? 'Anthropic API error',
          error?.status ?? 502,
          this.model
        );
      }
      throw new ModelProviderError(
        error?.message ?? String(error),
        error?.status ?? 502,
        this.model
      );
    }
  }
}
