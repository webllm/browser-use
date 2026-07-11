import {
  ConfigFileAuthenticationDetailsProvider,
  InstancePrincipalsAuthenticationDetailsProviderBuilder,
  ResourcePrincipalAuthenticationDetailsProvider,
  SimpleAuthenticationDetailsProvider,
  type AuthenticationDetailsProvider,
} from 'oci-common';
import { GenerativeAiInferenceClient } from 'oci-generativeaiinference';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import {
  ModelProviderError,
  ModelRateLimitError,
  raiseIfOutputTruncated,
} from '../exceptions.js';
import type { Message } from '../messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../schema.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import { OCIRawMessageSerializer } from './serializer.js';

export interface ChatOCIRawOptions {
  model?: string;
  modelId?: string;
  serviceEndpoint?: string;
  compartmentId?: string;
  provider?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  topP?: number | null;
  topK?: number | null;
  authType?: 'API_KEY' | 'INSTANCE_PRINCIPAL' | 'RESOURCE_PRINCIPAL' | string;
  authProfile?: string;
  configFilePath?: string;
  tenancyId?: string;
  userId?: string;
  fingerprint?: string;
  privateKey?: string;
  passphrase?: string | null;
  responseSchemaName?: string;
}

type OciUsagePayload = {
  promptTokens?: number;
  promptTokensDetails?: {
    cachedTokens?: number;
  };
  completionTokens?: number;
  completionTokensDetails?: {
    reasoningTokens?: number;
  };
  totalTokens?: number;
};

type OciGenericChoicePayload = {
  finishReason?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }>;
    reasoningContent?: string;
  };
};

type OciGenericChatResponsePayload = {
  apiFormat?: string;
  usage?: OciUsagePayload;
  choices?: OciGenericChoicePayload[];
};

type OciCohereChatResponsePayload = {
  apiFormat?: string;
  usage?: OciUsagePayload;
  text?: string;
  finishReason?: string;
};

type OciChatResponsePayload =
  | OciGenericChatResponsePayload
  | OciCohereChatResponsePayload;

type OciChatResultPayload = {
  chatResult?: {
    chatResponse?: OciChatResponsePayload;
  };
};

const parseStructuredJson = (text: string): unknown => {
  let jsonText = String(text ?? '').trim();
  if (jsonText.startsWith('```json') && jsonText.endsWith('```')) {
    jsonText = jsonText.slice(7, -3).trim();
  } else if (jsonText.startsWith('```') && jsonText.endsWith('```')) {
    jsonText = jsonText.slice(3, -3).trim();
  }
  return JSON.parse(jsonText);
};

const extractZodSchema = (outputFormat: unknown) => {
  const direct = outputFormat as any;
  if (
    direct &&
    typeof direct === 'object' &&
    typeof direct.safeParse === 'function' &&
    typeof direct.parse === 'function'
  ) {
    return direct;
  }

  const nested = (outputFormat as any)?.schema;
  if (
    nested &&
    typeof nested === 'object' &&
    typeof nested.safeParse === 'function' &&
    typeof nested.parse === 'function'
  ) {
    return nested;
  }

  return null;
};

const parseOutput = <T>(
  outputFormat: { parse: (input: unknown) => T },
  payload: unknown
): T => {
  const maybeWrapped = outputFormat as any;
  if (
    maybeWrapped &&
    typeof maybeWrapped === 'object' &&
    maybeWrapped.schema &&
    typeof maybeWrapped.schema.parse === 'function'
  ) {
    return maybeWrapped.schema.parse(payload);
  }
  return outputFormat.parse(payload);
};

