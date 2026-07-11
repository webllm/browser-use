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
    anthropicMock.anthropicCreateMock.mockResolvedValue(
      buildResponse([{ type: 'text', text: 'plain response' }])
    );
  });

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
});
