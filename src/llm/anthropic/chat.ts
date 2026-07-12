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
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { rejectRedirectsInFetchOptions } from '../http.js';

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
  outputConfig?: Record<string, unknown> | null;
  thinking?: Record<string, unknown> | null;
  betas?: string[] | null;
  fallbacks?: Array<Record<string, unknown>> | null;
  inferenceGeo?: string | null;
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
  private outputConfig: Record<string, unknown> | null;
  private thinking: Record<string, unknown> | null;
  private betas: string[] | null;
  private fallbacks: Array<Record<string, unknown>> | null;
  private inferenceGeo: string | null;
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
      outputConfig = null,
      thinking = null,
      betas = null,
      fallbacks = null,
      inferenceGeo = null,
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
    this.outputConfig = outputConfig ? { ...outputConfig } : null;
    this.thinking = thinking ? { ...thinking } : null;
    this.betas = betas ? [...betas] : null;
    this.fallbacks = fallbacks
      ? fallbacks.map((fallback) => ({ ...fallback }))
      : null;
    this.inferenceGeo = inferenceGeo;
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
      fetchOptions: rejectRedirectsInFetchOptions(
        fetchOptions as RequestInit | undefined
      ) as ClientOptions['fetchOptions'],
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private isAdaptiveThinkingOnlyModel(): boolean {
    const model = this.model.toLowerCase();
    return (
      model.includes('claude-fable-5') || model.includes('claude-mythos-5')
    );
  }

  private requiresAutoToolChoice(): boolean {
    if (this.isAdaptiveThinkingOnlyModel()) {
      return true;
    }
    return this.thinking !== null && this.thinking.type !== 'disabled';
  }

  private validateThinkingConfig(): void {
    if (!this.thinking || !this.isAdaptiveThinkingOnlyModel()) {
      return;
    }
    const thinkingType = this.thinking.type;
    if (
      thinkingType === 'enabled' ||
      thinkingType === 'disabled' ||
      Object.prototype.hasOwnProperty.call(this.thinking, 'budget_tokens')
    ) {
      throw new ModelProviderError(
        `${this.model} only supports adaptive thinking. Omit thinking or use ` +
          `an adaptive configuration such as { type: 'adaptive', display: 'summarized' }.`,
        400,
        this.model
      );
    }
  }

  private getBetasForInvoke(): string[] | null {
    if (this.fallbacks === null) {
      return this.betas ? [...this.betas] : null;
    }
    const betas = [...(this.betas ?? [])];
    if (!betas.some((beta) => beta.startsWith('server-side-fallback-'))) {
      betas.push('server-side-fallback-2026-06-01');
    }
    return betas;
  }

  private getModelParams(): Record<string, unknown> {
    this.validateThinkingConfig();
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
    if (this.outputConfig !== null) {
      modelParams.output_config = this.outputConfig;
    }
    if (this.thinking !== null) {
      modelParams.thinking = this.thinking;
    }
    if (this.fallbacks !== null) {
      modelParams.fallbacks = this.fallbacks;
    }
    if (this.inferenceGeo !== null) {
      modelParams.inference_geo = this.inferenceGeo;
    }
    return modelParams;
  }

  private async createMessage(
    requestPayload: Record<string, unknown>,
    options: ChatInvokeOptions
  ): Promise<any> {
    const requestOptions = options.signal
      ? { signal: options.signal }
      : undefined;
    const betas = this.getBetasForInvoke();
    if (betas !== null) {
      return (this.client as any).beta.messages.create(
        { ...requestPayload, betas },
        requestOptions
      );
    }
    return this.client.messages.create(requestPayload as any, requestOptions);
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

  private extractContentBlocks(response: any): {
    text: string;
    thinking: string | null;
    redactedThinking: string | null;
  } {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const redactedThinkingParts: string[] = [];

    for (const block of Array.isArray(response?.content)
      ? response.content
      : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (
        block?.type === 'thinking' &&
        typeof block.thinking === 'string'
      ) {
        thinkingParts.push(block.thinking);
      } else if (block?.type === 'redacted_thinking') {
        const redacted = block.data ?? block.redacted_thinking;
        if (redacted != null) {
          redactedThinkingParts.push(String(redacted));
        }
      }
    }

    const firstBlock = response?.content?.[0];
    return {
      text:
        textParts.length > 0
          ? textParts.join('')
          : firstBlock == null
            ? ''
            : String(firstBlock),
      thinking: thinkingParts.length > 0 ? thinkingParts.join('\n') : null,
      redactedThinking:
        redactedThinkingParts.length > 0
          ? redactedThinkingParts.join('\n')
          : null,
    };
  }

  private isMessageLikeResponse(response: any): boolean {
    return (
      Array.isArray(response?.content) &&
      response?.usage != null &&
      Object.prototype.hasOwnProperty.call(response, 'stop_reason')
    );
  }

  private getUsage(response: any): ChatInvokeUsage {
    const cacheReadTokens =
      (response.usage as any).cache_read_input_tokens ?? 0;
    const cacheCreationTokens =
      (response.usage as any).cache_creation_input_tokens ?? 0;
    const cacheCreation = (response.usage as any).cache_creation;

    return {
      prompt_tokens: response.usage.input_tokens + cacheReadTokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      prompt_cached_tokens: cacheReadTokens || null,
      prompt_cache_creation_tokens: cacheCreationTokens || null,
      prompt_cache_creation_5m_tokens:
        cacheCreation?.ephemeral_5m_input_tokens ?? null,
      prompt_cache_creation_1h_tokens:
        cacheCreation?.ephemeral_1h_input_tokens ?? null,
      prompt_image_tokens: null,
      pricing_multiplier:
        String(this.inferenceGeo ?? '').toLowerCase() === 'us' ? 1.1 : null,
    };
  }

  private getStopDetails(response: any): Record<string, unknown> | null {
    const details = response?.stop_details;
    if (!details || typeof details !== 'object') {
      return null;
    }
    return Object.fromEntries(
      Object.entries(details).filter(([, value]) => value !== undefined)
    );
  }

  private getJsonCandidates(text: string): string[] {
    const stripped = text.trim();
    const candidates: string[] = stripped ? [stripped] : [];
    if (stripped.startsWith('```') && stripped.endsWith('```')) {
      const lines = stripped.split('\n');
      if (lines.length >= 3) {
        candidates.push(lines.slice(1, -1).join('\n').trim());
      }
    }
    for (const [startCharacter, endCharacter] of [
      ['{', '}'],
      ['[', ']'],
    ] as const) {
      const start = stripped.indexOf(startCharacter);
      const end = stripped.lastIndexOf(endCharacter);
      if (start >= 0 && end > start) {
        candidates.push(stripped.slice(start, end + 1));
      }
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  private parseTextStructuredOutput<T>(
    outputFormat: { parse: (input: string) => T },
    text: string
  ): T | undefined {
    for (const candidate of this.getJsonCandidates(text)) {
      try {
        return this.parseOutput(outputFormat, JSON.parse(candidate));
      } catch {
        // Try the next candidate extracted from the response text.
      }
    }
    return undefined;
  }

  private parseToolInput<T>(
    outputFormat: { parse: (input: string) => T },
    input: unknown
  ): T {
    try {
      return this.parseOutput(outputFormat, input);
    } catch (initialError) {
      let normalized = input;
      if (typeof normalized === 'string') {
        normalized = JSON.parse(normalized);
      } else if (
        normalized &&
        typeof normalized === 'object' &&
        !Array.isArray(normalized)
      ) {
        normalized = { ...(normalized as Record<string, unknown>) };
        for (const [key, value] of Object.entries(
          normalized as Record<string, unknown>
        )) {
          if (
            typeof value === 'string' &&
            (value.startsWith('[') || value.startsWith('{'))
          ) {
            try {
              (normalized as Record<string, unknown>)[key] = JSON.parse(value);
            } catch {
              const cleaned = value
                .replaceAll('\n', '\\n')
                .replaceAll('\r', '\\r')
                .replaceAll('\t', '\\t');
              try {
                (normalized as Record<string, unknown>)[key] =
                  JSON.parse(cleaned);
              } catch {
                // Leave genuinely textual fields unchanged.
              }
            }
          }
        }
      } else {
        throw initialError;
      }
      return this.parseOutput(outputFormat, normalized);
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
        toolChoice = this.requiresAutoToolChoice()
          ? ({ type: 'auto' } as Anthropic.ToolChoice)
          : { type: 'tool', name: toolName };
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
      const response = await this.createMessage(requestPayload, options);

      if (!this.isMessageLikeResponse(response)) {
        throw new ModelProviderError(
          `Unexpected response type from Anthropic API: ${typeof response}`,
          502,
          this.model
        );
      }

      raiseIfStructuredOutputTruncated(
        output_format,
        (response as any).stop_reason,
        {
          model: this.model,
          tokenLimit: this.maxTokens,
        }
      );

      const content = this.extractContentBlocks(response);
      const usage = this.getUsage(response);
      const stopReason = response?.stop_reason ?? null;
      const stopDetails = this.getStopDetails(response);
      let completion: T | string = content.text;

      if (output_format) {
        const toolUseBlock = response.content.find(
          (block: any) => block.type === 'tool_use'
        );

        if (toolUseBlock && toolUseBlock.type === 'tool_use') {
          completion = this.parseToolInput(output_format, toolUseBlock.input);
        } else if (tools?.length) {
          const allowsTextCompletion = this.requiresAutoToolChoice();
          const textCompletion = allowsTextCompletion
            ? this.parseTextStructuredOutput(output_format, content.text)
            : undefined;
          if (textCompletion === undefined) {
            throw new ModelProviderError(
              allowsTextCompletion
                ? 'Expected tool use or valid structured text in response but none found'
                : 'Expected tool use in response but none found',
              502,
              this.model
            );
          }
          completion = textCompletion;
        } else {
          completion = this.parseOutput(output_format, completion);
        }
      }

      return new ChatInvokeCompletion(
        completion,
        usage,
        content.thinking,
        content.redactedThinking,
        stopReason,
        stopDetails
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
