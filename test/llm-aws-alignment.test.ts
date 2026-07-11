import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const bedrockCtorMock = vi.fn();
const bedrockSendMock = vi.fn();
const converseCommandCtorMock = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class ConverseCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
      converseCommandCtorMock(input);
    }
  }

  class BedrockRuntimeClient {
    send = bedrockSendMock;

    constructor(options?: unknown) {
      bedrockCtorMock(options);
    }
  }

  return {
    BedrockRuntimeClient,
    ConverseCommand,
  };
});

import { ChatBedrockConverse } from '../src/llm/aws/chat-bedrock.js';
import { ChatAnthropicBedrock } from '../src/llm/aws/chat-anthropic.js';
import { AWSBedrockMessageSerializer } from '../src/llm/aws/serializer.js';
import {
  ModelOutputTruncatedError,
  ModelRateLimitError,
} from '../src/llm/exceptions.js';
import {
  AssistantMessage,
  ContentPartRefusalParam,
  FunctionCall,
  SystemMessage,
  ToolCall,
  UserMessage,
} from '../src/llm/messages.js';

const buildResponse = (content: any[]) => ({
  output: {
    message: {
      content,
    },
  },
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  },
});

describe('AWS Bedrock alignment', () => {
  beforeEach(() => {
    bedrockCtorMock.mockReset();
    bedrockSendMock.mockReset();
    converseCommandCtorMock.mockReset();
    bedrockSendMock.mockResolvedValue(buildResponse([{ text: 'ok' }]));
  });

  it('passes credentials including AWS session token and inference config', async () => {
    const llm = new ChatBedrockConverse({
      model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      region: 'us-west-2',
      awsAccessKeyId: 'AKIA_TEST',
      awsSecretAccessKey: 'SECRET_TEST',
      awsSessionToken: 'SESSION_TEST',
      maxTokens: 2048,
      temperature: 0.3,
      topP: 0.8,
      seed: 42,
      stopSequences: ['</done>'],
      maxRetries: 7,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    expect(bedrockCtorMock.mock.calls[0]?.[0]).toMatchObject({
      region: 'us-west-2',
      credentials: {
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'SECRET_TEST',
        sessionToken: 'SESSION_TEST',
      },
      maxAttempts: 7,
    });

    const request = converseCommandCtorMock.mock.calls[0]?.[0] ?? {};
    expect(request.modelId).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0');
    expect(request.inferenceConfig.maxTokens).toBe(2048);
    expect(request.inferenceConfig.temperature).toBe(0.3);
    expect(request.inferenceConfig.topP).toBe(0.8);
    expect(request.inferenceConfig.seed).toBe(42);
    expect(request.inferenceConfig.stopSequences).toEqual(['</done>']);
  });

  it('uses optimized tool schema and parses structured output', async () => {
    bedrockSendMock.mockResolvedValue(
      buildResponse([
        {
          toolUse: {
            input: { items: ['alpha'] },
          },
        },
      ])
    );

    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatBedrockConverse({
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const result = await llm.ainvoke(
      [new UserMessage('extract')],
      schema as any
    );
    const request = converseCommandCtorMock.mock.calls[0]?.[0] ?? {};

    expect(request.toolConfig).toBeDefined();
    const schemaPayload = request.toolConfig.tools[0].toolSpec.inputSchema.json;
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('min_items');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect((result.completion as any).items).toEqual(['alpha']);
  });

  it('applies anthropic bedrock defaults and preserves system prompt', async () => {
    const llm = new ChatAnthropicBedrock({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: 'us-east-1',
      awsAccessKeyId: 'AKIA_TEST',
      awsSecretAccessKey: 'SECRET_TEST',
      awsSessionToken: 'SESSION_TEST',
      maxRetries: 5,
    });

    await llm.ainvoke([
      new SystemMessage('system context'),
      new UserMessage('hello'),
    ]);

    expect(bedrockCtorMock.mock.calls[0]?.[0]).toMatchObject({
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'SECRET_TEST',
        sessionToken: 'SESSION_TEST',
      },
      maxAttempts: 5,
    });

    const request = converseCommandCtorMock.mock.calls[0]?.[0] ?? {};
    expect(request.system[0].text).toContain('system context');
  });

  it('maps throttling errors to ModelRateLimitError', async () => {
    bedrockSendMock.mockRejectedValueOnce({
      name: 'ThrottlingException',
      message: 'rate limit',
      $metadata: { httpStatusCode: 429 },
    });

    const llm = new ChatBedrockConverse();

    await expect(llm.ainvoke([new UserMessage('hi')])).rejects.toBeInstanceOf(
      ModelRateLimitError
    );
  });

  it.each([
    ['Bedrock Converse', () => new ChatBedrockConverse({ maxTokens: 128 })],
    ['Anthropic Bedrock', () => new ChatAnthropicBedrock({ max_tokens: 128 })],
  ])(
    'reports %s max_tokens stops as output truncation',
    async (_, createLlm) => {
      bedrockSendMock.mockResolvedValue({
        ...buildResponse([{ text: 'partial' }]),
        stopReason: 'max_tokens',
      });

      await expect(
        createLlm().ainvoke([new UserMessage('produce a long answer')])
      ).rejects.toBeInstanceOf(ModelOutputTruncatedError);
    }
  );

  it('serializes system message, refusal content, and invalid tool args', () => {
    const serializer = new AWSBedrockMessageSerializer();

    const assistant = new AssistantMessage({
      content: [new ContentPartRefusalParam('cannot comply')],
      tool_calls: [
        new ToolCall('tool_1', new FunctionCall('do_it', 'not-json')),
      ],
    });

    const [messages, system] = serializer.serializeMessages([
      new SystemMessage('system prompt'),
      assistant,
    ]);

    expect(system).toEqual([{ text: 'system prompt' }]);
    expect(messages[0].content[0].text).toContain('[Refusal] cannot comply');
    expect((messages[0].content[1] as any).toolUse.input).toEqual({
      arguments: 'not-json',
    });
  });
});
