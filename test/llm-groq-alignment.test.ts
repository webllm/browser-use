import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const groqCreateMock = vi.fn();
const groqCtorMock = vi.fn();

vi.mock('groq-sdk', () => {
  class Groq {
    chat = {
      completions: {
        create: groqCreateMock,
      },
    };

    constructor(options?: unknown) {
      groqCtorMock(options);
    }
  }

  return { default: Groq };
});

import { UserMessage } from '../src/llm/messages.js';
import { ChatGroq } from '../src/llm/groq/chat.js';
import { ModelOutputTruncatedError } from '../src/llm/exceptions.js';

const buildResponse = (content: string) => ({
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 9,
    completion_tokens: 3,
    total_tokens: 12,
  },
});

describe('ChatGroq alignment', () => {
  beforeEach(() => {
    groqCreateMock.mockReset();
    groqCtorMock.mockReset();
    groqCreateMock.mockResolvedValue(buildResponse('ok'));
  });

  it.each([Number.POSITIVE_INFINITY, -1, 1.5, 101])(
    'rejects unsafe maxRetries value %s',
    (maxRetries) => {
      expect(() => new ChatGroq({ maxRetries })).toThrow(
        'maxRetries must be an integer between 0 and 100.'
      );
    }
  );

  it('passes generation and service-tier parameters', async () => {
    const llm = new ChatGroq({
      model: 'llama-3.1-70b-versatile',
      apiKey: 'test-key',
      temperature: 0.2,
      topP: 0.7,
      seed: 11,
      serviceTier: 'flex',
      maxRetries: 7,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    const request = groqCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.temperature).toBe(0.2);
    expect(request.top_p).toBe(0.7);
    expect(request.seed).toBe(11);
    expect(request.service_tier).toBe('flex');
    expect(groqCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'test-key',
      maxRetries: 7,
    });
  });

  it('uses json_schema mode for supported schema models', async () => {
    groqCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatGroq({
      model: 'openai/gpt-oss-20b',
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = groqCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.response_format?.json_schema?.schema;

    expect(request.response_format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('min_items');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('falls back to json_object mode for non-json-schema models', async () => {
    groqCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ value: 'ok' }))
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatGroq({
      model: 'llama-3.1-70b-versatile',
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = groqCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.response_format?.type).toBe('json_object');
    expect((response.completion as any).value).toBe('ok');
  });

  it('reports length finishes as structured output truncation', async () => {
    groqCreateMock.mockResolvedValue({
      ...buildResponse('partial'),
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
    });

    const llm = new ChatGroq();
    await expect(
      llm.ainvoke(
        [new UserMessage('produce a long answer')],
        z.object({ value: z.string() }) as any
      )
    ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
  });
});
