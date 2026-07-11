import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type {
  GenerateContentConfig,
  GenerateContentParameters,
} from '@google/genai';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ModelProviderError, raiseIfOutputTruncated } from '../exceptions.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import type { Message } from '../messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { GoogleMessageSerializer } from './serializer.js';
import { get_browser_use_version } from '../../utils.js';

export interface ChatGoogleOptions {
  model?: string;
  apiKey?: string;
  apiVersion?: string;
  baseUrl?: string;
  vertexai?: boolean;
  vertexAi?: boolean;
  project?: string;
  location?: string;
  httpOptions?: Record<string, unknown>;
  googleAuthOptions?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  temperature?: number | null;
  topP?: number | null;
  seed?: number | null;
  thinkingBudget?: number | null;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | null;
  maxOutputTokens?: number | null;
  config?: Record<string, unknown> | null;
  includeSystemInUser?: boolean;
  supportsStructuredOutput?: boolean;
  maxRetries?: number;
  retryableStatusCodes?: number[];
  retryBaseDelay?: number;
  retryMaxDelay?: number;
}

const buildGoogleHttpOptions = (
  httpOptions: Record<string, unknown> | undefined
) => {
  const resolvedHttpOptions: Record<string, unknown> = {
    ...(httpOptions ?? {}),
  };
  const existingHeaders = resolvedHttpOptions.headers;
  const headers: Record<string, string> =
    existingHeaders &&
    typeof existingHeaders === 'object' &&
    !Array.isArray(existingHeaders)
      ? Object.fromEntries(
          Object.entries(existingHeaders as Record<string, unknown>).map(
            ([key, value]) => [String(key), String(value)]
          )
        )
      : {};

  headers['x-goog-api-client'] =
    `browser-use/${get_browser_use_version() || 'unknown'}`;
  resolvedHttpOptions.headers = headers;
  return resolvedHttpOptions;
};

const googleThinkingLevelByName = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} as const;

export class ChatGoogle implements BaseChatModel {
  public model: string;
  public provider = 'google';
  private client: GoogleGenAI;
  private temperature: number | null;
  private topP: number | null;
  private seed: number | null;
  private thinkingBudget: number | null;
  private thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | null;
  private maxOutputTokens: number | null;
  private config: Record<string, unknown> | null;
  private includeSystemInUser: boolean;
  private supportsStructuredOutput: boolean;
  private maxRetries: number;
  private retryableStatusCodes: number[];
  private retryBaseDelay: number;
  private retryMaxDelay: number;