const appendJsonInstruction = (
  messages: Array<Record<string, unknown>>,
  schema: Record<string, unknown> | null
) => {
  const instruction =
    '\n\nIMPORTANT: You must respond with ONLY a valid JSON object ' +
    '(no markdown, no code blocks, no explanations)' +
    (schema
      ? ` that exactly matches this schema:\n${JSON.stringify(schema, null, 2)}`
      : '.');

  const target =
    [...messages]
      .reverse()
      .find(
        (message) => message.role === 'USER' || message.role === 'SYSTEM'
      ) ?? null;

  if (target) {
    const content = Array.isArray(target.content)
      ? [...(target.content as Array<Record<string, unknown>>)]
      : [];
    content.push({
      type: 'TEXT',
      text: instruction,
    });
    target.content = content;
    return messages;
  }

  return [
    {
      role: 'SYSTEM',
      content: [
        {
          type: 'TEXT',
          text: instruction,
        },
      ],
    },
    ...messages,
  ];
};

export class ChatOCIRaw implements BaseChatModel {
  public model: string;
  public provider = 'oci-raw';
  private readonly serviceEndpoint: string;
  private readonly compartmentId: string;
  private readonly ociProvider: string;
  private readonly temperature: number | null;
  private readonly maxTokens: number | null;
  private readonly frequencyPenalty: number | null;
  private readonly presencePenalty: number | null;
  private readonly topP: number | null;
  private readonly topK: number | null;
  private readonly authType: string;
  private readonly authProfile: string;
  private readonly configFilePath?: string;
  private readonly tenancyId?: string;
  private readonly userId?: string;
  private readonly fingerprint?: string;
  private readonly privateKey?: string;
  private readonly passphrase: string | null;
  private readonly responseSchemaName: string;
  private clientPromise: Promise<GenerativeAiInferenceClient> | null = null;

  constructor(options: ChatOCIRawOptions = {}) {
    this.model =
      options.model ??
      options.modelId ??
      process.env.OCI_MODEL_ID ??
      (() => {
        throw new Error('ChatOCIRaw requires model or OCI_MODEL_ID');
      })();
    this.serviceEndpoint =
      options.serviceEndpoint ??
      process.env.OCI_SERVICE_ENDPOINT ??
      (() => {
        throw new Error(
          'ChatOCIRaw requires serviceEndpoint or OCI_SERVICE_ENDPOINT'
        );
      })();
    this.compartmentId =
      options.compartmentId ??
      process.env.OCI_COMPARTMENT_ID ??
      (() => {
        throw new Error(
          'ChatOCIRaw requires compartmentId or OCI_COMPARTMENT_ID'
        );
      })();
    this.ociProvider = options.provider ?? process.env.OCI_PROVIDER ?? 'meta';
    this.temperature = options.temperature ?? 1.0;
    this.maxTokens = options.maxTokens ?? 600;
    this.frequencyPenalty = options.frequencyPenalty ?? 0.0;
    this.presencePenalty = options.presencePenalty ?? 0.0;
    this.topP = options.topP ?? 0.75;
    this.topK = options.topK ?? 0;
    this.authType = options.authType ?? process.env.OCI_AUTH_TYPE ?? 'API_KEY';
    this.authProfile =
      options.authProfile ??
      process.env.OCI_AUTH_PROFILE ??
      process.env.OCI_CONFIG_PROFILE ??
      'DEFAULT';
    this.configFilePath = options.configFilePath ?? process.env.OCI_CONFIG_FILE;
    this.tenancyId = options.tenancyId ?? process.env.OCI_TENANCY_ID;
    this.userId = options.userId ?? process.env.OCI_USER_ID;
    this.fingerprint = options.fingerprint ?? process.env.OCI_FINGERPRINT;
    this.privateKey = options.privateKey ?? process.env.OCI_PRIVATE_KEY;
    this.passphrase =
      options.passphrase ?? process.env.OCI_PRIVATE_KEY_PASSPHRASE ?? null;
    this.responseSchemaName =
      options.responseSchemaName ?? 'browser_use_response';
  }

  get name(): string {
    if (this.model.length <= 90) {
      return this.model;
    }
    const parts = this.model.split('.');
    if (parts.length >= 4) {
      return `oci-${this.ociProvider}-${parts[3]}`;
    }
    return `oci-${this.ociProvider}-model`;
  }

  get model_name(): string {
    return this.name;
  }

  private usesCohereFormat(): boolean {
    return this.ociProvider.toLowerCase() === 'cohere';
  }

