import { describe, expect, it } from 'vitest';
import { AnthropicMessageSerializer } from '../src/llm/anthropic/serializer.js';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartTextParam,
  FunctionCall,
  ImageURL,
  ToolCall,
  UserMessage,
} from '../src/llm/messages.js';

describe('Anthropic serializer alignment', () => {
  it('keeps only the last cached normal message and does not mutate originals', () => {
    const serializer = new AnthropicMessageSerializer();

    const first = new UserMessage('first');
    first.cache = true;

    const second = new AssistantMessage({ content: 'second' });
    second.cache = true;

    const [serialized] = serializer.serializeMessages([first, second]);

    expect(first.cache).toBe(true);
    expect(second.cache).toBe(true);
    expect(typeof serialized[0].content).toBe('string');
    expect(Array.isArray(serialized[1].content)).toBe(true);
  });

  it('applies cache_control only to the final tool_use block', () => {
    const serializer = new AnthropicMessageSerializer();

    const message = new AssistantMessage({
      content: 'assistant content',
      tool_calls: [
        new ToolCall('tool_1', new FunctionCall('one', '{"a":1}')),
        new ToolCall('tool_2', new FunctionCall('two', '{"b":2}')),
      ],
    });
    message.cache = true;

    const serialized = serializer.serializeMessage(message);
    expect(Array.isArray(serialized.content)).toBe(true);

    const blocks = serialized.content as any[];
    const textBlock = blocks.find((block) => block.type === 'text');
    const toolBlocks = blocks.filter((block) => block.type === 'tool_use');

    expect(textBlock?.cache_control).toBeUndefined();
    expect(toolBlocks).toHaveLength(2);
    expect(toolBlocks[0].cache_control).toBeUndefined();
    expect(toolBlocks[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('falls back unknown base64 media types to image/jpeg', () => {
    const serializer = new AnthropicMessageSerializer();

    const message = new UserMessage([
      new ContentPartTextParam('image'),
      new ContentPartImageParam(new ImageURL('data:image/bmp;base64,AAAA')),
    ]);

    const serialized = serializer.serializeMessage(message);
    const blocks = serialized.content as any[];
    const imageBlock = blocks.find((block) => block.type === 'image');

    expect(imageBlock?.source?.type).toBe('base64');
    expect(imageBlock?.source?.media_type).toBe('image/jpeg');
  });

  it('treats data URL schemes and media types case-insensitively', () => {
    const serializer = new AnthropicMessageSerializer();

    const message = new UserMessage([
      new ContentPartImageParam(new ImageURL('DATA:Image/PNG;base64,AAAA')),
    ]);

    const serialized = serializer.serializeMessage(message);
    const imageBlock = (serialized.content as any[]).find(
      (block) => block.type === 'image'
    );

    expect(imageBlock?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'AAAA',
    });
  });

  it('simplifies single uncached assistant text block to plain string', () => {
    const serializer = new AnthropicMessageSerializer();

    const message = new AssistantMessage({ content: null });
    const serialized = serializer.serializeMessage(message);

    expect(serialized.content).toBe('');
  });
});