  constructor(options: string | ChatGoogleOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'gemini-2.5-flash',
      apiKey = process.env.GOOGLE_API_KEY,
      apiVersion = process.env.GOOGLE_API_VERSION,
      baseUrl = process.env.GOOGLE_API_BASE_URL,
      vertexai,
      vertexAi,
      project,
      location,
      httpOptions,
      googleAuthOptions,
      credentials,
      temperature = 0.5,
      topP = null,
      seed = null,
      thinkingBudget = null,
      thinkingLevel = null,
      maxOutputTokens = 8096,
      config = null,
      includeSystemInUser = false,
      supportsStructuredOutput = true,
      maxRetries = 5,
      retryableStatusCodes = [429, 500, 502, 503, 504],
      retryBaseDelay = 1.0,
      retryMaxDelay = 60.0,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.seed = seed;
    this.thinkingBudget = thinkingBudget;
    this.thinkingLevel = thinkingLevel;
    this.maxOutputTokens = maxOutputTokens;
    this.config = config ? { ...config } : null;
    this.includeSystemInUser = includeSystemInUser;
    this.supportsStructuredOutput = supportsStructuredOutput;
    this.maxRetries = Math.max(1, maxRetries);
    this.retryableStatusCodes = [...retryableStatusCodes];
    this.retryBaseDelay = retryBaseDelay;
    this.retryMaxDelay = retryMaxDelay;

    const resolvedGoogleAuthOptions =
      credentials == null
        ? googleAuthOptions
        : {
            ...(googleAuthOptions ?? {}),
            credentials,
          };

    const resolvedVertexAi = vertexai ?? vertexAi;
    const resolvedHttpOptions = buildGoogleHttpOptions(httpOptions);

    const clientOptions: Record<string, unknown> = {
      ...(apiKey != null ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(resolvedVertexAi != null ? { vertexai: resolvedVertexAi } : {}),
      ...(project ? { project } : {}),
      ...(location ? { location } : {}),
      httpOptions: resolvedHttpOptions,
      ...(resolvedGoogleAuthOptions
        ? { googleAuthOptions: resolvedGoogleAuthOptions }
        : {}),
    };

    this.client = new GoogleGenAI(clientOptions as any);
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getUsage(result: any): ChatInvokeUsage | null {
    const usage = result?.usageMetadata;
    if (!usage) {
      return null;
    }

    let imageTokens = 0;
    const promptTokenDetails = Array.isArray(usage.promptTokensDetails)
      ? usage.promptTokensDetails
      : [];
    for (const detail of promptTokenDetails) {
      if (String(detail?.modality ?? '').toUpperCase() === 'IMAGE') {
        imageTokens += Number(detail?.tokenCount ?? 0) || 0;
      }
    }

    const completionTokens =
      (Number(usage.candidatesTokenCount ?? 0) || 0) +
      (Number(usage.thoughtsTokenCount ?? 0) || 0);

    return {
      prompt_tokens: Number(usage.promptTokenCount ?? 0) || 0,
      prompt_cached_tokens:
        usage.cachedContentTokenCount == null
          ? null
          : Number(usage.cachedContentTokenCount),
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: imageTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.totalTokenCount ?? 0) || 0,
    };
  }

  /**
   * Clean up JSON schema for Google's format
   * Google API has specific requirements for responseSchema
   */
  private _cleanSchemaForGoogle(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const cleaned: any = {};

    for (const [key, value] of Object.entries(schema)) {
      // Skip unsupported keys
      if (
        key === '$schema' ||
        key === 'additionalProperties' ||
        key === '$ref' ||
        key === 'definitions'
      ) {
        continue;
      }

      if (key === 'properties' && typeof value === 'object') {
        cleaned.properties = {};
        for (const [propKey, propValue] of Object.entries(value as object)) {
          // Align python: hide programmatic extraction schema field from LLM JSON schema.
          if (propKey === 'output_schema') {
            continue;
          }
          cleaned.properties[propKey] = this._cleanSchemaForGoogle(propValue);
        }
      } else if (key === 'items' && typeof value === 'object') {
        cleaned.items = this._cleanSchemaForGoogle(value);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        cleaned[key] = this._cleanSchemaForGoogle(value);
      } else {
        cleaned[key] = value;
      }
    }

    const schemaType = String(cleaned.type ?? '').toUpperCase();
    if (
      schemaType === 'OBJECT' &&
      cleaned.properties &&
      typeof cleaned.properties === 'object' &&
      !Array.isArray(cleaned.properties) &&
      Object.keys(cleaned.properties).length === 0
    ) {
      cleaned.properties = {
        _placeholder: { type: 'string' },
      };
    }

    if (
      Array.isArray(cleaned.required) &&
      cleaned.properties &&
      typeof cleaned.properties === 'object' &&
      !Array.isArray(cleaned.properties)
    ) {
      const validKeys = new Set(Object.keys(cleaned.properties));
      cleaned.required = cleaned.required.filter(
        (name: unknown) => typeof name === 'string' && validKeys.has(name)
      );
    }

    return cleaned;
  }

  private _parseStructuredJson(text: string): unknown {
    let jsonText = String(text ?? '').trim();

    const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
      jsonText = fencedMatch[1].trim();
    }

    const firstBrace = jsonText.indexOf('{');
    const lastBrace = jsonText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error(
        `Expected JSON response but got plain text: "${jsonText.slice(0, 50)}..."`
      );
    }

