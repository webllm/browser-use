/**
 * AWS Bedrock Anthropic Claude chat model.
 *
 * This is a convenience class that provides Claude-specific defaults
 * for the AWS Bedrock service. It inherits all functionality from
 * ChatBedrockConverse but sets Anthropic Claude as the default model
 * and uses the Anthropic message serializer for better compatibility.
 *
 * Usage:
 * ```typescript
 * import { ChatAnthropicBedrock } from './llm/aws/chat-anthropic.js';
 *
 * const llm = new ChatAnthropicBedrock({
 *   model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
 *   region: 'us-east-1'
 * });
 *
 * const response = await llm.ainvoke(messages);
 * ```
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfOutputTruncated,
} from '../exceptions.js';
import { ChatInvokeCompletion } from '../views.js';
import { type Message } from '../messages.js';
import { AnthropicMessageSerializer } from '../anthropic/serializer.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';

export interface ChatAnthropicBedrockConfig {
  /** Model ID, defaults to Claude 3.5 Sonnet */
  model?: string;
  /** AWS region, defaults to us-east-1 */
  region?: string;
  /** AWS access key ID */
  awsAccessKeyId?: string;
  /** AWS secret access key */
  awsSecretAccessKey?: string;
  /** AWS session token */
  awsSessionToken?: string;
  /** Retry attempts */
  maxRetries?: number;
  /** Maximum tokens to generate */
  max_tokens?: number;
  /** Temperature for sampling (0-1) */
  temperature?: number | null;
  /** Top-p sampling parameter */
  top_p?: number | null;
  /** Top-k sampling parameter */
  top_k?: number | null;
  /** Stop sequences */
  stop_sequences?: string[] | null;
  /** Remove minItems from schema for provider compatibility */
  removeMinItemsFromSchema?: boolean;
  /** Remove default from schema for provider compatibility */
  removeDefaultsFromSchema?: boolean;
}

