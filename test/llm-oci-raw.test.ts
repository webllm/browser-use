import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const chatMock = vi.fn();
const clientCtorMock = vi.fn();
const configProviderCtorMock = vi.fn();
const simpleProviderCtorMock = vi.fn();
const instanceProviderBuildMock = vi.fn();
const resourceProviderBuilderMock = vi.fn();
const createdClients: any[] = [];

vi.mock('oci-common', () => {
  class ConfigFileAuthenticationDetailsProvider {
    constructor(configFilePath?: string, profile?: string) {
      configProviderCtorMock(configFilePath, profile);
    }
  }

  class SimpleAuthenticationDetailsProvider {
    constructor(
      tenancyId: string,
      userId: string,
      fingerprint: string,
      privateKey: string,
      passphrase: string | null
    ) {
      simpleProviderCtorMock(
        tenancyId,
        userId,
        fingerprint,
        privateKey,
        passphrase
      );
    }
  }

  class InstancePrincipalsAuthenticationDetailsProviderBuilder {
    build() {
      return instanceProviderBuildMock();
    }
  }

  class ResourcePrincipalAuthenticationDetailsProvider {
    static builder() {
      return resourceProviderBuilderMock();
    }
  }

  return {
    ConfigFileAuthenticationDetailsProvider,
    SimpleAuthenticationDetailsProvider,
    InstancePrincipalsAuthenticationDetailsProviderBuilder,
    ResourcePrincipalAuthenticationDetailsProvider,
  };
});

vi.mock('oci-generativeaiinference', () => {
  class GenerativeAiInferenceClient {
    endpoint: string | undefined;

    constructor(options: unknown) {
      createdClients.push(this);
      clientCtorMock(options);
    }

    chat(request: unknown) {
      return chatMock(request);
    }
  }

  return {
    GenerativeAiInferenceClient,
  };
});

import { ChatOCIRaw, type ChatOCIRawOptions } from '../src/llm/oci-raw/chat.js';
import { ModelOutputTruncatedError } from '../src/llm/exceptions.js';
import {
  ContentPartImageParam,
  ContentPartTextParam,
  ImageURL,
  SystemMessage,
  UserMessage,
} from '../src/llm/messages.js';

const buildOptions = (
  overrides: Partial<ChatOCIRawOptions> = {}
): ChatOCIRawOptions => ({
  model: 'ocid1.generativeaimodel.oc1.region.example',
  serviceEndpoint: 'https://inference.generativeai.example.oraclecloud.com',
  compartmentId: 'ocid1.compartment.oc1..example',
  ...overrides,
});

