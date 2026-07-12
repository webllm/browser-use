import { AzureOpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import type { Message } from '../messages.js';
import { OpenAIMessageSerializer } from '../openai/serializer.js';
import { ResponsesAPIMessageSerializer } from '../openai/responses-serializer.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';

const RESPONSES_API_ONLY_MODELS = [
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5-codex',
  'codex-mini-latest',
  'computer-use-preview',
];

const REASONING_MODELS = [
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

export interface ChatAzureOptions {
  model?: string;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
  apiVersion?: string;
  deployment?: string;
  azureAdToken?: string | null;
  azureAdTokenProvider?: (() => Promise<string>) | null;
  timeout?: number | null;
  temperature?: number | null;
  frequencyPenalty?: number | null;
  reasoningEffort?: 'low' | 'medium' | 'high';
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale' | null;
  maxCompletionTokens?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
  defaultHeaders?: Record<string, string> | null;
  defaultQuery?: Record<string, string | undefined> | null;
  fetchImplementation?: typeof fetch;
  fetchOptions?: RequestInit | null;
  useResponsesApi?: boolean | 'auto';
  addSchemaToSystemPrompt?: boolean;
  dontForceStructuredOutput?: boolean;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatAzure implements BaseChatModel {
  public model: string;
  public provider = 'azure';
  private client: AzureOpenAI;
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
  private topP: number | null;
  private seed: number | null;
  private useResponsesApi: boolean | 'auto';
  private addSchemaToSystemPrompt: boolean;
  private dontForceStructuredOutput: boolean;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatAzureOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'gpt-4o',
      apiKey = process.env.AZURE_OPENAI_API_KEY ?? process.env.AZURE_OPENAI_KEY,
      endpoint = process.env.AZURE_OPENAI_ENDPOINT,
      baseURL = undefined,
      apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview',
      deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? model,
      azureAdToken = null,
      azureAdTokenProvider = null,
      timeout = null,
      temperature = 0.2,
      frequencyPenalty = 0.3,
      reasoningEffort = 'low',
      serviceTier = null,
      maxCompletionTokens = 4096,
      topP = null,
      seed = null,
      maxRetries = 5,
      defaultHeaders = null,
      defaultQuery = null,
      fetchImplementation,
      fetchOptions = null,
      useResponsesApi = 'auto',
      addSchemaToSystemPrompt = false,
      dontForceStructuredOutput = false,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.frequencyPenalty = frequencyPenalty;
    this.reasoningEffort = reasoningEffort;
    this.serviceTier = serviceTier;
    this.maxCompletionTokens = maxCompletionTokens;
    this.topP = topP;
    this.seed = seed;
    this.useResponsesApi = useResponsesApi;
    this.addSchemaToSystemPrompt = addSchemaToSystemPrompt;
    this.dontForceStructuredOutput = dontForceStructuredOutput;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    this.client = new AzureOpenAI({
      apiKey,
      endpoint,
      baseURL,
      apiVersion,
      deployment,
      azureADTokenProvider:
        azureAdTokenProvider ??
        (azureAdToken ? async () => String(azureAdToken) : undefined),
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
    return REASONING_MODELS.some((m) =>
      this.model.toLowerCase().includes(m.toLowerCase())
    );
  }

  private shouldUseResponsesApi(): boolean {
    if (typeof this.useResponsesApi === 'boolean') {
      return this.useResponsesApi;
    }
    return RESPONSES_API_ONLY_MODELS.some((name) =>
      this.model.toLowerCase().includes(name.toLowerCase())
    );
  }

  private getChatUsage(response: any): ChatInvokeUsage | null {
    if (!response?.usage) {
      return null;
    }

    let completionTokens = response.usage.completion_tokens;
    const completionDetails = response.usage.completion_tokens_details;
    if (completionDetails?.reasoning_tokens) {
      completionTokens += completionDetails.reasoning_tokens;
    }

    return {
      prompt_tokens: response.usage.prompt_tokens,
      prompt_cached_tokens:
        response.usage.prompt_tokens_details?.cached_tokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: completionTokens,
      total_tokens: response.usage.total_tokens,
    };
  }

  private getResponsesUsage(response: any): ChatInvokeUsage | null {
    if (!response?.usage) {
      return null;
    }

    return {
      prompt_tokens: response.usage.input_tokens ?? 0,
      prompt_cached_tokens:
        response.usage.input_tokens_details?.cached_tokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: response.usage.output_tokens ?? 0,
      total_tokens: response.usage.total_tokens ?? 0,
    };
  }

  private getResponseOutputText(response: any): string {
    if (typeof response?.output_text === 'string') {
      return response.output_text;
    }

    const outputs = Array.isArray(response?.output) ? response.output : [];
    for (const item of outputs) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') {
            return part.text;
          }
          if (typeof part?.output_text === 'string') {
            return part.output_text;
          }
        }
      }
    }

    return '';
  }

  private getModelParamsForCompletions(): Record<string, unknown> {
    const modelParams: Record<string, unknown> = {};

    if (!this.isReasoningModel()) {
      if (this.temperature !== null) {
        modelParams.temperature = this.temperature;
      }
      if (this.frequencyPenalty !== null) {
        modelParams.frequency_penalty = this.frequencyPenalty;
      }
    } else {
      modelParams.reasoning_effort = this.reasoningEffort;
    }

    if (this.maxCompletionTokens !== null) {
      modelParams.max_completion_tokens = this.maxCompletionTokens;
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

    return modelParams;
  }

  private getModelParamsForResponses(): Record<string, unknown> {
    const modelParams: Record<string, unknown> = {};

    if (!this.isReasoningModel()) {
      if (this.temperature !== null) {
        modelParams.temperature = this.temperature;
      }
      if (this.frequencyPenalty !== null) {
        modelParams.frequency_penalty = this.frequencyPenalty;
      }
    } else {
      modelParams.reasoning = { effort: this.reasoningEffort };
    }

    if (this.maxCompletionTokens !== null) {
      modelParams.max_output_tokens = this.maxCompletionTokens;
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

  private applySchemaToSystemMessage(
    openaiMessages: ChatCompletionMessageParam[],
    responseJsonSchema: Record<string, unknown>
  ) {
    if (!this.addSchemaToSystemPrompt || openaiMessages.length === 0) {
      return;
    }

    const firstMessage = openaiMessages[0] as any;
    if (firstMessage?.role !== 'system') {
      return;
    }

    const schemaText =
      `\n<json_schema>\n` +
      `${JSON.stringify(responseJsonSchema, null, 2)}\n` +
      `</json_schema>`;
    if (typeof firstMessage.content === 'string') {
      firstMessage.content = (firstMessage.content ?? '') + schemaText;
      return;
    }
    if (Array.isArray(firstMessage.content)) {
      firstMessage.content = [
        ...firstMessage.content,
        { type: 'text', text: schemaText },
      ];
    }
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
    const zodSchemaCandidate = this.getZodSchemaCandidate(output_format);
    if (this.shouldUseResponsesApi()) {
      return this.invokeResponses(
        messages,
        output_format,
        zodSchemaCandidate,
        options
      );
    }
    return this.invokeChatCompletions(
      messages,
      output_format,
      zodSchemaCandidate,
      options
    );
  }

  private async invokeChatCompletions<T>(
    messages: Message[],
    output_format: { parse: (input: string) => T } | undefined,
    zodSchemaCandidate: any,
    options: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T | string>> {
    const serializer = new OpenAIMessageSerializer();
    const openaiMessages = serializer.serialize(messages);

    let responseFormat: any = undefined;
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

        this.applySchemaToSystemMessage(
          openaiMessages as ChatCompletionMessageParam[],
          responseJsonSchema
        );

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
          ...this.getModelParamsForCompletions(),
        },
        options.signal ? { signal: options.signal } : undefined
      );

      raiseIfStructuredOutputTruncated(
        output_format,
        response.choices[0].finish_reason,
        {
          model: this.model,
          tokenLimit: this.maxCompletionTokens,
          tokenLimitName: 'max_completion_tokens',
        }
      );
      const content = response.choices[0].message.content || '';
      const usage = this.getChatUsage(response);
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
            completion = output.parse(parsedJson);
          }
        } else {
          completion = output_format.parse(content);
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

  private async invokeResponses<T>(
    messages: Message[],
    output_format: { parse: (input: string) => T } | undefined,
    zodSchemaCandidate: any,
    options: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T | string>> {
    const serializer = new ResponsesAPIMessageSerializer();
    const inputMessages = serializer.serialize(messages);

    const request: Record<string, unknown> = {
      model: this.model,
      input: inputMessages,
      ...this.getModelParamsForResponses(),
    };

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

        if (
          this.addSchemaToSystemPrompt &&
          inputMessages.length > 0 &&
          inputMessages[0]?.role === 'system'
        ) {
          const schemaText = `\n<json_schema>\n${JSON.stringify(optimizedJsonSchema)}\n</json_schema>`;
          const firstInput = inputMessages[0] as any;
          const firstContent = firstInput?.content;
          let patchedContent: unknown = firstContent ?? '';
          if (typeof firstContent === 'string') {
            patchedContent = firstContent + schemaText;
          } else if (Array.isArray(firstContent)) {
            patchedContent = [
              ...firstContent,
              { type: 'input_text', text: schemaText },
            ];
          }
          inputMessages[0] = {
            ...inputMessages[0],
            content: patchedContent as any,
          };
          request.input = inputMessages;
        }

        if (!this.dontForceStructuredOutput) {
          request.text = {
            format: {
              type: 'json_schema',
              name: 'agent_output',
              strict: true,
              schema: optimizedJsonSchema,
            },
          };
        }
      } catch {
        // Skip structured output forcing when schema conversion fails.
      }
    }

    try {
      const response = await (this.client as any).responses.create(
        request,
        options.signal ? { signal: options.signal } : undefined
      );

      raiseIfStructuredOutputTruncated(
        output_format,
        response?.incomplete_details?.reason,
        {
          model: this.model,
          tokenLimit: this.maxCompletionTokens,
          tokenLimitName: 'max_output_tokens',
        }
      );

      const content = this.getResponseOutputText(response);
      const usage = this.getResponsesUsage(response);
      const stopReason = response?.status ?? null;

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
            completion = output.parse(parsedJson);
          }
        } else {
          completion = output_format.parse(content);
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