  private async createAuthProvider(): Promise<AuthenticationDetailsProvider> {
    const authType = this.authType.toUpperCase();
    if (authType === 'INSTANCE_PRINCIPAL') {
      return new InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
    }
    if (authType === 'RESOURCE_PRINCIPAL') {
      return ResourcePrincipalAuthenticationDetailsProvider.builder();
    }

    if (this.tenancyId && this.userId && this.fingerprint && this.privateKey) {
      return new SimpleAuthenticationDetailsProvider(
        this.tenancyId,
        this.userId,
        this.fingerprint,
        this.privateKey,
        this.passphrase
      );
    }

    return new ConfigFileAuthenticationDetailsProvider(
      this.configFilePath,
      this.authProfile
    );
  }

  private async getClient(): Promise<GenerativeAiInferenceClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const authenticationDetailsProvider = await this.createAuthProvider();
        const client = new GenerativeAiInferenceClient({
          authenticationDetailsProvider,
        });
        client.endpoint = this.serviceEndpoint;
        return client;
      })();
    }

    return this.clientPromise;
  }

  private getUsage(
    payload: OciChatResponsePayload | undefined
  ): ChatInvokeUsage | null {
    const usage = payload?.usage;
    if (!usage) {
      return null;
    }

    const reasoningTokens = usage.completionTokensDetails?.reasoningTokens ?? 0;
    const completionTokens = (usage.completionTokens ?? 0) + reasoningTokens;

    return {
      prompt_tokens: usage.promptTokens ?? 0,
      prompt_cached_tokens: usage.promptTokensDetails?.cachedTokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: completionTokens,
      total_tokens:
        usage.totalTokens ?? (usage.promptTokens ?? 0) + completionTokens,
    };
  }

  private buildGenericRequest(
    messages: Message[],
    outputFormat?: { parse: (input: unknown) => unknown } | undefined
  ) {
    const zodSchema = extractZodSchema(outputFormat);
    const serializedMessages =
      OCIRawMessageSerializer.serializeMessages(messages);
    const optimizedSchema = zodSchema
      ? SchemaOptimizer.createOptimizedJsonSchema(
          zodSchemaToJsonSchema(zodSchema)
        )
      : null;

    const requestMessages =
      outputFormat && !zodSchema
        ? appendJsonInstruction(serializedMessages, null)
        : serializedMessages;

    const request: Record<string, unknown> = {
      apiFormat: 'GENERIC',
      messages: requestMessages,
    };

    if (this.temperature !== null) {
      request.temperature = this.temperature;
    }
    if (this.maxTokens !== null) {
      request.maxTokens = this.maxTokens;
    }
    if (this.frequencyPenalty !== null) {
      request.frequencyPenalty = this.frequencyPenalty;
    }
    if (this.presencePenalty !== null) {
      request.presencePenalty = this.presencePenalty;
    }
    if (this.topP !== null) {
      request.topP = this.topP;
    }
    if (this.topK !== null) {
      request.topK = this.topK;
    }
    if (optimizedSchema) {
      request.responseFormat = {
        type: 'JSON_SCHEMA',
        jsonSchema: {
          name: this.responseSchemaName,
          schema: optimizedSchema,
          isStrict: true,
        },
      };
    }

    return request;
  }

  private buildCohereRequest(
    messages: Message[],
    outputFormat?: { parse: (input: unknown) => unknown } | undefined
  ) {
    const zodSchema = extractZodSchema(outputFormat);
    const optimizedSchema = zodSchema
      ? SchemaOptimizer.createOptimizedJsonSchema(
          zodSchemaToJsonSchema(zodSchema)
        )
      : null;
    let conversation =
      OCIRawMessageSerializer.serializeMessagesForCohere(messages);

    if (outputFormat) {
      conversation +=
        '\n\nIMPORTANT: You must respond with ONLY a valid JSON object (no markdown, no code blocks, no explanations)' +
        (optimizedSchema
          ? ` that exactly matches this schema:\n${JSON.stringify(optimizedSchema, null, 2)}`
          : '.');
    }

    const request: Record<string, unknown> = {
      apiFormat: 'COHERE',
      message: conversation,
    };

    if (this.temperature !== null) {
      request.temperature = this.temperature;
    }
    if (this.maxTokens !== null) {
      request.maxTokens = this.maxTokens;
    }
    if (this.frequencyPenalty !== null) {
      request.frequencyPenalty = this.frequencyPenalty;
    }
    if (this.presencePenalty !== null) {
      request.presencePenalty = this.presencePenalty;
    }
    if (this.topP !== null) {
      request.topP = this.topP;
    }
    if (this.topK !== null) {
      request.topK = this.topK;
    }

    return request;
  }

  private buildChatRequest(
    messages: Message[],
    outputFormat?: { parse: (input: unknown) => unknown } | undefined
  ) {
    const chatRequest = this.usesCohereFormat()
      ? this.buildCohereRequest(messages, outputFormat)
      : this.buildGenericRequest(messages, outputFormat);

    return {
      chatDetails: {
        compartmentId: this.compartmentId,
        servingMode: {
          servingType: 'ON_DEMAND',
          modelId: this.model,
        },
        chatRequest,
      },
    };
  }

  private extractText(payload: OciChatResponsePayload | undefined): {
    text: string;
    thinking: string | null;
    stopReason: string | null;
  } {
    if (!payload) {
      throw new ModelProviderError(
        'OCI response did not include chatResponse payload',
        502,
        this.name
      );
    }

    if (payload.apiFormat === 'COHERE') {
      const coherePayload = payload as OciCohereChatResponsePayload;
      return {
        text: coherePayload.text ?? '',
        thinking: null,
        stopReason: coherePayload.finishReason ?? null,
      };
    }

    const genericPayload = payload as OciGenericChatResponsePayload;
    const choice = genericPayload.choices?.[0];
    const text = choice?.message?.content
      ?.filter((part) => part.type === 'TEXT')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();

    return {
      text: text ?? '',
      thinking: choice?.message?.reasoningContent ?? null,
      stopReason: choice?.finishReason ?? null,
    };
  }

  private mapError(error: unknown): never {
    if (error instanceof ModelProviderError) {
      throw error;
    }
    const statusCode =
      typeof (error as any)?.statusCode === 'number'
        ? (error as any).statusCode
        : 502;
    const message = String(
      (error as any)?.message ?? error ?? 'OCI request failed'
    );

    if (statusCode === 429) {
      throw new ModelRateLimitError(message, statusCode, this.name);
    }

    throw new ModelProviderError(message, statusCode, this.name);
  }

  async ainvoke(
    messages: Message[],
    outputFormat?: undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<string>>;
  async ainvoke<T>(
    messages: Message[],
    outputFormat: { parse: (input: unknown) => T } | undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T>>;
  async ainvoke<T>(
    messages: Message[],
    outputFormat?: { parse: (input: unknown) => T } | undefined,
    _options: ChatInvokeOptions = {}
  ): Promise<ChatInvokeCompletion<T | string>> {
    try {
      const client = await this.getClient();
      const response = (await client.chat(
        this.buildChatRequest(messages, outputFormat as any) as any
      )) as OciChatResultPayload | null;

      if (!response || typeof response !== 'object') {
        throw new ModelProviderError(
          'OCI chat request returned an empty response',
          502,
          this.name
        );
      }

      const payload = response.chatResult?.chatResponse;
      const usage = this.getUsage(payload);
      const { text, thinking, stopReason } = this.extractText(payload);
      raiseIfOutputTruncated(stopReason, {
        model: this.model,
        tokenLimit: this.maxTokens,
      });

      if (!outputFormat) {
        return new ChatInvokeCompletion(
          text,
          usage,
          thinking,
          null,
          stopReason
        );
      }

      const parsed = parseOutput(outputFormat, parseStructuredJson(text));
      return new ChatInvokeCompletion(
        parsed,
        usage,
        thinking,
        null,
        stopReason
      );
    } catch (error) {
      this.mapError(error);
    }
  }
}
