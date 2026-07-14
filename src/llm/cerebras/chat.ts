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
import {
  CerebrasMessageSerializer,
  type CerebrasMessage,
} from './serializer.js';
import { rejectRedirectsInFetchOptions } from '../http.js';
import { validateMaxRetries } from '../retry.js';

export interface ChatCerebrasOptions {
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
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatCerebras implements BaseChatModel {
  public model: string;
  public provider = 'cerebras';
  private client: OpenAI;
  private temperature: number | null;
  private maxTokens: number | null;
  private topP: number | null;
  private seed: number | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatCerebrasOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'llama3.1-8b',
      apiKey = process.env.CEREBRAS_API_KEY,
      baseURL = process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
      timeout = null,
      clientParams = null,
      temperature = 0.2,
      maxTokens = 4096,
      topP = null,
      seed = null,
      maxRetries = 5,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.topP = topP;
    this.seed = seed;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

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

  private extractJsonFromContent(content: string): string {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const normalized = (fenced ? fenced[1] : content).trim();

    const firstBrace = normalized.indexOf('{');
    if (firstBrace < 0) {
      return normalized;
    }

    let depth = 0;
    for (let idx = firstBrace; idx < normalized.length; idx += 1) {
      const char = normalized[idx];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return normalized.slice(firstBrace, idx + 1);
        }
      }
    }

    return normalized.slice(firstBrace);
  }

  private appendJsonInstruction(
    serializedMessages: CerebrasMessage[],
    schemaText: string
  ): CerebrasMessage[] {
    const instruction =
      `\n\nPlease respond with a JSON object that follows this exact schema:\n` +
      `${schemaText}\n\n` +
      `Your response must be valid JSON only, no other text.`;
    if (serializedMessages.length === 0) {
      return [{ role: 'user', content: instruction }];
    }

    const cloned = [...serializedMessages];
    const last = cloned[cloned.length - 1] as any;
    if (last?.role === 'user') {
      if (typeof last.content === 'string') {
        last.content = `${last.content}${instruction}`;
        return cloned;
      }
      if (Array.isArray(last.content)) {
        last.content = [...last.content, { type: 'text', text: instruction }];
        return cloned;
      }
    }

    cloned.push({ role: 'user', content: instruction });
    return cloned;
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
    const serializer = new CerebrasMessageSerializer();
    const cerebrasMessages = serializer.serialize(messages);

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

    const zodSchemaCandidate = this.getSchemaCandidate(output_format);
    let requestMessages = cerebrasMessages;
    if (zodSchemaCandidate) {
      const rawSchema = zodSchemaToJsonSchema(zodSchemaCandidate, {
        name: 'agent_output',
        target: 'jsonSchema7',
      });
      const optimizedSchema = SchemaOptimizer.createOptimizedJsonSchema(
        rawSchema as Record<string, unknown>,
        {
          removeMinItems: this.removeMinItemsFromSchema,
          removeDefaults: this.removeDefaultsFromSchema,
        }
      );
      requestMessages = this.appendJsonInstruction(
        cerebrasMessages,
        JSON.stringify(optimizedSchema, null, 2)
      );
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: requestMessages as any,
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
        const jsonSource = zodSchemaCandidate
          ? this.extractJsonFromContent(content)
          : content;
        const parsedJson = JSON.parse(jsonSource);
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
