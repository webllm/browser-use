import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ChatGoogle } from '../src/llm/google/chat.js';
import { ModelOutputTruncatedError } from '../src/llm/exceptions.js';
import { SystemMessage, UserMessage } from '../src/llm/messages.js';

describe('Google LLM wire request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends system instruction, generation config, schema, and abort signal through SDK config', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, any> | null = null;
    let capturedSignal: AbortSignal | null = null;
    let capturedRedirect: RequestRedirect | null = null;

    const fetchMock = vi.fn(
      async (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        capturedUrl = String(url);
        capturedSignal = init?.signal ?? null;
        capturedRedirect = init?.redirect ?? null;
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: '{"value":"ok"}' }],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const schema = z.object({ value: z.string() });
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      baseUrl: 'https://google-proxy.example.test',
      temperature: 0.3,
      topP: 0.8,
      seed: 7,
      thinkingBudget: 0,
      maxOutputTokens: 512,
      config: {
        stopSequences: ['DONE'],
      },
      supportsStructuredOutput: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('SYSTEM-PROMPT'), new UserMessage('extract')],
      schema as any,
      { signal: controller.signal }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toMatch(/^https:\/\/google-proxy\.example\.test\//);
    expect(capturedSignal).toBeTruthy();
    expect(capturedRedirect).toBe('error');
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as unknown as Record<string, any>;

    expect(body).toMatchObject({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'extract' }],
        },
      ],
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'SYSTEM-PROMPT' }],
      },
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        seed: 7,
        stopSequences: ['DONE'],
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    });
    expect(body.generationConfig?.responseSchema).toBeDefined();
    expect(body).not.toHaveProperty('config');
    expect(body).not.toHaveProperty('generation_config');
    expect((response.completion as any).value).toBe('ok');
  });

  it('reports MAX_TOKENS before parsing incomplete content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: '{"value":"partial' }] },
                  finishReason: 'MAX_TOKENS',
                },
              ],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          )
      )
    );

    const llm = new ChatGoogle({
      apiKey: 'test-key',
      maxOutputTokens: 128,
      maxRetries: 1,
    });
    await expect(
      llm.ainvoke(
        [new UserMessage('extract')],
        z.object({ value: z.string() }) as any
      )
    ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
  });
});
