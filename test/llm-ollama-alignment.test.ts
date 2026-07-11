import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ollamaCtorMock = vi.fn();
const ollamaChatMock = vi.fn();

vi.mock('ollama', () => {
  class Ollama {
    chat = ollamaChatMock;

    constructor(options?: unknown) {
      ollamaCtorMock(options);
    }
  }

  return { Ollama };
});

import { ChatOllama } from '../src/llm/ollama/chat.js';
import { ModelOutputTruncatedError } from '../src/llm/exceptions.js';
import { OllamaMessageSerializer } from '../src/llm/ollama/serializer.js';
import {
  AssistantMessage,
  ContentPartRefusalParam,
  ContentPartTextParam,
  FunctionCall,
  ToolCall,
  UserMessage,
} from '../src/llm/messages.js';

const buildResponse = (content: string) => ({
  message: { content },
  prompt_eval_count: 11,
  eval_count: 4,
});

describe('ChatOllama alignment', () => {
  beforeEach(() => {
    ollamaCtorMock.mockReset();
    ollamaChatMock.mockReset();
    ollamaChatMock.mockResolvedValue(buildResponse('plain'));
  });

  it('passes host/client options and ollama options', async () => {
    const llm = new ChatOllama({
      model: 'qwen2.5:latest',
      host: 'http://localhost:11434',
      clientParams: {
        headers: { Authorization: 'Bearer test' },
      },
      ollamaOptions: {
        temperature: 0.1,
      },
    });

    await llm.ainvoke([new UserMessage('hello')]);

    expect(ollamaCtorMock.mock.calls[0]?.[0]).toMatchObject({
      host: 'http://localhost:11434',
      headers: { Authorization: 'Bearer test' },
    });

    const request = ollamaChatMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('qwen2.5:latest');
    expect(request.options).toMatchObject({ temperature: 0.1 });
  });

  it('uses schema object format and parses structured output', async () => {
    ollamaChatMock.mockResolvedValue(buildResponse('{"value":"ok"}'));

    const schema = z.object({ value: z.string() });
    const llm = new ChatOllama('qwen2.5:latest');

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = ollamaChatMock.mock.calls[0]?.[0] ?? {};

    expect(typeof request.format).toBe('object');
    expect((response.completion as any).value).toBe('ok');
    expect(response.usage?.total_tokens).toBe(15);
  });

  it('reports length done reasons as output truncation', async () => {
    ollamaChatMock.mockResolvedValue({
      ...buildResponse('partial'),
      done_reason: 'length',
    });

    const llm = new ChatOllama('qwen2.5:latest');
    await expect(
      llm.ainvoke([new UserMessage('produce a long answer')])
    ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
  });

  it('serializes refusal text and invalid tool-call arguments safely', () => {
    const serializer = new OllamaMessageSerializer();

    const assistant = new AssistantMessage({
      content: [
        new ContentPartTextParam('Primary answer'),
        new ContentPartRefusalParam('Cannot reveal details'),
      ],
      tool_calls: [
        new ToolCall('tool_1', new FunctionCall('fetch', 'not-json')),
      ],
    });

    const serialized = serializer.serialize([assistant])[0] as any;

    expect(serialized.content).toContain('Primary answer');
    expect(serialized.content).toContain('[Refusal] Cannot reveal details');
    expect(serialized.tool_calls[0].function.arguments).toEqual({
      arguments: 'not-json',
    });
  });
});
