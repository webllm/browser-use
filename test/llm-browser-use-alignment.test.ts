import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChatBrowserUse } from '../src/llm/browser-use/chat.js';
import { ModelRateLimitError } from '../src/llm/exceptions.js';
import { UserMessage } from '../src/llm/messages.js';

const createFetchResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () =>
      typeof body === 'string' ? body : JSON.stringify(body)
    ),
  }) as unknown as Response;

describe('ChatBrowserUse alignment', () => {
  const originalApiKey = process.env.BROWSER_USE_API_KEY;

  beforeEach(() => {
    process.env.BROWSER_USE_API_KEY = 'test-browser-use-key';
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.BROWSER_USE_API_KEY;
    } else {
      process.env.BROWSER_USE_API_KEY = originalApiKey;
    }
  });

  it('normalizes bu-latest and forwards request_type payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(200, {
        completion: 'ok',
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })
    );
    const llm = new ChatBrowserUse({
      model: 'bu-latest',
      fetchImplementation: fetchMock as unknown as typeof fetch,
    });

    const result = await llm.ainvoke([new UserMessage('hello')], undefined, {
      request_type: 'judge',
      session_id: 'session-123',
    });

    expect(result.completion).toBe('ok');
    expect(result.usage?.total_tokens).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://llm.api.browser-use.com/v1/chat/completions'
    );

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.model).toBe('bu-2-0');
    expect(payload.request_type).toBe('judge');
    expect(payload.session_id).toBe('session-123');
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it.each([
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.5',
    'google/gemini-3-pro',
    'browser-use/bu-30b-a3b-preview',
  ])('accepts and forwards provider-prefixed model %s', async (model) => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(200, {
        completion: 'gateway response',
      })
    );
    const llm = new ChatBrowserUse({
      model,
      fetchImplementation: fetchMock as unknown as typeof fetch,
    });

    const result = await llm.ainvoke([new UserMessage('hello')]);

    expect(llm.model).toBe(model);
    expect(result.completion).toBe('gateway response');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).model).toBe(model);
  });

  it.each([
    'gpt-5',
    'claude-sonnet-4-6',
    'bu-9-9',
    '/gpt-5',
    'openai/',
    'openai/gpt 5',
  ])('rejects unsupported or malformed model %s', (model) => {
    expect(() => new ChatBrowserUse({ model })).toThrow(/Invalid model/);
  });

  it('sends structured output schema and parses structured completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse(200, {
        completion: { answer: '42' },
      })
    );
    const llm = new ChatBrowserUse({
      model: 'bu-2-0',
      fetchImplementation: fetchMock as unknown as typeof fetch,
    });
    const schema = z.object({ answer: z.string() });

    const result = await llm.ainvoke(
      [new UserMessage('Extract answer')],
      schema as any
    );

    expect((result.completion as any).answer).toBe('42');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.output_format).toBeTruthy();
  });

  it('retries retryable status codes and succeeds on later attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createFetchResponse(429, { detail: 'rate limited' })
      )
      .mockResolvedValueOnce(createFetchResponse(200, { completion: 'ok' }));
    const llm = new ChatBrowserUse({
      fetchImplementation: fetchMock as unknown as typeof fetch,
      retryBaseDelay: 0.001,
      retryMaxDelay: 0.001,
      maxRetries: 2,
    });

    const result = await llm.ainvoke([new UserMessage('hello')]);
    expect(result.completion).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('raises ModelRateLimitError after exhausting 429 retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(createFetchResponse(429, { detail: 'rate limited' }));
    const llm = new ChatBrowserUse({
      fetchImplementation: fetchMock as unknown as typeof fetch,
      retryBaseDelay: 0.001,
      retryMaxDelay: 0.001,
      maxRetries: 2,
    });

    await expect(
      llm.ainvoke([new UserMessage('hello')])
    ).rejects.toBeInstanceOf(ModelRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires BROWSER_USE_API_KEY when apiKey is not provided', () => {
    delete process.env.BROWSER_USE_API_KEY;
    expect(() => new ChatBrowserUse()).toThrow(/BROWSER_USE_API_KEY/);
  });
});
