import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const deepseekCtorMock = vi.fn();
const deepseekCreateMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: deepseekCreateMock,
      },
    };

    constructor(options?: unknown) {
      deepseekCtorMock(options);
    }
  }

  return { default: OpenAI };
});

import { ChatDeepSeek } from '../src/llm/deepseek/chat.js';
import { ModelRateLimitError } from '../src/llm/exceptions.js';
import { UserMessage } from '../src/llm/messages.js';

const buildTextResponse = (content: string) => ({
  choices: [
    {
      finish_reason: 'stop',
      message: { content },
    },
  ],
  usage: {
    prompt_tokens: 9,
    completion_tokens: 3,
    total_tokens: 12,
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
    prompt_tokens: 11,
    completion_tokens: 4,
    total_tokens: 15,
  },
});

describe('ChatDeepSeek alignment', () => {
  beforeEach(() => {
    deepseekCtorMock.mockReset();
    deepseekCreateMock.mockReset();
    deepseekCreateMock.mockResolvedValue(buildTextResponse('{"value":"ok"}'));
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-deepseek-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes timeout and client params into OpenAI client', async () => {
    const llm = new ChatDeepSeek({
      model: 'deepseek-chat',
      apiKey: 'test-key',
      timeout: 5000,
      clientParams: {
        defaultHeaders: {
          'x-trace-id': 'trace-1',
        },
      },
      maxRetries: 6,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    expect(deepseekCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'test-key',
      timeout: 5000,
      maxRetries: 6,
      defaultHeaders: {
        'x-trace-id': 'trace-1',
      },
    });
  });

  it('uses function-calling structured path for zod output format', async () => {
    deepseekCreateMock.mockResolvedValue(buildToolResponse('{"value":"ok"}'));

    const schema = z.object({ value: z.string() });
    const llm = new ChatDeepSeek({ model: 'deepseek-chat' });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = deepseekCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toEqual({
      type: 'function',
      function: { name: 'response' },
    });
    expect(request.response_format).toBeUndefined();
    expect((response.completion as any).value).toBe('ok');
    expect(response.stop_reason).toBe('tool_calls');
  });

  it('keeps json_object fallback for non-zod output parser', async () => {
    deepseekCreateMock.mockResolvedValue(buildTextResponse('{"value":"ok"}'));

    const llm = new ChatDeepSeek({ model: 'deepseek-chat' });
    const response = await llm.ainvoke([new UserMessage('extract')], {
      parse: (input: string) => input,
    });

    const request = deepseekCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(response.completion).toEqual({ value: 'ok' });
  });

  it('maps rate-limit errors to ModelRateLimitError', async () => {
    deepseekCreateMock.mockRejectedValueOnce({
      status: 429,
      message: 'too many requests',
    });

    const llm = new ChatDeepSeek({ model: 'deepseek-chat' });

    await expect(llm.ainvoke([new UserMessage('hi')])).rejects.toBeInstanceOf(
      ModelRateLimitError
    );
  });
});
