import { setTimeout as sleep } from 'node:timers/promises';
import { CONFIG } from '../../config.js';
import {
  HttpRequestTimeoutError,
  readBoundedResponseJson,
  readBoundedResponseText,
  runWithHttpTimeout,
} from '../../http-response.js';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfStructuredOutputTruncated,
} from '../exceptions.js';
import type { Message } from '../messages.js';
import { zodSchemaToJsonSchema } from '../schema.js';
import {
  ChatInvokeCompletion,
  type ChatInvokeUsage,
  normalizeChatInvokeUsage,
} from '../views.js';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const VALID_MODELS = new Set(['bu-latest', 'bu-1-0', 'bu-2-0']);
const PROVIDER_PREFIXED_MODEL = /^[^/\s]+\/\S+$/;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RETRY_ATTEMPTS = 100;

class HttpStatusError extends Error {
  constructor(
    public statusCode: number,
    public detail: string
  ) {
    super(`HTTP ${statusCode}: ${detail}`);
    this.name = 'HttpStatusError';
  }
}

export interface ChatBrowserUseOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryBaseDelay?: number;
  retryMaxDelay?: number;
  fast?: boolean;
  fetchImplementation?: typeof fetch;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const getJsonErrorDetail = (value: unknown): string => {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const detail =
    (value as any).detail ?? (value as any).error ?? (value as any).message;
  if (typeof detail === 'string') {
    return detail;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const requireFiniteRange = (
  name: string,
  value: number,
  minimum: number,
  maximum: number
) => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a finite number between ${minimum} and ${maximum}.`
    );
  }
  return value;
};

export class ChatBrowserUse implements BaseChatModel {
  public model: string;
  public provider = 'browser-use';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;
  private readonly fast: boolean;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ChatBrowserUseOptions = {}) {
    const {
      model = 'bu-2-0',
      apiKey = process.env.BROWSER_USE_API_KEY,
      baseUrl = process.env.BROWSER_USE_LLM_URL ??
        'https://llm.api.browser-use.com',
      timeout = 120,
      maxRetries = 5,
      retryBaseDelay = 1.0,
      retryMaxDelay = 60.0,
      fast = false,
      fetchImplementation = fetch,
    } = options;

    const isValidModel =
      VALID_MODELS.has(model) || PROVIDER_PREFIXED_MODEL.test(model);
    if (!isValidModel) {
      throw new Error(
        `Invalid model: '${model}'. Use a Browser Use alias (bu-latest, bu-1-0, bu-2-0) ` +
          `or a provider-prefixed model such as 'anthropic/claude-sonnet-4-6', ` +
          `'openai/gpt-5.5', or 'google/gemini-3-pro'.`
      );
    }

    this.model = model === 'bu-latest' ? 'bu-2-0' : model;
    if (!apiKey) {
      throw new Error(
        'You need to set the BROWSER_USE_API_KEY environment variable. Get your key at https://cloud.browser-use.com/new-api-key'
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    const boundedTimeout = requireFiniteRange(
      'timeout',
      timeout,
      0.001,
      MAX_TIMER_DELAY_MS / 1000
    );
    this.timeoutMs = Math.max(1, Math.round(boundedTimeout * 1000));
    if (
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 1 ||
      maxRetries > MAX_RETRY_ATTEMPTS
    ) {
      throw new RangeError(
        `maxRetries must be an integer between 1 and ${MAX_RETRY_ATTEMPTS}.`
      );
    }
    this.maxRetries = maxRetries;
    this.retryBaseDelay = requireFiniteRange(
      'retryBaseDelay',
      retryBaseDelay,
      0.001,
      MAX_TIMER_DELAY_MS / 1000
    );
    const boundedRetryMaxDelay = requireFiniteRange(
      'retryMaxDelay',
      retryMaxDelay,
      0.001,
      MAX_TIMER_DELAY_MS / 1000
    );
    this.retryMaxDelay = Math.max(this.retryBaseDelay, boundedRetryMaxDelay);
    this.fast = fast;
    this.fetchImplementation = fetchImplementation;
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getOutputSchema(
    output_format?: { parse: (input: string) => unknown } | undefined
  ): Record<string, unknown> | null {
    const output = output_format as any;
    if (!output || typeof output !== 'object') {
      return null;
    }

    if (typeof output.model_json_schema === 'function') {
      const schema = output.model_json_schema();
      if (schema && typeof schema === 'object') {
        return schema as Record<string, unknown>;
      }
    }

    if (
      typeof output.safeParse === 'function' &&
      typeof output.parse === 'function'
    ) {
      return zodSchemaToJsonSchema(output, {
        name: 'Response',
        target: 'jsonSchema7',
      }) as Record<string, unknown>;
    }

    if (
      output.schema &&
      typeof output.schema.safeParse === 'function' &&
      typeof output.schema.parse === 'function'
    ) {
      return zodSchemaToJsonSchema(output.schema, {
        name: 'Response',
        target: 'jsonSchema7',
      }) as Record<string, unknown>;
    }

    if (output.schema && typeof output.schema === 'object') {
      const schemaCandidate = output.schema as any;
      const schema =
        typeof schemaCandidate.toJSON === 'function'
          ? schemaCandidate.toJSON()
          : schemaCandidate;
      if (schema && typeof schema === 'object') {
        return schema as Record<string, unknown>;
      }
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

  private serializeMessage(message: Message): Record<string, unknown> {
    return {
      role: (message as any).role,
      content: (message as any).content,
    };
  }

  private getUsage(payload: any): ChatInvokeUsage | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const usage = payload.usage;
    if (!usage || typeof usage !== 'object') {
      return null;
    }

    return normalizeChatInvokeUsage(usage);
  }

  private raiseHttpError(statusCode: number, detail: string): never {
    const errorDetail = detail || `HTTP ${statusCode}`;
    if (statusCode === 401) {
      throw new ModelProviderError(
        `Invalid API key. ${errorDetail}`,
        401,
        this.model
      );
    }
    if (statusCode === 402) {
      throw new ModelProviderError(
        `Insufficient credits. ${errorDetail}`,
        402,
        this.model
      );
    }
    if (statusCode === 429) {
      throw new ModelRateLimitError(
        `Rate limit exceeded. ${errorDetail}`,
        429,
        this.model
      );
    }
    if (RETRYABLE_STATUS_CODES.has(statusCode)) {
      throw new ModelProviderError(
        `Server error. ${errorDetail}`,
        statusCode,
        this.model
      );
    }
    throw new ModelProviderError(
      `API request failed: ${errorDetail}`,
      statusCode,
      this.model
    );
  }

  private isRetryableNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    if (isAbortError(error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes('fetch failed') ||
      message.includes('networkerror') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('timeout')
    );
  }

  private async makeRequest(
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    try {
      return await runWithHttpTimeout(
        async (requestSignal) => {
          const response = await this.fetchImplementation(
            `${this.baseUrl}/v1/chat/completions`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal: requestSignal,
              redirect: 'error',
            }
          );

          if (!response.ok) {
            let detail = '';
            try {
              const errorText = await readBoundedResponseText(
                response,
                MAX_ERROR_RESPONSE_BYTES
              );
              try {
                detail = getJsonErrorDetail(JSON.parse(errorText));
              } catch {
                detail = errorText;
              }
            } catch (error) {
              detail = error instanceof Error ? error.message : '';
            }
            throw new HttpStatusError(response.status, detail);
          }

          const result = await readBoundedResponseJson(response);
          return result && typeof result === 'object'
            ? (result as Record<string, unknown>)
            : {};
        },
        this.timeoutMs,
        signal
      );
    } catch (error) {
      if (error instanceof HttpRequestTimeoutError) {
        throw new ModelProviderError(
          `Request timed out after ${Math.round(this.timeoutMs / 1000)}s`,
          408,
          this.model
        );
      }
      throw error;
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
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((message) => this.serializeMessage(message)),
      fast: this.fast,
      request_type: options.request_type ?? 'browser_agent',
      anonymized_telemetry: CONFIG.ANONYMIZED_TELEMETRY,
    };
    if (typeof (options as any).session_id === 'string') {
      payload.session_id = (options as any).session_id;
    }

    const schema = this.getOutputSchema(output_format);
    if (schema) {
      payload.output_format = schema;
    }

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        result = await this.makeRequest(payload, options.signal);
        break;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        const statusCode =
          error instanceof HttpStatusError
            ? error.statusCode
            : ((error as any)?.statusCode ?? null);
        const retryableHttp =
          typeof statusCode === 'number' &&
          RETRYABLE_STATUS_CODES.has(statusCode);
        const retryableNetwork = this.isRetryableNetworkError(error);

        if (
          attempt < this.maxRetries - 1 &&
          (retryableHttp || retryableNetwork)
        ) {
          const delaySeconds = Math.min(
            this.retryBaseDelay * 2 ** attempt,
            this.retryMaxDelay
          );
          const jitter = Math.random() * delaySeconds * 0.1;
          const sleepMs = Math.min(
            MAX_TIMER_DELAY_MS,
            Math.max(1, Math.round((delaySeconds + jitter) * 1000))
          );
          await sleep(sleepMs);
          continue;
        }

        if (error instanceof HttpStatusError) {
          this.raiseHttpError(error.statusCode, error.detail);
        }
        if (error instanceof ModelProviderError) {
          throw error;
        }
        throw new ModelProviderError(
          `Failed to connect to browser-use API: ${error instanceof Error ? error.message : String(error)}`,
          502,
          this.model
        );
      }
    }

    if (result == null) {
      throw new ModelProviderError(
        'Request failed without a response payload.',
        502,
        this.model
      );
    }

    const usage = this.getUsage(result);
    const completionPayload = (result as any).completion;
    const stopReason =
      (result as any).stop_reason ?? (result as any).finish_reason ?? null;
    raiseIfStructuredOutputTruncated(output_format, stopReason, {
      model: this.model,
    });

    if (!output_format) {
      const textCompletion =
        typeof completionPayload === 'string'
          ? completionPayload
          : JSON.stringify(completionPayload ?? '');
      return new ChatInvokeCompletion(
        textCompletion,
        usage,
        null,
        null,
        stopReason
      );
    }

    const parsedPayload =
      typeof completionPayload === 'string'
        ? (() => {
            try {
              return JSON.parse(completionPayload);
            } catch {
              return completionPayload;
            }
          })()
        : completionPayload;

    const completion = this.parseOutput(output_format, parsedPayload);
    return new ChatInvokeCompletion(completion, usage, null, null, stopReason);
  }
}
