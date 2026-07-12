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
import { VercelMessageSerializer } from './serializer.js';

const DEFAULT_REASONING_MODELS = [
  'o1',
  'o3',
  'o4',
  'gpt-oss',
  'deepseek-r1',
  'qwen3-next-80b-a3b-thinking',
] as const;

export interface ChatVercelOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  timeout?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
  defaultHeaders?: Record<string, string> | null;
  defaultQuery?: Record<string, string | undefined> | null;
  fetchImplementation?: typeof fetch;
  fetchOptions?: RequestInit | null;
  reasoningModels?: string[] | null;
  providerOptions?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatVercel implements BaseChatModel {
  public model: string;
  public provider = 'vercel';
  private client: OpenAI;
  private temperature: number | null;
  private maxTokens: number | null;
  private topP: number | null;
  private seed: number | null;
  private reasoningModels: string[] | null;
  private providerOptions: Record<string, unknown> | null;
  private extraBody: Record<string, unknown> | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatVercelOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'openai/gpt-4o',
      apiKey = process.env.VERCEL_API_KEY,
      baseURL = process.env.VERCEL_BASE_URL ||
        'https://ai-gateway.vercel.sh/v1',
      timeout = null,
      temperature = null,
      maxTokens = null,
      topP = null,
      seed = null,
      maxRetries = 5,
      defaultHeaders = null,
      defaultQuery = null,
      fetchImplementation,
      fetchOptions = null,
      reasoningModels = [...DEFAULT_REASONING_MODELS],
      providerOptions = null,
      extraBody = null,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.seed = seed;
    this.reasoningModels = reasoningModels ? [...reasoningModels] : null;
    this.providerOptions = providerOptions;
    this.extraBody = extraBody;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    this.client = new OpenAI({
      apiKey,
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

  private getExtraBodyPayload(): Record<string, unknown> | undefined {
    const payload: Record<string, unknown> = {
      ...(this.extraBody ?? {}),
    };
    if (this.providerOptions) {
      payload.providerOptions = this.providerOptions;
    }
    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  private cloneMessages(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  ) {
    return messages.map((message: any) => ({
      ...message,
      content: Array.isArray(message?.content)
        ? message.content.map((part: any) => ({ ...part }))
        : message?.content,
    }));
  }

  private appendJsonInstructionToMessages(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    schema: Record<string, unknown>
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const cloned = this.cloneMessages(messages) as any[];
    const instruction =
      '\n\nIMPORTANT: You must respond with ONLY a valid JSON object ' +
      '(no markdown, no code blocks, no explanations) that exactly matches this schema:\n' +
      `${JSON.stringify(schema, null, 2)}`;

    if (cloned.length > 0 && cloned[0]?.role === 'system') {
      if (typeof cloned[0].content === 'string') {
        cloned[0].content = `${cloned[0].content}${instruction}`;
      } else if (Array.isArray(cloned[0].content)) {
        cloned[0].content = [
          ...cloned[0].content,
          { type: 'text', text: instruction },
        ];
      } else {
        cloned[0].content = instruction;
      }
      return cloned as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    }

    for (let i = cloned.length - 1; i >= 0; i -= 1) {
      if (cloned[i]?.role === 'user') {
        if (typeof cloned[i].content === 'string') {
          cloned[i].content = `${cloned[i].content}${instruction}`;
        } else if (Array.isArray(cloned[i].content)) {
          cloned[i].content = [
            ...cloned[i].content,
            { type: 'text', text: instruction },
          ];
        } else {
          cloned[i].content = instruction;
        }
        return cloned as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
      }
    }

    cloned.unshift({
      role: 'system',
      content: instruction,
    });
    return cloned as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  }

  private parseStructuredJson(text: string): unknown {
    let jsonText = String(text ?? '').trim();
    if (jsonText.startsWith('```json') && jsonText.endsWith('```')) {
      jsonText = jsonText.slice(7, -3).trim();
    } else if (jsonText.startsWith('```') && jsonText.endsWith('```')) {
      jsonText = jsonText.slice(3, -3).trim();
    }
    return JSON.parse(jsonText);
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
    const serializer = new VercelMessageSerializer();
    const vercelMessages = serializer.serialize(messages);

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

    const extraBodyPayload = this.getExtraBodyPayload();

    const isGoogleModel = this.model.startsWith('google/');
    const isAnthropicModel = this.model.startsWith('anthropic/');
    const isReasoningModel = (this.reasoningModels ?? []).some((pattern) =>
      String(this.model).toLowerCase().includes(String(pattern).toLowerCase())
    );

    if (
      output_format &&
      zodSchemaCandidate &&
      (isGoogleModel || isAnthropicModel || isReasoningModel)
    ) {
      try {
        const rawJsonSchema = zodSchemaToJsonSchema(zodSchemaCandidate as any, {
          name: 'agent_output',
          target: 'jsonSchema7',
        });
        const optimizedJsonSchema = SchemaOptimizer.createGeminiOptimizedSchema(
          rawJsonSchema as Record<string, unknown>
        );
        const requestMessages = this.appendJsonInstructionToMessages(
          vercelMessages,
          optimizedJsonSchema
        );

        const request: Record<string, unknown> = {
          model: this.model,
          messages: requestMessages,
          ...modelParams,
        };
        if (extraBodyPayload) {
          request.extra_body = extraBodyPayload;
        }

        const response = await this.client.chat.completions.create(
          request as any,
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

        const completion = this.parseOutput(
          output_format,
          this.parseStructuredJson(content)
        );
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
        throw new ModelProviderError(
          `Failed to parse JSON response: ${error?.message ?? String(error)}`,
          500,
          this.model
        );
      }
    }

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

    const request: Record<string, unknown> = {
      model: this.model,
      messages: vercelMessages,
      response_format: responseFormat,
      ...modelParams,
    };
    if (extraBodyPayload) {
      request.extra_body = extraBodyPayload;
    }

    try {
      const response = await this.client.chat.completions.create(
        request as any,
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
        if (zodSchemaCandidate) {
          completion = this.parseOutput(output_format, JSON.parse(content));
        } else {
          completion = this.parseOutput(output_format, content);
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
