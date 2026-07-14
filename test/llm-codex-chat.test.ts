import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const responsesCreateMock = vi.fn();
const openaiCtorMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    responses = {
      create: responsesCreateMock,
    };

    constructor(options?: unknown) {
      openaiCtorMock(options);
    }
  }
  return { default: OpenAI };
});

import { ChatCodex } from '../src/llm/codex/chat.js';
import { saveCodexTokens } from '../src/llm/codex/auth.js';
import { SystemMessage, UserMessage } from '../src/llm/messages.js';
import {
  ModelOutputTruncatedError,
  ModelProviderError,
  ModelRateLimitError,
} from '../src/llm/exceptions.js';

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-codex-'));
  tempDirs.push(dir);
  return dir;
};

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const makeJwt = (
  claims: Record<string, unknown> = {
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

const buildResponse = (text: string) => ({
  output_text: text,
  status: 'completed',
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 3 },
  },
});

const jsonResponse = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('ChatCodex', () => {
  beforeEach(() => {
    responsesCreateMock.mockReset();
    openaiCtorMock.mockReset();
    responsesCreateMock.mockResolvedValue(buildResponse('ok'));
  });

  it.each([Number.POSITIVE_INFINITY, -1, 1.5, 101])(
    'rejects unsafe maxRetries value %s',
    (maxRetries) => {
      expect(() => new ChatCodex({ apiKey: 'token', maxRetries })).toThrow(
        'maxRetries must be an integer between 0 and 100.'
      );
    }
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it('uses Responses API with Codex defaults and Cloudflare headers', async () => {
    const token = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-123',
      },
    });
    const llm = new ChatCodex({
      model: 'gpt-5.5',
      apiKey: token,
      reasoningEffort: 'medium',
      maxCompletionTokens: 2048,
      defaultHeaders: { 'x-extra': '1' },
    });

    const result = await llm.ainvoke([new UserMessage('hello')]);

    expect(result.completion).toBe('ok');
    expect(result.usage).toMatchObject({
      prompt_tokens: 10,
      prompt_cached_tokens: 3,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: token,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: {
        originator: 'codex_cli_rs',
        'ChatGPT-Account-ID': 'acct-123',
        'x-extra': '1',
      },
    });
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request).toMatchObject({
      model: 'gpt-5.5',
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      instructions: 'You are a helpful assistant.',
      input: [{ role: 'user', content: 'hello' }],
    });
    expect(request).not.toHaveProperty('max_output_tokens');
    expect(request).not.toHaveProperty('top_p');
    expect(request).not.toHaveProperty('seed');
  });

  it('collects Codex backend stream events', async () => {
    async function* streamResponse() {
      yield { type: 'response.output_text.delta', delta: 'streamed ' };
      yield { type: 'response.output_text.delta', delta: 'ok' };
      yield {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
          },
        },
      };
    }
    responsesCreateMock.mockResolvedValue(streamResponse());
    const llm = new ChatCodex({ apiKey: 'opaque-token' });

    const result = await llm.ainvoke([new UserMessage('hello')]);

    expect(result.completion).toBe('streamed ok');
    expect(result.stop_reason).toBe('completed');
    expect(result.usage).toMatchObject({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });
  });

  it('moves system messages into Codex backend instructions', async () => {
    const llm = new ChatCodex({ apiKey: 'opaque-token' });

    await llm.ainvoke([
      new SystemMessage('primary system'),
      new UserMessage('hello'),
      new SystemMessage('secondary system'),
    ]);

    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.instructions).toBe('primary system\n\nsecondary system');
    expect(request.input).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('keeps optional model parameters for custom Responses-compatible endpoints', async () => {
    const llm = new ChatCodex({
      apiKey: 'opaque-token',
      baseURL: 'https://responses.example.test/v1',
      maxCompletionTokens: 2048,
      topP: 0.7,
      seed: 42,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.max_output_tokens).toBe(2048);
    expect(request.top_p).toBe(0.7);
    expect(request.seed).toBe(42);
    expect(request.reasoning).toEqual({ effort: 'low' });
    expect(request).not.toHaveProperty('instructions');
    expect(request).not.toHaveProperty('include');
  });

  it('uses Responses JSON schema format for zod structured output', async () => {
    responsesCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatCodex({
      apiKey: 'opaque-token',
      addSchemaToSystemPrompt: true,
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('system'), new UserMessage('user')],
      schema as any
    );

    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.text?.format?.type).toBe('json_schema');
    expect(JSON.stringify(request.text?.format?.schema)).not.toContain(
      'minItems'
    );
    expect(JSON.stringify(request.text?.format?.schema)).not.toContain(
      '"default"'
    );
    expect(request.instructions).toContain('system');
    expect(request.instructions).toContain('<json_schema>');
    expect(request.input).toEqual([{ role: 'user', content: 'user' }]);
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('resolves browser-use Codex auth and retries once after 401 refresh', async () => {
    const configDir = await makeTempDir();
    const oldToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await saveCodexTokens(
      { access_token: oldToken, refresh_token: 'old-refresh' },
      { configDir }
    );
    responsesCreateMock
      .mockRejectedValueOnce({ status: 401, message: 'expired' })
      .mockResolvedValueOnce(buildResponse('after-refresh'));
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      })
    );
    const llm = new ChatCodex({
      configDir,
      fetchImplementation: fetchMock as typeof fetch,
    });

    const result = await llm.ainvoke([new UserMessage('hello')]);

    expect(result.completion).toBe('after-refresh');
    expect(responsesCreateMock).toHaveBeenCalledTimes(2);
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: oldToken,
    });
    expect(openaiCtorMock.mock.calls[1]?.[0]).toMatchObject({
      apiKey: 'new-access',
    });
  });

  it('raises ModelRateLimitError for 429 responses', async () => {
    responsesCreateMock.mockRejectedValueOnce({
      status: 429,
      message: 'rate limited',
    });
    const llm = new ChatCodex({ apiKey: 'token' });

    await expect(
      llm.ainvoke([new UserMessage('hello')])
    ).rejects.toBeInstanceOf(ModelRateLimitError);
  });

  it('does not refresh Codex auth after 403 responses', async () => {
    const configDir = await makeTempDir();
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await saveCodexTokens(
      { access_token: token, refresh_token: 'refresh' },
      { configDir }
    );
    responsesCreateMock.mockRejectedValueOnce({
      status: 403,
      message: 'cloudflare challenge',
    });
    const fetchMock = vi.fn();
    const llm = new ChatCodex({
      configDir,
      fetchImplementation: fetchMock as typeof fetch,
    });

    await expect(
      llm.ainvoke([new UserMessage('hello')])
    ).rejects.toBeInstanceOf(ModelProviderError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('extracts output text from response output content fallback', async () => {
    responsesCreateMock.mockResolvedValue({
      output: [
        {
          content: [{ type: 'output_text', text: 'fallback text' }],
        },
      ],
    });
    const llm = new ChatCodex({ apiKey: 'token' });

    const response = await llm.ainvoke([new UserMessage('hello')]);

    expect(response.completion).toBe('fallback text');
  });

  it('reports max_output_tokens incomplete structured responses as truncation', async () => {
    responsesCreateMock.mockResolvedValue({
      ...buildResponse('partial'),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    const llm = new ChatCodex({
      apiKey: 'opaque-token',
      maxCompletionTokens: 128,
    });

    await expect(
      llm.ainvoke(
        [new UserMessage('produce a long answer')],
        z.object({ value: z.string() }) as any
      )
    ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
  });
});