    return JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
  }

  private _extractStatusCode(error: any): number | null {
    const directStatus = Number(
      error?.status ??
        error?.statusCode ??
        error?.response?.status ??
        error?.response?.statusCode
    );
    if (Number.isFinite(directStatus)) {
      return directStatus;
    }

    const message = String(error?.message ?? error ?? '').toLowerCase();

    if (
      /(rate limit|resource exhausted|quota exceeded|too many requests|429)/.test(
        message
      )
    ) {
      return 429;
    }
    if (
      /(service unavailable|internal server error|bad gateway|503|502|500)/.test(
        message
      )
    ) {
      return 503;
    }
    if (/(forbidden|403)/.test(message)) {
      return 403;
    }
    if (/(timeout|timed out|cancelled|canceled)/.test(message)) {
      return 504;
    }

    return null;
  }

  private _toModelProviderError(error: any): ModelProviderError {
    if (error instanceof ModelProviderError) {
      return error;
    }
    return new ModelProviderError(
      error?.message ?? String(error),
      this._extractStatusCode(error) ?? 502,
      this.model
    );
  }

  private async _sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem(
      messages,
      this.includeSystemInUser
    );

    const requestConfig: GenerateContentConfig = this.config
      ? { ...(this.config as GenerateContentConfig) }
      : {};
    if (this.temperature !== null) {
      requestConfig.temperature = this.temperature;
    }
    if (this.topP !== null) {
      requestConfig.topP = this.topP;
    }
    if (this.seed !== null) {
      requestConfig.seed = this.seed;
    }

    const isGemini3Pro = this.model.includes('gemini-3-pro');
    const isGemini3Flash = this.model.includes('gemini-3-flash');

    if (isGemini3Pro) {
      let level = this.thinkingLevel ?? 'low';
      if (level === 'minimal' || level === 'medium') {
        level = 'low';
      }
      requestConfig.thinkingConfig = {
        thinkingLevel: googleThinkingLevelByName[level],
      };
    } else if (isGemini3Flash) {
      if (this.thinkingLevel !== null) {
        requestConfig.thinkingConfig = {
          thinkingLevel: googleThinkingLevelByName[this.thinkingLevel],
        };
      } else {
        requestConfig.thinkingConfig = {
          thinkingBudget:
            this.thinkingBudget === null ? -1 : this.thinkingBudget,
        };
      }
    } else {
      let budget = this.thinkingBudget;
      if (
        budget === null &&
        (this.model.includes('gemini-2.5') ||
          this.model.includes('gemini-flash'))
      ) {
        budget = -1;
      }
      if (budget !== null) {
        requestConfig.thinkingConfig = { thinkingBudget: budget };
      }
    }

    if (this.maxOutputTokens !== null) {
      requestConfig.maxOutputTokens = this.maxOutputTokens;
    }

    // Try to get schema from output_format
    const schemaForJson = (() => {
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

    let cleanSchemaForJson: Record<string, unknown> | null = null;
    if (schemaForJson) {
      try {
        const jsonSchema = zodSchemaToJsonSchema(schemaForJson as any);
        const optimizedSchema = SchemaOptimizer.createGeminiOptimizedSchema(
          jsonSchema as Record<string, unknown>
        );
        cleanSchemaForJson = this._cleanSchemaForGoogle(optimizedSchema);
      } catch {
        cleanSchemaForJson = null;
      }
    }

    if (cleanSchemaForJson && this.supportsStructuredOutput) {
      requestConfig.responseMimeType = 'application/json';
      requestConfig.responseSchema = cleanSchemaForJson;
    }

    const requestContents = (contents as any[]).map((entry) => ({
      ...entry,
      parts: Array.isArray((entry as any)?.parts)
        ? (entry as any).parts.map((part: any) => ({ ...part }))
        : (entry as any)?.parts,
    }));

    if (output_format && cleanSchemaForJson && !this.supportsStructuredOutput) {
      const jsonInstruction =
        '\n\nPlease respond with a valid JSON object that matches this schema: ' +
        JSON.stringify(cleanSchemaForJson);

      for (let i = requestContents.length - 1; i >= 0; i -= 1) {
        const content = requestContents[i] as any;
        if (content?.role === 'user' && Array.isArray(content?.parts)) {
          content.parts = [...content.parts, { text: jsonInstruction }];
          break;
        }
      }
    }

    if (systemInstruction && !this.includeSystemInUser) {
      requestConfig.systemInstruction = {
        role: 'system',
        parts: [{ text: systemInstruction }],
      };
    }

    if (options.signal) {
      requestConfig.abortSignal = options.signal;
    }

    const request: GenerateContentParameters = {
      model: this.model,
      contents: requestContents as any,
    };

    if (Object.keys(requestConfig).length > 0) {
      request.config = requestConfig;
    }

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        const result = await this.client.models.generateContent(request);

        const candidate = result.candidates?.[0];
        raiseIfOutputTruncated(candidate?.finishReason, {
          model: this.model,
          tokenLimit: this.maxOutputTokens,
          tokenLimitName: 'max_output_tokens',
        });
        const textParts =
          candidate?.content?.parts?.filter((p: any) => p.text) || [];
        const text = textParts.map((p: any) => p.text).join('');

        let completion: T | string = text;
        const stopReason = result?.candidates?.[0]?.finishReason ?? null;

        let parsed: any = text;
        if (output_format && schemaForJson) {
          parsed = this._parseStructuredJson(text);
        }

        if (output_format) {
          const output = output_format as any;
          if (
            schemaForJson &&
            output &&
            typeof output === 'object' &&
            output.schema &&
            typeof output.schema.parse === 'function'
          ) {
            completion = output.schema.parse(parsed);
          } else {
            completion = output.parse(parsed);
          }
        }

        return new ChatInvokeCompletion(
          completion,
          this.getUsage(result),
          null,
          null,
          stopReason
        );
      } catch (error: any) {
        const providerError = this._toModelProviderError(error);
        const shouldRetry =
          this.retryableStatusCodes.includes(providerError.statusCode) &&
          attempt < this.maxRetries - 1;

        if (!shouldRetry) {
          throw providerError;
        }

        const delaySeconds = Math.min(
          this.retryBaseDelay * 2 ** attempt,
          this.retryMaxDelay
        );
        const jitter = Math.random() * delaySeconds * 0.1;
        await this._sleep((delaySeconds + jitter) * 1000);
      }
    }

    throw new ModelProviderError(
      'Retry loop completed without response',
      500,
      this.model
    );
  }
}
