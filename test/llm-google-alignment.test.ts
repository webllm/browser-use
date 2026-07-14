import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const generateContentMock = vi.fn();
const googleCtorMock = vi.fn();

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };

    constructor(options?: unknown) {
      googleCtorMock(options);
    }
  }

  return {
    GoogleGenAI,
    ThinkingLevel: {
      MINIMAL: 'MINIMAL',
      LOW: 'LOW',
      MEDIUM: 'MEDIUM',
      HIGH: 'HIGH',
    },
  };
});

import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  ImageURL,
  SystemMessage,
  UserMessage,
} from '../src/llm/messages.js';
import { ChatGoogle } from '../src/llm/google/chat.js';
import { GoogleMessageSerializer } from '../src/llm/google/serializer.js';

const buildResult = (text: string) => ({
  candidates: [
    {
      content: {
        parts: [{ text }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 2,
    totalTokenCount: 16,
    cachedContentTokenCount: 3,
    promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 5 }],
  },
});

describe('Google LLM alignment', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    googleCtorMock.mockReset();
    generateContentMock.mockResolvedValue(buildResult('plain response'));
  });

  it('extracts system instruction separately by default', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem([
      new SystemMessage('sys A'),
      new SystemMessage('sys B'),
      new UserMessage('hello'),
    ]);

    expect(systemInstruction).toBe('sys B');
    expect(contents).toHaveLength(1);
    expect((contents[0] as any).role).toBe('user');
    expect((contents[0] as any).parts[0].text).toBe('hello');
  });

  it('can include system text in first user message', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem(
      [
        new SystemMessage('sys header'),
        new UserMessage([new ContentPartTextParam('task body')]),
      ],
      true
    );

    expect(systemInstruction).toBeNull();
    expect((contents[0] as any).parts[0].text).toContain('sys header');
    expect((contents[0] as any).parts[1].text).toBe('task body');
  });

  it('includes multiple system messages when includeSystemInUser is enabled', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem(
      [
        new SystemMessage('sys A'),
        new SystemMessage('sys B'),
        new UserMessage('task body'),
      ],
      true
    );

    expect(systemInstruction).toBeNull();
    expect((contents[0] as any).parts[0].text).toContain('sys A');
    expect((contents[0] as any).parts[0].text).toContain('sys B');
    expect((contents[0] as any).parts[1].text).toBe('task body');
  });

  it('uses ImageURL media_type for inline data mime type', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents } = serializer.serializeWithSystem([
      new UserMessage([
        new ContentPartImageParam(
          new ImageURL('data:image/jpeg;base64,Zm9v', 'auto', 'image/png')
        ),
      ]),
    ]);

    expect((contents[0] as any).parts[0]).toEqual({
      inlineData: {
        mimeType: 'image/png',
        data: 'Zm9v',
      },
    });
  });

  it('serializes refusal parts as text in assistant messages', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents } = serializer.serializeWithSystem([
      new AssistantMessage({
        content: [new ContentPartRefusalParam('cannot comply')],
      }),
    ]);

    expect((contents[0] as any).role).toBe('model');
    expect((contents[0] as any).parts[0]).toEqual({
      text: '[Refusal] cannot comply',
    });
  });

  it('passes python-aligned Google client options through constructor', () => {
    new ChatGoogle({
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      apiVersion: 'v1',
      baseUrl: 'https://example.googleapis.com',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
      httpOptions: {
        timeout: 30000,
        headers: {
          'x-existing-client': 'keep-me',
        },
      },
      googleAuthOptions: {
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
      credentials: {
        client_email: 'svc@example.iam.gserviceaccount.com',
      },
    });

    expect(googleCtorMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      apiVersion: 'v1',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
      httpOptions: {
        baseUrl: 'https://example.googleapis.com',
        timeout: 30000,
        headers: {
          'x-existing-client': 'keep-me',
          'x-goog-api-client': expect.stringMatching(/^browser-use\/[^/]+$/),
        },
      },
      googleAuthOptions: {
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        credentials: {
          client_email: 'svc@example.iam.gserviceaccount.com',
        },
      },
    });
  });

  it('does not force apiVersion when neither option nor env is set', () => {
    const previousApiVersion = process.env.GOOGLE_API_VERSION;
    delete process.env.GOOGLE_API_VERSION;

    try {
      new ChatGoogle({
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
      });

      const ctorOptions = googleCtorMock.mock.calls[0]?.[0] ?? {};
      expect(ctorOptions).not.toHaveProperty('apiVersion');
    } finally {
      if (previousApiVersion === undefined) {
        delete process.env.GOOGLE_API_VERSION;
      } else {
        process.env.GOOGLE_API_VERSION = previousApiVersion;
      }
    }
  });

  it('passes generation params and returns usage with cached/image/thought tokens', async () => {
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      topP: 0.8,
      seed: 7,
      maxOutputTokens: 512,
      config: {
        stopSequences: ['DONE'],
      },
    });

    const controller = new AbortController();
    const response = await llm.ainvoke(
      [new SystemMessage('sys'), new UserMessage('hello')],
      undefined,
      { signal: controller.signal }
    );
    const request = generateContentMock.mock.calls[0]?.[0] ?? {};

    expect(generateContentMock.mock.calls[0]).toHaveLength(1);
    expect(request.generationConfig).toBeUndefined();
    expect(request.systemInstruction).toBeUndefined();
    expect(request.config.temperature).toBe(0.3);
    expect(request.config.topP).toBe(0.8);
    expect(request.config.seed).toBe(7);
    expect(request.config.stopSequences).toEqual(['DONE']);
    expect(request.config.thinkingConfig.thinkingBudget).toBe(-1);
    expect(request.config.maxOutputTokens).toBe(512);
    expect(request.config.systemInstruction.parts[0].text).toBe('sys');
    expect(request.config.abortSignal).toBe(controller.signal);
    expect(response.completion).toBe('plain response');
    expect(response.usage?.completion_tokens).toBe(6);
    expect(response.usage?.prompt_cached_tokens).toBe(3);
    expect(response.usage?.prompt_image_tokens).toBe(5);
  });

  it('applies Gemini 3 thinking-level defaults and safeguards for pro models', async () => {
    const llmDefault = new ChatGoogle({
      model: 'gemini-3-pro-preview',
    });
    await llmDefault.ainvoke([new UserMessage('hello')]);
    const defaultRequest = generateContentMock.mock.calls[0]?.[0] ?? {};
    expect(defaultRequest.config.thinkingConfig.thinkingLevel).toBe('LOW');

    generateContentMock.mockClear();

    const llmMinimal = new ChatGoogle({
      model: 'gemini-3-pro-preview',
      thinkingLevel: 'minimal',
    });
    await llmMinimal.ainvoke([new UserMessage('hello')]);
    const minimalRequest = generateContentMock.mock.calls[0]?.[0] ?? {};
    expect(minimalRequest.config.thinkingConfig.thinkingLevel).toBe('LOW');
  });

  it('supports Gemini 3 flash thinking level and budget behavior', async () => {
    const llmWithLevel = new ChatGoogle({
      model: 'gemini-3-flash-preview',
      thinkingLevel: 'high',
    });
    await llmWithLevel.ainvoke([new UserMessage('hello')]);
    const levelRequest = generateContentMock.mock.calls[0]?.[0] ?? {};
    expect(levelRequest.config.thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
    });

    generateContentMock.mockClear();

    const llmWithDefaultBudget = new ChatGoogle({
      model: 'gemini-3-flash-preview',
    });
    await llmWithDefaultBudget.ainvoke([new UserMessage('hello')]);
    const budgetRequest = generateContentMock.mock.calls[0]?.[0] ?? {};
    expect(budgetRequest.config.thinkingConfig).toEqual({
      thinkingBudget: -1,
    });
  });

  it('enforces structured output with includeSystemInUser mode', async () => {
    generateContentMock.mockResolvedValue(
      buildResult('```json\n{"value":"ok"}\n```')
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      includeSystemInUser: true,
      supportsStructuredOutput: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('sys prompt'), new UserMessage('extract')],
      schema as any
    );
    const request = generateContentMock.mock.calls[0]?.[0] ?? {};

    expect(request.systemInstruction).toBeUndefined();
    expect(request.generationConfig).toBeUndefined();
    expect(request.config.systemInstruction).toBeUndefined();
    expect(request.contents[0].parts[0].text as string).toContain('sys prompt');
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseSchema).toBeDefined();
    expect((response.completion as any).value).toBe('ok');
  });

  it('falls back to prompt-based JSON mode when structured output is disabled', async () => {
    generateContentMock.mockResolvedValue(
      buildResult('```json\n{"value":"fallback"}\n```')
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      supportsStructuredOutput: false,
    });

    const response = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = generateContentMock.mock.calls[0]?.[0] ?? {};

    expect(request.config.responseMimeType).toBeUndefined();
    expect(request.config.responseSchema).toBeUndefined();
    expect((request.contents?.[0]?.parts?.[1]?.text as string) ?? '').toContain(
      'Please respond with a valid JSON object that matches this schema'
    );
    expect((response.completion as any).value).toBe('fallback');
  });

  it('retries retryable failures with exponential backoff settings', async () => {
    generateContentMock
      .mockRejectedValueOnce({ status: 503, message: 'service unavailable' })
      .mockResolvedValueOnce(buildResult('recovered'));

    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      maxRetries: 2,
      retryBaseDelay: 0,
      retryMaxDelay: 0,
    });

    const response = await llm.ainvoke([new UserMessage('retry')]);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(response.completion).toBe('recovered');
  });

  it.each([
    ['non-finite retries', { maxRetries: Number.POSITIVE_INFINITY }],
    ['fractional retries', { maxRetries: 1.5 }],
    ['excessive retries', { maxRetries: 101 }],
    ['negative retries', { maxRetries: -1 }],
    ['non-finite base delay', { retryBaseDelay: Number.NaN }],
    ['negative maximum delay', { retryMaxDelay: -1 }],
    ['invalid retryable status code', { retryableStatusCodes: [429, 99] }],
    [
      'excessive retryable status codes',
      { retryableStatusCodes: new Array(101).fill(500) },
    ],
  ])('rejects %s', (_label, options) => {
    expect(() => new ChatGoogle(options)).toThrow();
  });

  it('omits output_schema field from Gemini response schema', async () => {
    generateContentMock.mockResolvedValue(
      buildResult('{"query":"topic","value":"ok"}')
    );

    const schema = z.object({
      query: z.string(),
      output_schema: z.record(z.string(), z.unknown()).nullable().optional(),
      value: z.string(),
    });

    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      supportsStructuredOutput: true,
    });

    await llm.ainvoke([new UserMessage('extract')], schema as any);
    const request = generateContentMock.mock.calls[0]?.[0] ?? {};
    const responseSchema = request.config.responseSchema ?? {};
    const serializedSchema = JSON.stringify(responseSchema);

    expect(serializedSchema).not.toContain('output_schema');
  });

  it('adds placeholder property for empty object schemas in Gemini mode', async () => {
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      supportsStructuredOutput: true,
    });

    const cleaned = (llm as any)._cleanSchemaForGoogle({
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {},
        },
      },
      required: ['meta'],
    });

    const metaSchema = (cleaned as any).properties?.meta ?? {};

    expect(metaSchema.properties?._placeholder).toEqual({
      type: 'string',
    });
  });
});
