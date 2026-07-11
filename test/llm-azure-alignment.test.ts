import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const azureCtorMock = vi.fn();
const chatCreateMock = vi.fn();
const responsesCreateMock = vi.fn();

vi.mock('openai', () => {
  class AzureOpenAI {
    chat = {
      completions: {
        create: chatCreateMock,
      },
    };

    responses = {
      create: responsesCreateMock,
    };

    constructor(options?: unknown) {
      azureCtorMock(options);
    }
  }

  return { AzureOpenAI };
});

import {
  ContentPartImageParam,
  ContentPartTextParam,
  ImageURL,
  SystemMessage,
  UserMessage,
} from '../src/llm/messages.js';
import { ChatAzure } from '../src/llm/azure/chat.js';
import { ModelOutputTruncatedError } from '../src/llm/exceptions.js';

const buildChatResponse = (content: string) => ({
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  },
});

const buildResponsesResponse = (outputText: string) => ({
  output_text: outputText,
  usage: {
    input_tokens: 12,
    output_tokens: 6,
    total_tokens: 18,
    input_tokens_details: { cached_tokens: 3 },
  },
});

describe('ChatAzure alignment', () => {
  beforeEach(() => {
    azureCtorMock.mockReset();
    chatCreateMock.mockReset();
    responsesCreateMock.mockReset();
    chatCreateMock.mockResolvedValue(buildChatResponse('chat-ok'));
    responsesCreateMock.mockResolvedValue(buildResponsesResponse('resp-ok'));
  });

  it('uses chat completions mode for regular models', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const llm = new ChatAzure({
      model: 'gpt-4o',
      apiKey: 'test-key',
      endpoint: 'https://example.openai.azure.com',
      baseURL: 'https://example.openai.azure.com/openai/',
      apiVersion: '2024-12-01-preview',
      azureAdToken: 'aad-token',
      timeout: 33333,
      temperature: 0.1,
      frequencyPenalty: 0.2,
      serviceTier: 'priority',
      maxRetries: 7,
      defaultHeaders: { 'x-azure-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetchImplementation: customFetch,
      fetchOptions: { cache: 'no-store' },
    });

    const response = await llm.ainvoke([new UserMessage('hello')]);
    const request = chatCreateMock.mock.calls[0]?.[0] ?? {};

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(request.model).toBe('gpt-4o');
    expect(request.temperature).toBe(0.1);
    expect(request.frequency_penalty).toBe(0.2);
    expect(request.service_tier).toBe('priority');
    expect(response.completion).toBe('chat-ok');
    expect(response.usage?.completion_tokens).toBe(6);
    expect(response.usage?.prompt_cached_tokens).toBe(2);
    expect(azureCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'test-key',
      endpoint: 'https://example.openai.azure.com',
      baseURL: 'https://example.openai.azure.com/openai/',
      apiVersion: '2024-12-01-preview',
      timeout: 33333,
      maxRetries: 7,
      defaultHeaders: { 'x-azure-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetch: customFetch,
      fetchOptions: { cache: 'no-store' },
    });
    const ctorOptions = azureCtorMock.mock.calls[0]?.[0] as any;
    const azureTokenProvider = ctorOptions?.azureADTokenProvider;
    expect(typeof azureTokenProvider).toBe('function');
    await expect(azureTokenProvider()).resolves.toBe('aad-token');
  });

  it('auto-switches to responses api for codex models', async () => {
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: 'auto',
    });

    const response = await llm.ainvoke([new UserMessage('hello')]);
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(chatCreateMock).not.toHaveBeenCalled();
    expect(request.model).toBe('gpt-5.1-codex');
    expect(request.input).toBeDefined();
    expect(request.reasoning).toEqual({ effort: 'low' });
    expect(response.completion).toBe('resp-ok');
    expect(response.usage?.prompt_cached_tokens).toBe(3);
  });

  it('optimizes structured schema when using responses api', async () => {
    responsesCreateMock.mockResolvedValue(
      buildResponsesResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.text?.format?.schema;

    expect(request.text?.format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('min_items');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('removes unsupported propertyNames from chat-completions schemas', async () => {
    chatCreateMock.mockResolvedValue(
      buildChatResponse(JSON.stringify({ payload: { key: 'value' } }))
    );
    const schema = z.object({
      payload: z.record(z.string(), z.unknown()),
    });
    const llm = new ChatAzure({
      model: 'gpt-4o',
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = chatCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.response_format?.json_schema?.schema;

    expect(request.response_format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('propertyNames');
    expect(
      schemaPayload?.properties?.payload?.additionalProperties
    ).toBeDefined();
    expect(schemaPayload?.properties?.payload?.additionalProperties).not.toBe(
      false
    );
    expect((response.completion as any).payload).toEqual({ key: 'value' });
  });

  it('can force chat completions mode for codex models', async () => {
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: false,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it('injects schema into system input for responses api when configured', async () => {
    responsesCreateMock.mockResolvedValue(
      buildResponsesResponse(JSON.stringify({ value: 'ok' }))
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: true,
      addSchemaToSystemPrompt: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('sys'), new UserMessage('extract')],
      schema as any
    );
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};

    expect((request.input?.[0]?.content as string) ?? '').toContain(
      '<json_schema>'
    );
    expect(request.text?.format?.type).toBe('json_schema');
    expect((response.completion as any).value).toBe('ok');
  });

  it('serializes multimodal user content for responses api input', async () => {
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: true,
    });

    await llm.ainvoke([
      new UserMessage([
        new ContentPartTextParam('hello'),
        new ContentPartImageParam(
          new ImageURL('https://example.com/image.png', 'low')
        ),
      ]),
    ]);

    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    expect(Array.isArray(request.input?.[0]?.content)).toBe(true);
    expect(request.input?.[0]?.content?.[0]).toEqual({
      type: 'input_text',
      text: 'hello',
    });
    expect(request.input?.[0]?.content?.[1]).toMatchObject({
      type: 'input_image',
      image_url: 'https://example.com/image.png',
      detail: 'low',
    });
  });

  it.each([
    [
      'chat completions',
      false,
      () =>
        chatCreateMock.mockResolvedValue({
          ...buildChatResponse('partial'),
          choices: [{ message: { content: null }, finish_reason: 'length' }],
        }),
    ],
    [
      'responses api',
      true,
      () =>
        responsesCreateMock.mockResolvedValue({
          ...buildResponsesResponse('partial'),
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
    ],
  ])('reports truncation from %s', async (_label, useResponsesApi, arrange) => {
    arrange();
    const llm = new ChatAzure({
      model: useResponsesApi ? 'gpt-5.1-codex' : 'gpt-4o',
      useResponsesApi,
      maxCompletionTokens: 128,
    });

    await expect(
      llm.ainvoke([new UserMessage('produce a long answer')])
    ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
  });
});
