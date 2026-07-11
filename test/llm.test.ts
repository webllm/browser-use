/**
 * Comprehensive tests for LLM providers and utilities.
 *
 * Tests cover:
 * 1. Message serialization
 * 2. Schema optimization
 * 3. Error handling (rate limits, timeouts)
 * 4. Usage tracking
 * 5. Provider-specific behaviors
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Mock utils
vi.mock('../src/utils.js', () => {
  let counter = 0;
  const decorator =
    <T extends (...args: any[]) => any>(_label?: string) =>
    (fn: T) =>
      fn;

  return {
    uuid7str: () => `uuid-${++counter}`,
    time_execution_sync: decorator,
    time_execution_async: decorator,
    SignalHandler: class {
      register() {}
      reset() {}
      unregister() {}
    },
    get_browser_use_version: () => 'test-version',
    is_new_tab_page: () => false,
    match_url_with_domain_pattern: () => false,
    sanitize_surrogates: (text: string) => text,
    log_pretty_path: (p: string) => p,
  };
});

// Import after mocks
import {
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ContentPartTextParam,
  ContentPartImageParam,
  ImageURL,
  ToolCall,
  FunctionCall,
} from '../src/llm/messages.js';
import { SchemaOptimizer, zodSchemaToJsonSchema } from '../src/llm/schema.js';
import {
  ModelError,
  ModelOutputTruncatedError,
  ModelProviderError,
  ModelRateLimitError,
  isOutputTruncationReason,
  raiseIfOutputTruncated,
} from '../src/llm/exceptions.js';
import {
  ChatInvokeCompletion,
  type ChatInvokeUsage,
} from '../src/llm/views.js';

describe('LLM Messages', () => {
  describe('SystemMessage', () => {
    it('creates system message with string content', () => {
      const msg = new SystemMessage('You are a helpful assistant.');

      expect(msg.role).toBe('system');
      expect(msg.content).toBe('You are a helpful assistant.');
      expect(msg.text).toBe('You are a helpful assistant.');
    });

    it('creates system message with name', () => {
      const msg = new SystemMessage('Instructions here', 'system_prompt');

      expect(msg.name).toBe('system_prompt');
    });

    it('supports cache flag', () => {
      const msg = new SystemMessage('Cached content');
      msg.cache = true;

      expect(msg.cache).toBe(true);
    });
  });

  describe('UserMessage', () => {
    it('creates user message with string content', () => {
      const msg = new UserMessage('Hello, how are you?');

      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello, how are you?');
      expect(msg.text).toBe('Hello, how are you?');
    });

    it('creates user message with content parts', () => {
      const textPart = new ContentPartTextParam('Describe this image:');
      const imagePart = new ContentPartImageParam(
        new ImageURL('data:image/png;base64,base64data', 'auto', 'image/png')
      );
      const msg = new UserMessage([textPart, imagePart]);

      expect(msg.role).toBe('user');
      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content).toHaveLength(2);
    });
  });

  describe('AssistantMessage', () => {
    it('creates assistant message with string content', () => {
      const msg = new AssistantMessage({
        content: 'I am doing well, thank you!',
      });

      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('I am doing well, thank you!');
    });

    it('handles tool calls', () => {
      const toolCall = new ToolCall(
        'call_123',
        new FunctionCall('search', '{"query": "test"}')
      );
      const msg = new AssistantMessage({
        content: '',
        tool_calls: [toolCall],
      });

      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0].functionCall.name).toBe('search');
    });

    it('handles refusal', () => {
      const msg = new AssistantMessage({
        refusal: 'I cannot help with that request.',
      });

      expect(msg.refusal).toBe('I cannot help with that request.');
    });
  });

  describe('ContentPartTextParam', () => {
    it('creates text content part', () => {
      const part = new ContentPartTextParam('Hello world');

      expect(part.type).toBe('text');
      expect(part.text).toBe('Hello world');
    });

    it('converts to string', () => {
      const part = new ContentPartTextParam('Test text');

      expect(part.toString()).toContain('Test text');
    });
  });

  describe('ContentPartImageParam', () => {
    it('creates image content part with ImageURL', () => {
      const imageUrl = new ImageURL(
        'data:image/jpeg;base64,base64data',
        'auto',
        'image/jpeg'
      );
      const part = new ContentPartImageParam(imageUrl);

      expect(part.type).toBe('image_url');
      expect(part.image_url.url).toBe('data:image/jpeg;base64,base64data');
      expect(part.image_url.media_type).toBe('image/jpeg');
    });

    it('creates image content part with URL', () => {
      const imageUrl = new ImageURL(
        'https://example.com/image.png',
        'high',
        'image/png'
      );
      const part = new ContentPartImageParam(imageUrl);

      expect(part.type).toBe('image_url');
      expect(part.image_url.url).toBe('https://example.com/image.png');
      expect(part.image_url.detail).toBe('high');
    });
  });
});

describe('Schema Optimizer', () => {
  describe('createOptimizedJsonSchema', () => {
    it('optimizes simple JSON schema', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      expect(optimized).toBeDefined();
      expect(optimized.type).toBe('object');
      expect(optimized.properties).toHaveProperty('name');
      expect(optimized.properties).toHaveProperty('age');
    });

    it('adds additionalProperties: false', () => {
      const schema = {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      expect(optimized.additionalProperties).toBe(false);
    });

    it('handles nested objects', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      expect((optimized as any).properties.user).toBeDefined();
      expect((optimized as any).properties.user.properties).toHaveProperty(
        'name'
      );
      expect((optimized as any).properties.user.properties).toHaveProperty(
        'email'
      );
    });

    it('handles arrays', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      expect((optimized as any).properties.items.type).toBe('array');
    });

    it('preserves descriptions', () => {
      const schema = {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to',
          },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      expect((optimized as any).properties.url.description).toBe(
        'The URL to navigate to'
      );
    });

    it('sets required to all properties', () => {
      const schema = {
        type: 'object',
        properties: {
          required: { type: 'string' },
          optional: { type: 'string' },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      // makeStrictCompatible sets required to all property keys
      expect(optimized.required).toContain('required');
      expect(optimized.required).toContain('optional');
    });

    it('handles enums', () => {
      const schema = {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
          },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema);

      expect((optimized as any).properties.direction.enum).toEqual([
        'up',
        'down',
        'left',
        'right',
      ]);
    });

    it('optionally removes minItems and default for provider compatibility', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            min_items: 1,
            default: ['seed'],
            items: { type: 'string' },
          },
        },
      };

      const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema, {
        removeMinItems: true,
        removeDefaults: true,
      });

      expect(JSON.stringify(optimized)).not.toContain('minItems');
      expect(JSON.stringify(optimized)).not.toContain('min_items');
      expect(JSON.stringify(optimized)).not.toContain('"default"');
    });

    it('strips unsupported propertyNames and keeps dynamic record objects open', () => {
      const zodSchema = z.object({
        action: z.array(z.record(z.string(), z.any())),
      });

      const converted = zodSchemaToJsonSchema(zodSchema as any, {
        name: 'agent_output',
        target: 'jsonSchema7',
      });
      const optimized = SchemaOptimizer.createOptimizedJsonSchema(
        converted as any
      ) as any;

      const actionItems = optimized.properties?.action?.items;
      expect(actionItems).toBeDefined();
      expect(actionItems.propertyNames).toBeUndefined();
      expect(actionItems.additionalProperties).toBeDefined();
      expect(actionItems.additionalProperties).not.toBe(false);
    });

    it('converts zod v4 schemas into non-empty JSON schema payloads', () => {
      const zodSchema = z.object({
        value: z.string(),
        items: z.array(z.string()).min(1),
      });

      const converted = zodSchemaToJsonSchema(zodSchema as any, {
        name: 'agent_output',
        target: 'jsonSchema7',
      });

      expect((converted as any).type).toBe('object');
      expect((converted as any).properties?.value?.type).toBe('string');
      expect((converted as any).properties?.items?.type).toBe('array');
    });

    it('provides Gemini-optimized schema helper with strict compatibility', () => {
      const schema = {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      };

      const optimized = SchemaOptimizer.createGeminiOptimizedSchema(schema);

      expect(optimized.type).toBe('object');
      expect(optimized.additionalProperties).toBe(false);
      expect(optimized.required).toContain('title');
      expect(optimized.required).toContain('tags');
    });
  });

  describe('makeStrictCompatible', () => {
    it('ensures schema is strict compatible', () => {
      const schema: any = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };

      SchemaOptimizer.makeStrictCompatible(schema);

      // makeStrictCompatible sets required to property keys for object types
      expect(schema.required).toContain('name');
    });
  });
});

describe('LLM Exceptions', () => {
  describe('ModelError', () => {
    it('creates basic model error', () => {
      const error = new ModelError('Something went wrong');

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Something went wrong');
    });
  });

  describe('ModelProviderError', () => {
    it('creates provider error with status code', () => {
      const error = new ModelProviderError('API Error', 500, 'gpt-4');

      expect(error).toBeInstanceOf(ModelError);
      expect(error.statusCode).toBe(500);
      expect(error.model).toBe('gpt-4');
    });

    it('defaults to status code 502', () => {
      const error = new ModelProviderError('Error');

      expect(error.statusCode).toBe(502);
    });
  });

  describe('ModelRateLimitError', () => {
    it('creates rate limit error', () => {
      const error = new ModelRateLimitError(
        'Rate limit exceeded',
        429,
        'gpt-4'
      );

      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error.statusCode).toBe(429);
      expect(error.name).toBe('ModelRateLimitError');
    });

    it('defaults to status code 429', () => {
      const error = new ModelRateLimitError('Rate limited');

      expect(error.statusCode).toBe(429);
    });
  });

  describe('ModelOutputTruncatedError', () => {
    it('uses status 400 and recognizes provider stop-reason variants', () => {
      expect(isOutputTruncationReason('length')).toBe(true);
      expect(isOutputTruncationReason('MAX_TOKENS')).toBe(true);
      expect(isOutputTruncationReason('max-output-tokens')).toBe(true);
      expect(isOutputTruncationReason('stop')).toBe(false);

      expect(() =>
        raiseIfOutputTruncated('length', {
          model: 'gpt-test',
          tokenLimit: 128,
          tokenLimitName: 'max_completion_tokens',
        })
      ).toThrowError(ModelOutputTruncatedError);

      try {
        raiseIfOutputTruncated('length', {
          model: 'gpt-test',
          tokenLimit: 128,
          tokenLimitName: 'max_completion_tokens',
        });
      } catch (error) {
        expect(error).toMatchObject({
          name: 'ModelOutputTruncatedError',
          statusCode: 400,
          model: 'gpt-test',
          message: expect.stringContaining('max_completion_tokens=128'),
        });
      }
    });

    it('does not print null when the configured cap is absent', () => {
      expect(() =>
        raiseIfOutputTruncated('MAX_TOKENS', { model: 'model-test' })
      ).toThrow("the model's output token limit");
    });
  });
});

describe('LLM Views', () => {
  describe('ChatInvokeUsage', () => {
    it('tracks token usage', () => {
      const usage: ChatInvokeUsage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_cached_tokens: 20,
        prompt_cache_creation_tokens: null,
        prompt_image_tokens: 10,
      };

      expect(usage.prompt_tokens).toBe(100);
      expect(usage.completion_tokens).toBe(50);
      expect(usage.total_tokens).toBe(150);
    });
  });

  describe('ChatInvokeCompletion', () => {
    it('creates completion with content', () => {
      const completion = new ChatInvokeCompletion('Hello!', null);

      // Property is 'completion', not 'content'
      expect(completion.completion).toBe('Hello!');
      expect(completion.usage).toBeNull();
      expect(completion.stop_reason).toBeNull();
    });

    it('creates completion with usage', () => {
      const usage: ChatInvokeUsage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_cached_tokens: null,
        prompt_cache_creation_tokens: null,
        prompt_image_tokens: null,
      };
      const completion = new ChatInvokeCompletion('Response', usage);

      expect(completion.completion).toBe('Response');
      expect(completion.usage).toBe(usage);
    });

    it('handles structured output', () => {
      const structuredContent = { action: 'click', target: 'button' };
      const completion = new ChatInvokeCompletion(structuredContent, null);

      expect(completion.completion).toEqual(structuredContent);
    });

    it('handles thinking content', () => {
      const completion = new ChatInvokeCompletion(
        'Response',
        null,
        'Internal reasoning...',
        null
      );

      expect(completion.thinking).toBe('Internal reasoning...');
    });

    it('stores stop reason when provided', () => {
      const completion = new ChatInvokeCompletion(
        'Response',
        null,
        null,
        null,
        'end_turn'
      );

      expect(completion.stop_reason).toBe('end_turn');
    });
  });
});

describe('Message Serialization Patterns', () => {
  it('handles conversation history', () => {
    const history = [
      new SystemMessage('You are a helpful assistant.'),
      new UserMessage('Hello!'),
      new AssistantMessage({ content: 'Hi! How can I help you today?' }),
      new UserMessage('What is 2+2?'),
      new AssistantMessage({ content: '2+2 equals 4.' }),
    ];

    expect(history).toHaveLength(5);
    expect(history[0].role).toBe('system');
    expect(history[1].role).toBe('user');
    expect(history[2].role).toBe('assistant');
  });

  it('handles multimodal messages', () => {
    const messages = [
      new SystemMessage('You can see and describe images.'),
      new UserMessage([
        new ContentPartTextParam('What is in this image?'),
        new ContentPartImageParam(
          new ImageURL(
            'data:image/png;base64,encodedimage',
            'auto',
            'image/png'
          )
        ),
      ]),
    ];

    expect(messages).toHaveLength(2);
    expect(Array.isArray(messages[1].content)).toBe(true);
  });

  it('handles tool use pattern', () => {
    const toolCall = new ToolCall(
      'call_1',
      new FunctionCall('search', '{"query":"cats"}')
    );
    const messages = [
      new UserMessage('Search for cats'),
      new AssistantMessage({
        content: '',
        tool_calls: [toolCall],
      }),
    ];

    const assistant = messages[1] as AssistantMessage;
    expect(assistant.tool_calls).toBeDefined();
    expect(assistant.tool_calls).toHaveLength(1);
  });
});

describe('Provider-Specific Patterns', () => {
  describe('OpenAI-style messages', () => {
    it('formats messages for OpenAI API', () => {
      const messages = [
        new SystemMessage('System prompt'),
        new UserMessage('User input'),
        new AssistantMessage({ content: 'Assistant response' }),
      ];

      // Verify structure matches OpenAI format
      const formatted = messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : null,
      }));

      expect(formatted[0]).toEqual({
        role: 'system',
        content: 'System prompt',
      });
    });
  });

  describe('Anthropic-style messages', () => {
    it('extracts system message separately', () => {
      const messages = [
        new SystemMessage('You are Claude.'),
        new UserMessage('Hello'),
        new AssistantMessage({ content: 'Hi!' }),
      ];

      const systemMessages = messages.filter((m) => m.role === 'system');
      const otherMessages = messages.filter((m) => m.role !== 'system');

      expect(systemMessages).toHaveLength(1);
      expect(otherMessages).toHaveLength(2);
    });

    it('handles cache control', () => {
      const msg = new SystemMessage('Cached system prompt');
      msg.cache = true;

      expect(msg.cache).toBe(true);
    });
  });
});

describe('Reasoning Model Support', () => {
  it('identifies reasoning models', () => {
    const reasoningModels = [
      'o4-mini',
      'o3',
      'o3-mini',
      'o1',
      'o1-pro',
      'o3-pro',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
    ];

    const isReasoningModel = (model: string) =>
      reasoningModels.some((m) =>
        model.toLowerCase().includes(m.toLowerCase())
      );

    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('gpt-4')).toBe(false);
    expect(isReasoningModel('o1-pro')).toBe(true);
    expect(isReasoningModel('claude-3')).toBe(false);
  });
});
