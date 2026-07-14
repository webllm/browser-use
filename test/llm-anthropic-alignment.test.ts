import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const anthropicMock = vi.hoisted(() => {
  class APIError extends Error {
    status?: number;

    constructor(message = 'API error', status = 500) {
      super(message);
      this.status = status;
    }
  }

  class APIConnectionError extends Error {}

  class RateLimitError extends APIError {
    constructor(message = 'Rate limit exceeded') {
      super(message, 429);
    }
  }

  return {
    anthropicCtorMock: vi.fn(),
    anthropicCreateMock: vi.fn(),
    anthropicBetaCreateMock: vi.fn(),
    APIError,
    APIConnectionError,
    RateLimitError,
  };
});

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: anthropicMock.anthropicCreateMock,
    };

    beta = {
      messages: {
        create: anthropicMock.anthropicBetaCreateMock,
      },
    };

    constructor(options?: unknown) {
      anthropicMock.anthropicCtorMock(options);
    }
  }

  return {
    default: Anthropic,
    APIError: anthropicMock.APIError,
    APIConnectionError: anthropicMock.APIConnectionError,
    RateLimitError: anthropicMock.RateLimitError,
  };
});

import { ChatAnthropic } from '../src/llm/anthropic/chat.js';
import {
  ModelOutputTruncatedError,
  ModelProviderError,
  ModelRateLimitError,
} from '../src/llm/exceptions.js';
import { SystemMessage, UserMessage } from '../src/llm/messages.js';

const buildResponse = (content: any[], stopReason = 'end_turn') => ({
  content,
  stop_reason: stopReason,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  },
});