describe('ChatOCIRaw alignment', () => {
  beforeEach(() => {
    chatMock.mockReset();
    clientCtorMock.mockReset();
    configProviderCtorMock.mockReset();
    simpleProviderCtorMock.mockReset();
    instanceProviderBuildMock.mockReset();
    resourceProviderBuilderMock.mockReset();
    createdClients.length = 0;
    instanceProviderBuildMock.mockResolvedValue({ kind: 'instance-principal' });
    resourceProviderBuilderMock.mockReturnValue({
      kind: 'resource-principal',
    });
  });

  it('uses config-file auth by default and serializes generic OCI messages', async () => {
    chatMock.mockResolvedValue({
      chatResult: {
        chatResponse: {
          apiFormat: 'GENERIC',
          usage: {
            promptTokens: 12,
            promptTokensDetails: { cachedTokens: 3 },
            completionTokens: 4,
            completionTokensDetails: { reasoningTokens: 2 },
            totalTokens: 18,
          },
          choices: [
            {
              finishReason: 'STOP',
              message: {
                role: 'ASSISTANT',
                reasoningContent: 'trace',
                content: [{ type: 'TEXT', text: 'Hello from OCI' }],
              },
            },
          ],
        },
      },
    });

    const llm = new ChatOCIRaw(
      buildOptions({
        authType: 'API_KEY',
        authProfile: 'TEST',
      })
    );

    const result = await llm.ainvoke([
      new SystemMessage('system prompt'),
      new UserMessage([
        new ContentPartTextParam('Describe this image'),
        new ContentPartImageParam(
          new ImageURL('https://example.com/image.png')
        ),
      ]),
    ]);

    expect(configProviderCtorMock).toHaveBeenCalledWith(undefined, 'TEST');
    expect(clientCtorMock.mock.calls[0]?.[0]).toMatchObject({
      authenticationDetailsProvider: expect.any(Object),
    });
    expect(createdClients[0]?.endpoint).toBe(
      'https://inference.generativeai.example.oraclecloud.com'
    );

    const request = chatMock.mock.calls[0]?.[0] as any;
    expect(request.chatDetails.compartmentId).toBe(
      'ocid1.compartment.oc1..example'
    );
    expect(request.chatDetails.servingMode).toEqual({
      servingType: 'ON_DEMAND',
      modelId: 'ocid1.generativeaimodel.oc1.region.example',
    });
    expect(request.chatDetails.chatRequest.apiFormat).toBe('GENERIC');
    expect(request.chatDetails.chatRequest.messages).toEqual([
      {
        role: 'SYSTEM',
        name: undefined,
        content: [{ type: 'TEXT', text: 'system prompt' }],
      },
      {
        role: 'USER',
        name: undefined,
        content: [
          { type: 'TEXT', text: 'Describe this image' },
          {
            type: 'IMAGE',
            imageUrl: { url: 'https://example.com/image.png' },
          },
        ],
      },
    ]);
    expect(result.completion).toBe('Hello from OCI');
    expect(result.thinking).toBe('trace');
    expect(result.stop_reason).toBe('STOP');
    expect(result.usage).toEqual({
      prompt_tokens: 12,
      prompt_cached_tokens: 3,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: 6,
      total_tokens: 18,
    });
  });

  it('supports structured output with OCI json-schema response formatting', async () => {
    chatMock.mockResolvedValue({
      chatResult: {
        chatResponse: {
          apiFormat: 'GENERIC',
          choices: [
            {
              finishReason: 'STOP',
              message: {
                role: 'ASSISTANT',
                content: [{ type: 'TEXT', text: '{"value":"ok"}' }],
              },
            },
          ],
        },
      },
    });

    const llm = new ChatOCIRaw(buildOptions());
    const result = await llm.ainvoke(
      [new UserMessage('extract structured response')],
      z.object({ value: z.string() })
    );

    const request = chatMock.mock.calls[0]?.[0] as any;
    expect(request.chatDetails.chatRequest.responseFormat).toMatchObject({
      type: 'JSON_SCHEMA',
      jsonSchema: {
        name: 'browser_use_response',
        isStrict: true,
      },
    });
    expect(
      request.chatDetails.chatRequest.responseFormat.jsonSchema.schema
        .properties.value.type
    ).toBe('string');
    expect(result.completion).toEqual({ value: 'ok' });
  });

  it('serializes Cohere providers using a single conversation string', async () => {
    chatMock.mockResolvedValue({
      chatResult: {
        chatResponse: {
          apiFormat: 'COHERE',
          text: 'done',
          finishReason: 'COMPLETE',
        },
      },
    });

    const llm = new ChatOCIRaw(
      buildOptions({
        provider: 'cohere',
      })
    );

    const result = await llm.ainvoke([
      new SystemMessage('system prompt'),
      new UserMessage('hello'),
    ]);

    const request = chatMock.mock.calls[0]?.[0] as any;
    expect(request.chatDetails.chatRequest.apiFormat).toBe('COHERE');
    expect(request.chatDetails.chatRequest.message).toContain(
      'System: system prompt'
    );
    expect(request.chatDetails.chatRequest.message).toContain('User: hello');
    expect(request.chatDetails.chatRequest.messages).toBeUndefined();
    expect(result.completion).toBe('done');
    expect(result.stop_reason).toBe('COMPLETE');
  });

  it('supports explicit instance principal auth', async () => {
    chatMock.mockResolvedValue({
      chatResult: {
        chatResponse: {
          apiFormat: 'GENERIC',
          choices: [
            {
              message: {
                content: [{ type: 'TEXT', text: 'ok' }],
              },
            },
          ],
        },
      },
    });

    const llm = new ChatOCIRaw(
      buildOptions({
        authType: 'INSTANCE_PRINCIPAL',
      })
    );

    await llm.ainvoke([new UserMessage('hello')]);
    expect(instanceProviderBuildMock).toHaveBeenCalledTimes(1);
  });

  it('reports max token finish reasons as structured output truncation', async () => {
    chatMock.mockResolvedValue({
      chatResult: {
        chatResponse: {
          apiFormat: 'GENERIC',
          choices: [
            {
              finishReason: 'MAX_TOKENS',
              message: {
                content: [{ type: 'TEXT', text: 'partial' }],
              },
            },
          ],
        },
      },
    });

    const llm = new ChatOCIRaw(buildOptions({ maxTokens: 128 }));
    await expect(
      llm.ainvoke(
        [new UserMessage('produce a long answer')],
        z.object({ value: z.string() }) as any
      )
    ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
  });
});
