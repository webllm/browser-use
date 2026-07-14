import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const openaiCreateMock = vi.fn();
const openaiCtorMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: openaiCreateMock,
      },
    };

    constructor(options?: unknown) {
      openaiCtorMock(options);
    }
  }
  return { default: OpenAI };
});

import { UserMessage } from '../src/llm/messages.js';
import { ChatDeepSeek } from '../src/llm/deepseek/chat.js';
import { ChatLiteLLM } from '../src/llm/litellm/chat.js';
import { ChatOpenAI } from '../src/llm/openai/chat.js';
import { ChatOpenAILike } from '../src/llm/openai/like.js';
import { ChatOpenRouter } from '../src/llm/openrouter/chat.js';
import { ChatMistral } from '../src/llm/mistral/chat.js';
import { ChatCerebras } from '../src/llm/cerebras/chat.js';
import { ChatVercel } from '../src/llm/vercel/chat.js';
import { ModelOutputTruncatedError } from '../src/llm/exceptions.js';

const buildResponse = (content: string | null, finishReason?: string) => ({
  choices: [{ message: { content }, finish_reason: finishReason }],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  },
});

const buildToolResponse = (argumentsJson: string) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{ function: { arguments: argumentsJson } }],
      },
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  },
});

describe('OpenAI-compatible providers alignment', () => {
  beforeEach(() => {
    openaiCreateMock.mockReset();
    openaiCtorMock.mockReset();
    openaiCreateMock.mockResolvedValue(buildResponse('ok'));
  });

  it('rejects retry counts that can make SDK retries unbounded', () => {
    const factories = [
      (maxRetries: number) => new ChatOpenAI({ maxRetries }),
      (maxRetries: number) =>
        new ChatOpenAILike({ model: 'test-model', maxRetries }),
      (maxRetries: number) => new ChatLiteLLM({ maxRetries }),
      (maxRetries: number) => new ChatDeepSeek({ maxRetries }),
      (maxRetries: number) => new ChatOpenRouter({ maxRetries }),
      (maxRetries: number) => new ChatMistral({ maxRetries }),
      (maxRetries: number) => new ChatCerebras({ maxRetries }),
      (maxRetries: number) => new ChatVercel({ maxRetries }),
    ];

    for (const factory of factories) {
      for (const maxRetries of [Number.POSITIVE_INFINITY, -1, 1.5, 101]) {
        expect(() => factory(maxRetries)).toThrow(
          'maxRetries must be an integer between 0 and 100.'
        );
      }
    }

    for (const factory of [
      (maxRetries: number) =>
        new ChatDeepSeek({ clientParams: { maxRetries } }),
      (maxRetries: number) => new ChatMistral({ clientParams: { maxRetries } }),
      (maxRetries: number) =>
        new ChatCerebras({ clientParams: { maxRetries } }),
    ]) {
      expect(() => factory(Number.POSITIVE_INFINITY)).toThrow(
        'maxRetries must be an integer between 0 and 100.'
      );
    }
  });

  it('allows ChatOpenAILike to pass through ChatOpenAI options', async () => {
    const llm = new ChatOpenAILike({
      model: 'gpt-4o-mini',
      serviceTier: 'priority',
      maxRetries: 7,
    });

    expect(llm).toBeInstanceOf(ChatOpenAI);
    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.service_tier).toBe('priority');
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      maxRetries: 7,
    });
  });

  it('configures LiteLLM as an OpenAI-compatible proxy client', async () => {
    const llm = new ChatLiteLLM({
      model: 'gpt-4.1-mini',
      apiKey: 'litellm-key',
      baseURL: 'https://litellm.example.com',
      maxRetries: 4,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('gpt-4.1-mini');
    expect(llm.provider).toBe('litellm');
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'litellm-key',
      baseURL: 'https://litellm.example.com',
      maxRetries: 4,
    });
  });

  it('supports OpenRouter options including HTTP-Referer, extra body, and client params', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const llm = new ChatOpenRouter({
      model: 'openai/gpt-4o',
      temperature: 0.4,
      topP: 0.8,
      seed: 42,
      timeout: 40000,
      maxRetries: 9,
      defaultHeaders: { 'x-openrouter-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetchImplementation: customFetch,
      fetchOptions: { cache: 'no-store' },
      httpReferer: 'https://example.com/app',
      extraBody: {
        provider: { order: ['openai'] },
      },
    });

    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('openai/gpt-4o');
    expect(request.temperature).toBe(0.4);
    expect(request.top_p).toBe(0.8);
    expect(request.seed).toBe(42);
    expect(request.extra_headers).toEqual({
      'HTTP-Referer': 'https://example.com/app',
    });
    expect(request.provider).toEqual({ order: ['openai'] });
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 40000,
      maxRetries: 9,
      defaultHeaders: { 'x-openrouter-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetch: customFetch,
      fetchOptions: { cache: 'no-store' },
    });
  });

  it('supports Vercel providerOptions passthrough with OpenAI-compatible payload', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const llm = new ChatVercel({
      model: 'openai/gpt-5-mini',
      timeout: 25000,
      temperature: 0.3,
      topP: 0.7,
      seed: 11,
      defaultHeaders: { 'x-vercel-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetchImplementation: customFetch,
      fetchOptions: { cache: 'no-store' },
      providerOptions: {
        gateway: {
          order: ['openai', 'anthropic'],
        },
      },
    });

    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('openai/gpt-5-mini');
    expect(request.temperature).toBe(0.3);
    expect(request.top_p).toBe(0.7);
    expect(request.seed).toBe(11);
    expect(request.extra_body).toEqual({
      providerOptions: {
        gateway: {
          order: ['openai', 'anthropic'],
        },
      },
    });
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      baseURL: 'https://ai-gateway.vercel.sh/v1',
      timeout: 25000,
      defaultHeaders: { 'x-vercel-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetch: customFetch,
      fetchOptions: { cache: 'no-store' },
    });
  });

  it('uses prompt-based JSON fallback for Vercel reasoning/google/anthropic style models', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse('```json\n{"value":"ok"}\n```')
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatVercel({
      model: 'openai/gpt-oss-120b',
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    const lastMessage = request.messages?.[request.messages.length - 1];
    const contentText =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content ?? '');

    expect(request.response_format).toBeUndefined();
    expect(contentText).toContain(
      'IMPORTANT: You must respond with ONLY a valid JSON object'
    );
    expect((response.completion as any).value).toBe('ok');
  });

  it('optimizes OpenRouter structured schemas for provider compatibility', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatOpenRouter({
      model: 'openai/gpt-4o',
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.response_format?.json_schema?.schema;

    expect(request.response_format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('min_items');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('uses DeepSeek function-calling structured output path and generation params', async () => {
    openaiCreateMock.mockResolvedValue(buildToolResponse('{"value":"ok"}'));
    const schema = z.object({ value: z.string() });
    const llm = new ChatDeepSeek({
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 256,
      topP: 0.7,
      seed: 9,
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.model).toBe('deepseek-chat');
    expect(request.temperature).toBe(0.2);
    expect(request.max_tokens).toBe(256);
    expect(request.top_p).toBe(0.7);
    expect(request.seed).toBe(9);
    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toEqual({
      type: 'function',
      function: { name: 'response' },
    });
    expect(request.response_format).toBeUndefined();
    expect((response.completion as any).value).toBe('ok');
  });

  it('uses Mistral max_tokens and strict json_schema response format', async () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    openaiCreateMock.mockResolvedValue(buildResponse('{"value":"ok"}'));
    const schema = z.object({ value: z.string() });
    const llm = new ChatMistral({
      model: 'mistral-medium-latest',
      timeout: 18000,
      maxTokens: 512,
      topP: 0.9,
      seed: 7,
      defaultHeaders: { 'x-mistral-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetchImplementation: customFetch,
      fetchOptions: { cache: 'no-store' },
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.model).toBe('mistral-medium-latest');
    expect(request.max_tokens).toBe(512);
    expect(request.top_p).toBe(0.9);
    expect(request.seed).toBe(7);
    expect(request.max_completion_tokens).toBeUndefined();
    expect(request.response_format?.type).toBe('json_schema');
    expect(request.response_format?.json_schema?.strict).toBe(true);
    expect((response.completion as any).value).toBe('ok');
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      baseURL: 'https://api.mistral.ai/v1',
      timeout: 18000,
      defaultHeaders: { 'x-mistral-test': '1' },
      defaultQuery: { purpose: 'alignment' },
      fetch: customFetch,
      fetchOptions: { cache: 'no-store' },
    });
  });

  it('uses Cerebras prompt-based JSON extraction for structured output', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse('```json\n{"value":"ok"}\n```')
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatCerebras({
      model: 'llama3.1-8b',
      maxTokens: 256,
      temperature: 0.2,
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract this')],
      schema as any
    );
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    const lastMessage = request.messages?.[request.messages.length - 1];
    const contentText =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content ?? '');

    expect(request.model).toBe('llama3.1-8b');
    expect(request.max_tokens).toBe(256);
    expect(contentText).toContain('valid JSON only');
    expect((response.completion as any).value).toBe('ok');
  });

  it.each([
    ['OpenAI', () => new ChatOpenAI({ model: 'gpt-4o' })],
    ['OpenRouter', () => new ChatOpenRouter({ model: 'openai/gpt-4o' })],
    ['DeepSeek', () => new ChatDeepSeek({ model: 'deepseek-chat' })],
    ['Mistral', () => new ChatMistral({ model: 'mistral-medium-latest' })],
    ['Cerebras', () => new ChatCerebras({ model: 'llama3.1-8b' })],
    ['Vercel', () => new ChatVercel({ model: 'openai/gpt-4o' })],
  ])(
    'reports %s length finishes as structured output truncation before parsing',
    async (_provider, createLlm) => {
      openaiCreateMock.mockResolvedValue(buildResponse(null, 'length'));

      await expect(
        createLlm().ainvoke(
          [new UserMessage('produce a long answer')],
          z.object({ value: z.string() }) as any
        )
      ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
    }
  );

  it.each([
    ['OpenAI', () => new ChatOpenAI({ model: 'gpt-4o' })],
    ['OpenRouter', () => new ChatOpenRouter({ model: 'openai/gpt-4o' })],
    ['DeepSeek', () => new ChatDeepSeek({ model: 'deepseek-chat' })],
    ['Mistral', () => new ChatMistral({ model: 'mistral-medium-latest' })],
    ['Cerebras', () => new ChatCerebras({ model: 'llama3.1-8b' })],
    ['Vercel', () => new ChatVercel({ model: 'openai/gpt-4o' })],
  ])('preserves %s partial text completions', async (_provider, createLlm) => {
    openaiCreateMock.mockResolvedValue(buildResponse('partial', 'length'));

    const response = await createLlm().ainvoke([
      new UserMessage('produce a long answer'),
    ]);

    expect(response.completion).toBe('partial');
    expect(response.stop_reason).toBe('length');
  });
});