describe('ChatAnthropic alignment', () => {
  beforeEach(() => {
    anthropicMock.anthropicCtorMock.mockReset();
    anthropicMock.anthropicCreateMock.mockReset();
    anthropicMock.anthropicBetaCreateMock.mockReset();
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([{ type: 'text', text: 'plain response' }])
    );
    anthropicMock.anthropicBetaCreateMock.mockResolvedValue(
      buildResponse([{ type: 'text', text: 'beta response' }])
    );
  });

  it.each([Number.POSITIVE_INFINITY, -1, 1.5, 101])(
    'rejects unsafe maxRetries value %s',
    (maxRetries) => {
      expect(() => new ChatAnthropic({ maxRetries })).toThrow(
        'maxRetries must be an integer between 0 and 100.'
      );
    }
  );

  it('passes python-aligned client options and invoke params', async () => {
    const fetchMock = vi.fn(
      async () => new Response()
    ) as unknown as typeof fetch;

    const llm = new ChatAnthropic({
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
      authToken: 'auth-token',
      baseURL: 'https://example.anthropic.local',
      timeout: 1234,
      maxTokens: 2048,
      temperature: 0.3,
      topP: 0.8,
      seed: 7,
      maxRetries: 6,
      defaultHeaders: { 'x-trace-id': 'trace-1' },
      defaultQuery: { purpose: 'alignment' },
      fetchImplementation: fetchMock,
      fetchOptions: { cache: 'no-store' },
    });

    await llm.ainvoke([new SystemMessage('sys'), new UserMessage('hello')]);

    expect(anthropicMock.anthropicCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'test-key',
      authToken: 'auth-token',
      baseURL: 'https://example.anthropic.local',
      timeout: 1234,
      maxRetries: 6,
      defaultHeaders: { 'x-trace-id': 'trace-1' },
      defaultQuery: { purpose: 'alignment' },
      fetch: fetchMock,
      fetchOptions: { cache: 'no-store' },
    });

    const request = anthropicMock.anthropicCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('claude-sonnet-4-20250514');
    expect(request.max_tokens).toBe(2048);
    expect(request.system).toBe('sys');
    expect(request.temperature).toBe(0.3);
    expect(request.top_p).toBe(0.8);
    expect(request.seed).toBe(7);
  });

  it('uses tool-calling structured output with schema optimization', async () => {
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'response',
          input: { items: ['alpha'] },
        },
      ])
    );

    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatAnthropic({
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const result = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = anthropicMock.anthropicCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'response' });
    expect(request.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain(
      'title'
    );
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain(
      'minItems'
    );
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain(
      'min_items'
    );
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain(
      '"default"'
    );
    expect((result.completion as any).items).toEqual(['alpha']);
    expect(result.usage?.prompt_cached_tokens).toBe(2);
    expect(result.usage?.prompt_cache_creation_tokens).toBe(1);
  });

  it('fails structured output when tool response is missing', async () => {
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([{ type: 'text', text: '{"value":"ok"}' }])
    );

    const schema = z.object({ value: z.string() });
    const llm = new ChatAnthropic();

    await expect(
      llm.ainvoke([new UserMessage('extract')], schema as any)
    ).rejects.toMatchObject({
      name: 'ModelProviderError',
      message: 'Expected tool use in response but none found',
    });
  });

  it('maps provider errors to model errors', async () => {
    anthropicMock.anthropicCreateMock.mockRejectedValueOnce(
      new anthropicMock.RateLimitError('too many requests')
    );
    const llm = new ChatAnthropic();
    await expect(
      llm.ainvoke([new UserMessage('hello')])
    ).rejects.toBeInstanceOf(ModelRateLimitError);

    anthropicMock.anthropicCreateMock.mockRejectedValueOnce(
      new anthropicMock.APIConnectionError('network down')
    );
    await expect(llm.ainvoke([new UserMessage('hello')])).rejects.toMatchObject(
      {
        name: 'ModelProviderError',
        statusCode: 502,
      }
    );

    anthropicMock.anthropicCreateMock.mockRejectedValueOnce(
      new anthropicMock.APIError('server bad', 503)
    );
    await expect(llm.ainvoke([new UserMessage('hello')])).rejects.toMatchObject(
      {
        name: 'ModelProviderError',
        statusCode: 503,
      }
    );

    anthropicMock.anthropicCreateMock.mockRejectedValueOnce(
      new Error('unknown')
    );
    await expect(
      llm.ainvoke([new UserMessage('hello')])
    ).rejects.toBeInstanceOf(ModelProviderError);
  });

  it('reports max_tokens before checking structured tool output', async () => {
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([{ type: 'text', text: '{"value":"partial' }], 'max_tokens')
    );

    const llm = new ChatAnthropic({ maxTokens: 128 });
    await expect(
      llm.ainvoke(
        [new UserMessage('extract')],
        z.object({ value: z.string() }) as any
      )
    ).rejects.toMatchObject({
      name: 'ModelOutputTruncatedError',
      statusCode: 400,
      model: 'claude-sonnet-4-20250514',
      message: expect.stringContaining('max_tokens=128'),
    } satisfies Partial<ModelOutputTruncatedError>);
  });

  it('uses beta messages and server-side fallback options when configured', async () => {
    const llm = new ChatAnthropic({
      model: 'claude-fable-5',
      outputConfig: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'summarized' },
      betas: ['context-1m-2025-08-07'],
      fallbacks: [{ model: 'claude-sonnet-4-6' }],
      inferenceGeo: 'us',
    });

    const result = await llm.ainvoke([new UserMessage('hello')]);

    expect(result.completion).toBe('beta response');
    expect(anthropicMock.anthropicCreateMock).not.toHaveBeenCalled();
    const request =
      anthropicMock.anthropicBetaCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request).toMatchObject({
      model: 'claude-fable-5',
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'summarized' },
      fallbacks: [{ model: 'claude-sonnet-4-6' }],
      inference_geo: 'us',
    });
    expect(request.betas).toEqual([
      'context-1m-2025-08-07',
      'server-side-fallback-2026-06-01',
    ]);
  });

  it.each([
    { type: 'enabled', budget_tokens: 2048 },
    { type: 'disabled' },
    { type: 'adaptive', budget_tokens: 2048 },
  ])('rejects non-adaptive Fable thinking config %j', async (thinking) => {
    const llm = new ChatAnthropic({
      model: 'claude-fable-5',
      thinking,
    });

    await expect(llm.ainvoke([new UserMessage('hello')])).rejects.toMatchObject(
      {
        name: 'ModelProviderError',
        statusCode: 400,
        model: 'claude-fable-5',
        message: expect.stringMatching(/only supports adaptive thinking/),
      }
    );
    expect(anthropicMock.anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('uses auto tool choice and parses structured text with thinking metadata', async () => {
    anthropicMock.anthropicCreateMock.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'considered the schema' },
        { type: 'redacted_thinking', data: 'encrypted-thought' },
        { type: 'text', text: '```json\n{"value":"ok"}\n```' },
      ],
      stop_reason: 'end_turn',
      stop_details: {
        type: 'refusal',
        category: 'none',
        explanation: 'completed normally',
      },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 7,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 4,
        },
      },
    });
    const llm = new ChatAnthropic({
      model: 'claude-fable-5',
      thinking: { type: 'adaptive' },
      inferenceGeo: 'us',
    });

    const result = await llm.ainvoke(
      [new UserMessage('extract')],
      z.object({ value: z.string() }) as any
    );

    const request = anthropicMock.anthropicCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.tool_choice).toEqual({ type: 'auto' });
    expect(request.inference_geo).toBe('us');
    expect((result.completion as any).value).toBe('ok');
    expect(result.thinking).toBe('considered the schema');
    expect(result.redacted_thinking).toBe('encrypted-thought');
    expect(result.stop_details).toEqual({
      type: 'refusal',
      category: 'none',
      explanation: 'completed normally',
    });
    expect(result.usage).toMatchObject({
      prompt_cache_creation_5m_tokens: 3,
      prompt_cache_creation_1h_tokens: 4,
      pricing_multiplier: 1.1,
    });
  });

  it('keeps forced tool choice when thinking is disabled', async () => {
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'response',
          input: { value: 'ok' },
        },
      ])
    );
    const llm = new ChatAnthropic({
      thinking: { type: 'disabled' },
    });

    await llm.ainvoke(
      [new UserMessage('extract')],
      z.object({ value: z.string() }) as any
    );

    const request = anthropicMock.anthropicCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'response' });
  });

  it('repairs double-serialized tool fields containing control characters', async () => {
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'response',
          input: { metadata: '{"note":"line 1\nline 2"}' },
        },
      ])
    );
    const llm = new ChatAnthropic();

    const result = await llm.ainvoke(
      [new UserMessage('extract')],
      z.object({ metadata: z.object({ note: z.string() }) }) as any
    );

    expect((result.completion as any).metadata.note).toBe('line 1\nline 2');
  });
});
