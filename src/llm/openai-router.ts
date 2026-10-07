import OpenAI from 'openai';
import type { BaseChatModel, ChatInvokeOptions } from './base.js';
import {
  ModelProviderError,
  raiseIfStructuredOutputTruncated,
} from './exceptions.js';
import type { Message } from './messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from './schema.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from './views.js';
import { OpenAIMessageSerializer } from './openai/serializer.js';
import { rejectRedirectsInFetchOptions } from './http.js';
import { validateMaxRetries } from './retry.js';
import {
  MISSING_PROVIDER_API_KEY,
  createMissingApiKeyError,
  resolveProviderApiKey,
} from './api-key.js';

/** Identity of an OpenAI-compatible routing gateway. */
export interface OpenAIRouterProvider {
  /** Value of the model's `provider` field, such as `openrouter`. */
  provider: string;
  /** Human-readable gateway name used in error messages. */
  label: string;
  /** Environment variables checked, in order, when no API key is passed. */
  apiKeyEnv: readonly string[];
  defaultBaseURL: string;
}

export interface OpenAIRouterChatOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  timeout?: number | null;
  temperature?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
  defaultHeaders?: Record<string, string> | null;
  defaultQuery?: Record<string, string | undefined> | null;
  fetchImplementation?: typeof fetch;
  fetchOptions?: RequestInit | null;
  extraBody?: Record<string, unknown> | null;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

/**
 * Chat model for gateways that expose the OpenAI chat completions API and
 * route to many upstream models.
 *
 * The API key comes only from the explicit option or the gateway's own
 * environment variables: the OpenAI SDK would otherwise fall back to
 * OPENAI_API_KEY and send an unrelated provider's key to the gateway.
 */
export class OpenAIRouterChat implements BaseChatModel {
  public model: string;
  public provider: string;
  private client: OpenAI;
  private gateway: OpenAIRouterProvider;
  private hasApiKey: boolean;
  private temperature: number | null;
  private topP: number | null;
  private seed: number | null;
  private requestHeaders: Record<string, string> | null;
  private extraBody: Record<string, unknown> | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(
    gateway: OpenAIRouterProvider,
    options: OpenAIRouterChatOptions,
    requestHeaders: Record<string, string> | null = null
  ) {
    const {
      model,
      apiKey,
      baseURL = gateway.defaultBaseURL,
      timeout = null,
      temperature = null,
      topP = null,
      seed = null,
      maxRetries = 10,
      defaultHeaders = null,
      defaultQuery = null,
      fetchImplementation,
      fetchOptions = null,
      extraBody = null,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = options;

    this.gateway = gateway;
    this.provider = gateway.provider;
    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.seed = seed;
    this.requestHeaders = requestHeaders;
    this.extraBody = extraBody;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    const resolvedApiKey = resolveProviderApiKey(apiKey, gateway.apiKeyEnv);
    this.hasApiKey = resolvedApiKey !== null;

    this.client = new OpenAI({
      apiKey: resolvedApiKey ?? MISSING_PROVIDER_API_KEY,
      baseURL,
      timeout: timeout ?? undefined,
      maxRetries: validateMaxRetries(maxRetries),
      defaultHeaders: defaultHeaders ?? undefined,
      defaultQuery: defaultQuery ?? undefined,
      fetch: fetchImplementation,
      fetchOptions: rejectRedirectsInFetchOptions(fetchOptions) as any,
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
    if (!this.hasApiKey) {
      throw createMissingApiKeyError(
        this.gateway.label,
        this.gateway.apiKeyEnv,
        this.model
      );
    }
    const serializer = new OpenAIMessageSerializer();
    const serializedMessages = serializer.serialize(messages);

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
      messages: serializedMessages,
      response_format: responseFormat,
      ...modelParams,
      ...(this.extraBody ?? {}),
    };
    // The Node SDK sends unknown body fields verbatim, so request headers must
    // go through the per-request options rather than an `extra_headers` key.
    const requestOptions: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
    } = {};
    if (options.signal) {
      requestOptions.signal = options.signal;
    }
    if (this.requestHeaders && Object.keys(this.requestHeaders).length) {
      requestOptions.headers = { ...this.requestHeaders };
    }

    try {
      const response = await this.client.chat.completions.create(
        request as any,
        Object.keys(requestOptions).length > 0 ? requestOptions : undefined
      );

      const choice = Array.isArray(response?.choices)
        ? response.choices[0]
        : undefined;
      if (!choice) {
        throw new ModelProviderError(
          `Invalid ${this.gateway.label} response: missing or empty \`choices\`.`,
          502,
          this.model
        );
      }
      raiseIfStructuredOutputTruncated(output_format, choice.finish_reason, {
        model: this.model,
      });
      const content = choice.message?.content || '';
      const usage = this.getUsage(response);
      const stopReason = choice.finish_reason ?? null;

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
      if (error?.status === 429) {
        throw new ModelProviderError(
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