export class ChatAnthropicBedrock implements BaseChatModel {
  public model: string;
  public provider = 'anthropic_bedrock';
  private client: BedrockRuntimeClient;
  private max_tokens: number;
  private temperature: number | null;
  private top_p: number | null;
  private top_k: number | null;
  private stop_sequences: string[] | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(config: ChatAnthropicBedrockConfig = {}) {
    // Anthropic Claude specific defaults
    this.model = config.model || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    this.max_tokens = config.max_tokens || 8192;
    this.temperature =
      config.temperature === undefined ? null : config.temperature;
    this.top_p = config.top_p === undefined ? null : config.top_p;
    this.top_k = config.top_k === undefined ? null : config.top_k;
    this.stop_sequences =
      config.stop_sequences === undefined ? null : config.stop_sequences;
    this.removeMinItemsFromSchema = config.removeMinItemsFromSchema ?? false;
    this.removeDefaultsFromSchema = config.removeDefaultsFromSchema ?? false;

    const region = config.region || process.env.AWS_REGION || 'us-east-1';
    const awsSessionToken =
      config.awsSessionToken || process.env.AWS_SESSION_TOKEN;
    const credentials =
      config.awsAccessKeyId && config.awsSecretAccessKey
        ? {
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey,
            ...(awsSessionToken ? { sessionToken: awsSessionToken } : {}),
          }
        : undefined;

    this.client = new BedrockRuntimeClient({
      region,
      ...(credentials ? { credentials } : {}),
      ...(config.maxRetries !== undefined
        ? { maxAttempts: config.maxRetries }
        : {}),
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private _getInferenceParams(): Record<string, any> {
    const params: Record<string, any> = {
      maxTokens: this.max_tokens,
    };

    if (this.temperature !== null) {
      params.temperature = this.temperature;
    }
    if (this.top_p !== null) {
      params.topP = this.top_p;
    }
    if (this.stop_sequences !== null && this.stop_sequences.length > 0) {
      params.stopSequences = this.stop_sequences;
    }

    return params;
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

  private getTextCompletion(response: any): string {
    const contentBlocks = response?.output?.message?.content;
    if (!Array.isArray(contentBlocks)) {
      return '';
    }
    return contentBlocks
      .filter((block: any) => typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('\n');
  }

  private getUsage(response: any) {
    const usage = response?.usage ?? {};
    const cacheReadTokens = usage.cacheReadInputTokens ?? 0;
    return {
      prompt_tokens: (usage.inputTokens ?? 0) + cacheReadTokens,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0,
      prompt_cached_tokens: cacheReadTokens || null,
      prompt_cache_creation_tokens: usage.cacheWriteInputTokens ?? null,
      prompt_cache_creation_5m_tokens: null,
      prompt_cache_creation_1h_tokens: null,
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
    output_format: { parse: (input: string) => T },
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T>>;
  async ainvoke<T>(
    messages: Message[],
    output_format?: { parse: (input: string) => T },
    options: ChatInvokeOptions = {}
  ): Promise<ChatInvokeCompletion<T | string>> {
    // Use Anthropic-specific message serializer
    const serializer = new AnthropicMessageSerializer();
    const [anthropicMessages, systemPrompt] =
      serializer.serializeMessages(messages);

    // Convert Anthropic messages to Bedrock format
    const bedrockMessages = anthropicMessages.map((msg: any) => {
      const content = Array.isArray(msg.content)
        ? msg.content.map((block: any) => {
            if (block.type === 'text') {
              return { text: block.text };
            } else if (block.type === 'tool_use') {
              return {
                toolUse: {
                  toolUseId: block.id,
                  name: block.name,
                  input: block.input,
                },
              };
            } else if (block.type === 'image') {
              if (block.source?.type === 'base64') {
                return {
                  image: {
                    format:
                      String(block.source.media_type || 'image/jpeg').split(
                        '/'
                      )[1] ?? 'jpeg',
                    source: {
                      bytes: Buffer.from(block.source.data ?? '', 'base64'),
                    },
                  },
                };
              }
              return { text: '[Image]' };
            }
            return { text: String(block) };
          })
        : [{ text: msg.content }];

      return {
        role: msg.role,
        content,
      };
    });

    // Handle system message
    const system = systemPrompt
      ? [
          {
            text:
              typeof systemPrompt === 'string'
                ? systemPrompt
                : JSON.stringify(systemPrompt),
          },
        ]
      : undefined;

    let toolConfig: any = undefined;
    const zodSchemaCandidate = this.getZodSchemaCandidate(output_format);

    if (output_format && zodSchemaCandidate) {
      // Structured output using tools
      try {
        const rawSchema = this._zodToJsonSchema(zodSchemaCandidate);
        const schema = SchemaOptimizer.createOptimizedJsonSchema(
          rawSchema as Record<string, unknown>,
          {
            removeMinItems: this.removeMinItemsFromSchema,
            removeDefaults: this.removeDefaultsFromSchema,
          }
        ) as Record<string, unknown>;
        delete schema.title;

        const tools: BedrockTool[] = [
          {
            toolSpec: {
              name: 'extract_structured_data',
              description: 'Extract structured data from the response',
              inputSchema: {
                json: schema as any,
              },
            },
          },
        ];

        toolConfig = {
          tools,
          toolChoice: { tool: { name: 'extract_structured_data' } },
        };
      } catch (e) {
        console.warn('Failed to convert output_format to JSON schema', e);
      }
    }

    const command = new ConverseCommand({
      modelId: this.model,
      messages: bedrockMessages,
      system: system,
      toolConfig: toolConfig,
      inferenceConfig: this._getInferenceParams(),
    });

    try {
      const response = await this.client.send(
        command,
        options.signal ? { abortSignal: options.signal } : undefined
      );

      raiseIfOutputTruncated(response?.stopReason, {
        model: this.model,
        tokenLimit: this.max_tokens,
      });

      let completion: T | string = this.getTextCompletion(response);
      const contentBlocks = response?.output?.message?.content;
      const toolUseBlock = Array.isArray(contentBlocks)
        ? contentBlocks.find((block: any) => block?.toolUse)
        : undefined;
      if (toolUseBlock?.toolUse && output_format) {
        const input = toolUseBlock.toolUse.input;
        if (typeof input === 'string') {
          completion = this.parseOutput(output_format, JSON.parse(input));
        } else {
          completion = this.parseOutput(output_format, input);
        }
      } else if (output_format && toolConfig) {
        throw new ModelProviderError(
          'Expected tool use in response but none found',
          502,
          this.model
        );
      } else if (output_format) {
        completion = this.parseOutput(output_format, completion);
      } else {
        completion = this.getTextCompletion(response);
      }

      const stopReason = response?.stopReason ?? null;
      return new ChatInvokeCompletion(
        completion,
        this.getUsage(response),
        null,
        null,
        stopReason
      );
    } catch (error: any) {
      if (error instanceof ModelProviderError) {
        throw error;
      }
      const errorName = String(error?.name ?? '');
      const statusCode = error?.$metadata?.httpStatusCode ?? 502;
      if (
        statusCode === 429 ||
        errorName.includes('Throttling') ||
        errorName.includes('TooManyRequests')
      ) {
        throw new ModelRateLimitError(
          error?.message ?? 'Rate limit exceeded',
          429,
          this.model
        );
      }
      throw new ModelProviderError(
        error?.message ?? String(error),
        statusCode,
        this.model
      );
    }
  }

  /**
   * Simple Zod to JSON Schema conversion for structured output
   */
  private _zodToJsonSchema(schema: any): any {
    return zodSchemaToJsonSchema(schema, {
      name: 'Response',
      target: 'jsonSchema7',
    });
  }
}
