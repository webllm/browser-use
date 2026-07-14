import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import { ChatInvokeCompletion } from '../views.js';
import { type Message } from '../messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { validateMaxRetries } from '../retry.js';
import { AWSBedrockMessageSerializer } from './serializer.js';

export interface ChatBedrockConverseOptions {
  model?: string;
  region?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  seed?: number | null;
  stopSequences?: string[] | null;
  maxRetries?: number;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatBedrockConverse implements BaseChatModel {
  public model: string;
  public provider = 'aws';
  private client: BedrockRuntimeClient;
  private maxTokens: number | null;
  private temperature: number | null;
  private topP: number | null;
  private seed: number | null;
  private stopSequences: string[] | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(
    modelOrOptions: string | ChatBedrockConverseOptions = {},
    region?: string
  ) {
    const normalizedOptions =
      typeof modelOrOptions === 'string'
        ? ({ model: modelOrOptions, region } as ChatBedrockConverseOptions)
        : modelOrOptions;
    const {
      model = 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      region: bedrockRegion = process.env.AWS_REGION || 'us-east-1',
      awsAccessKeyId,
      awsSecretAccessKey,
      awsSessionToken = process.env.AWS_SESSION_TOKEN,
      maxTokens = 4096,
      temperature = null,
      topP = null,
      seed = null,
      stopSequences = null,
      maxRetries,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.topP = topP;
    this.seed = seed;
    this.stopSequences = stopSequences;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    const credentials =
      awsAccessKeyId && awsSecretAccessKey
        ? {
            accessKeyId: awsAccessKeyId,
            secretAccessKey: awsSecretAccessKey,
            ...(awsSessionToken ? { sessionToken: awsSessionToken } : {}),
          }
        : undefined;

    this.client = new BedrockRuntimeClient({
      region: bedrockRegion,
      ...(credentials ? { credentials } : {}),
      ...(maxRetries !== undefined
        ? { maxAttempts: validateMaxRetries(maxRetries, 1) }
        : {}),
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getInferenceConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    if (this.maxTokens !== null) {
      config.maxTokens = this.maxTokens;
    }
    if (this.temperature !== null) {
      config.temperature = this.temperature;
    }
    if (this.topP !== null) {
      config.topP = this.topP;
    }
    if (this.seed !== null) {
      config.seed = this.seed;
    }
    if (this.stopSequences !== null) {
      config.stopSequences = this.stopSequences;
    }
    return config;
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
    const serializer = new AWSBedrockMessageSerializer();
    const [bedrockMessages, systemMessage] =
      serializer.serializeMessages(messages);
    const zodSchemaCandidate = this.getZodSchemaCandidate(output_format);

    let toolConfig: any = undefined;
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

        const tools: BedrockTool[] = [
          {
            toolSpec: {
              name: 'response',
              description: 'Extract information in the format of response',
              inputSchema: {
                json: optimizedJsonSchema as any,
              },
            },
          },
        ];
        toolConfig = {
          tools,
          toolChoice: { tool: { name: 'response' } },
        };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for AWS Bedrock',
          e
        );
      }
    }

    const requestPayload: Record<string, unknown> = {
      modelId: this.model,
      messages: bedrockMessages,
    };
    if (systemMessage) {
      requestPayload.system = systemMessage;
    }
    const inferenceConfig = this.getInferenceConfig();
    if (Object.keys(inferenceConfig).length) {
      requestPayload.inferenceConfig = inferenceConfig;
    }
    if (toolConfig) {
      requestPayload.toolConfig = toolConfig;
    }

    try {
      const response = await this.client.send(
        new ConverseCommand(requestPayload as any),
        options.signal ? { abortSignal: options.signal } : undefined
      );

      raiseIfStructuredOutputTruncated(output_format, response?.stopReason, {
        model: this.model,
        tokenLimit: this.maxTokens,
      });

      let completion: T | string = this.getTextCompletion(response);
      if (output_format) {
        const contentBlocks = response?.output?.message?.content;
        const toolUseBlock = Array.isArray(contentBlocks)
          ? contentBlocks.find((block: any) => block?.toolUse)
          : undefined;

        if (toolUseBlock?.toolUse) {
          const input = toolUseBlock.toolUse.input;
          if (typeof input === 'string') {
            completion = this.parseOutput(output_format, JSON.parse(input));
          } else {
            completion = this.parseOutput(output_format, input);
          }
        } else if (toolConfig) {
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
}
