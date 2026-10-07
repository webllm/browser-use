/**
 * Anthropic Message Serializer with Prompt Caching Support
 *
 * This serializer converts custom message types to Anthropic's MessageParam format
 * and implements Anthropic's Prompt Caching feature to reduce costs by up to 90%.
 *
 * Caching Strategy:
 * - Only the last message with cache=true will have cache_control enabled
 * - Caching is most effective for system prompts and large conversation histories
 * - Cache writes cost 25% more, but cache reads cost 90% less
 *
 * Example cost savings:
 * - Without caching: 10,000 tokens @ $3/M = $0.030 per request
 * - With caching (90% hit rate):
 *   - First request: 10,000 tokens @ $3.75/M (write) = $0.0375
 *   - Subsequent: 1,000 tokens @ $3/M + 9,000 tokens @ $0.30/M = $0.0057
 *   - Savings: 81% cost reduction
 */

import type {
  MessageParam,
  ImageBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  FunctionCall,
  ImageURL,
  ToolCall,
  UserMessage,
  SystemMessage,
  type Message,
  type SupportedImageMediaType,
} from '../messages.js';

type CacheControlEphemeralParam = {
  type: 'ephemeral';
};

type NonSystemMessage = UserMessage | AssistantMessage;

export class AnthropicMessageSerializer {
  /**
   * Serialize a list of messages, extracting any system message
   *
   * @param messages - List of messages to serialize
   * @returns Tuple of [messages, system_message]
   */
  public serializeMessages(
    messages: Message[]
  ): [MessageParam[], (string | TextBlockParam[])?] {
    // Make deep copies to avoid modifying originals
    const messagesCopy = messages.map((message) => this._cloneMessage(message));

    // Separate system messages from normal messages
    const normalMessages: NonSystemMessage[] = [];
    let systemMessage: SystemMessage | null = null;

    for (const message of messagesCopy) {
      if (message instanceof SystemMessage) {
        systemMessage = message;
      } else {
        normalMessages.push(message as NonSystemMessage);
      }
    }

    // Clean cache messages so only the last cache=true message remains cached
    const cleanedMessages = this._cleanCacheMessages(normalMessages);

    // Serialize normal messages
    const serializedMessages = cleanedMessages.map((msg) =>
      this.serializeMessage(msg)
    );

    // Serialize system message
    let serializedSystemMessage: string | TextBlockParam[] | undefined =
      undefined;
    if (systemMessage) {
      serializedSystemMessage = this._serializeContentToStr(
        systemMessage.content,
        systemMessage.cache
      );
    }

    return [serializedMessages, serializedSystemMessage];
  }

  /**
   * Serialize a single message
   */
  public serializeMessage(message: Message): MessageParam {
    if (message instanceof UserMessage) {
      return {
        role: 'user',
        content: Array.isArray(message.content)
          ? message.content.map((part, idx, arr) => {
              const isLastPart = idx === arr.length - 1;
              const useCache = message.cache && isLastPart;

              if (part instanceof ContentPartTextParam) {
                return this._serializeContentPartText(part, useCache);
              }
              if (part instanceof ContentPartImageParam) {
                return this._serializeContentPartImage(part);
              }
              return { type: 'text', text: '' } as TextBlockParam;
            })
          : this._serializeContent(message.content, message.cache),
      };
    }

    if (message instanceof AssistantMessage) {
      const content: (TextBlockParam | ToolUseBlockParam)[] = [];

      // Add content blocks if present
      if (message.content) {
        if (typeof message.content === 'string') {
          content.push({
            type: 'text',
            text: message.content,
            ...(message.cache && !message.tool_calls?.length
              ? { cache_control: this._serializeCacheControl(true) }
              : {}),
          });
        } else if (Array.isArray(message.content)) {
          message.content.forEach((part, idx, arr) => {
            const isLastPart = idx === arr.length - 1;
            const useCache =
              message.cache && isLastPart && !message.tool_calls?.length;

            if (part instanceof ContentPartTextParam) {
              content.push(this._serializeContentPartText(part, useCache));
            }
          });
        }
      }

      // Add tool use blocks if present
      if (message.tool_calls) {
        message.tool_calls.forEach((toolCall, idx, arr) => {
          const isLastToolCall = idx === arr.length - 1;
          const useCache = message.cache && isLastToolCall;
          let toolInput: Record<string, unknown> | string;
          try {
            toolInput = JSON.parse(toolCall.functionCall.arguments);
          } catch {
            toolInput = { arguments: toolCall.functionCall.arguments };
          }

          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.functionCall.name,
            input: toolInput as any,
            ...(useCache
              ? { cache_control: this._serializeCacheControl(true) }
              : {}),
          });
        });
      }

      // If no content or tool calls, add empty text block
      if (!content.length) {
        content.push({
          type: 'text',
          text: '',
          ...(message.cache
            ? { cache_control: this._serializeCacheControl(true) }
            : {}),
        });
      }

      const normalizedContent: string | (TextBlockParam | ToolUseBlockParam)[] =
        (() => {
          if (message.cache || content.length > 1) {
            return content;
          }
          const first = content[0];
          if (first && first.type === 'text' && !(first as any).cache_control) {
            return first.text;
          }
          return content;
        })();

      return {
        role: 'assistant',
        content: normalizedContent,
      };
    }

    throw new Error(`Unknown message type or unhandled role: ${message.role}`);
  }

  /**
   * Serialize cache control parameter
   */
  private _serializeCacheControl(
    useCache: boolean
  ): CacheControlEphemeralParam | undefined {
    return useCache ? { type: 'ephemeral' } : undefined;
  }

  /**
   * Serialize text content part with optional caching
   */
  private _serializeContentPartText(
    part: ContentPartTextParam,
    useCache: boolean
  ): TextBlockParam {
    return {
      type: 'text',
      text: part.text,
      ...(useCache ? { cache_control: this._serializeCacheControl(true) } : {}),
    };
  }

  /**
   * Serialize image content part
   */
  private _serializeContentPartImage(
    part: ContentPartImageParam
  ): ImageBlockParam {
    const url = part.image_url.url;

    if (this._isBase64Image(url)) {
      // Handle base64 encoded images
      const [mediaType, data] = this._parseBase64Url(url);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: data,
        },
      };
    } else {
      // Handle URL images
      return {
        type: 'image',
        source: {
          type: 'url',
          url: url,
        },
      };
    }
  }

  /**
   * Serialize content (string or array) with optional caching
   */
  private _serializeContent(
    content: string | (ContentPartTextParam | ContentPartImageParam)[],
    useCache: boolean
  ): string | (TextBlockParam | ImageBlockParam)[] {
    if (typeof content === 'string') {
      if (useCache) {
        return [
          {
            type: 'text',
            text: content,
            cache_control: this._serializeCacheControl(true),
          },
        ];
      }
      return content;
    }

    return content.map((part, idx, arr) => {
      const isLastPart = idx === arr.length - 1;
      const partUseCache = useCache && isLastPart;

      if (part instanceof ContentPartTextParam) {
        return this._serializeContentPartText(part, partUseCache);
      } else if (part instanceof ContentPartImageParam) {
        return this._serializeContentPartImage(part);
      }
      return { type: 'text', text: '' } as TextBlockParam;
    });
  }

  /**
   * Serialize content to string format (for system messages)
   */
  private _serializeContentToStr(
    content: string | ContentPartTextParam[],
    useCache: boolean
  ): string | TextBlockParam[] {
    if (typeof content === 'string') {
      if (useCache) {
        return [
          {
            type: 'text',
            text: content,
            cache_control: this._serializeCacheControl(true),
          },
        ];
      }
      return content;
    }

    return content.map((part, idx, arr) => {
      const isLastPart = idx === arr.length - 1;
      const partUseCache = useCache && isLastPart;
      return this._serializeContentPartText(part, partUseCache);
    });
  }

  /**
   * Check if URL is a base64 encoded image
   */
  private _isBase64Image(url: string): boolean {
    // URI schemes (RFC 3986) and MIME types (RFC 2045) are case-insensitive,
    // so DATA:image/PNG;base64,... is still an inline image.
    const separator = url.indexOf(':');
    if (separator < 0 || url.slice(0, separator).toLowerCase() !== 'data') {
      return false;
    }
    const mediaType = (url.slice(separator + 1).split(',', 1)[0] ?? '')
      .split(';', 1)[0]!
      .toLowerCase();
    return mediaType.startsWith('image/');
  }

  /**
   * Parse base64 data URL to extract media type and data
   */
  private _parseBase64Url(url: string): [SupportedImageMediaType, string] {
    const separator = url.indexOf(':');
    if (separator < 0 || url.slice(0, separator).toLowerCase() !== 'data') {
      throw new Error(`Invalid base64 URL: ${url}`);
    }

    const remainder = url.slice(separator + 1);
    const commaIndex = remainder.indexOf(',');
    const header = commaIndex >= 0 ? remainder.slice(0, commaIndex) : '';
    const data = commaIndex >= 0 ? remainder.slice(commaIndex + 1) : '';
    if (!header || !data) {
      throw new Error(`Invalid base64 URL format: ${url}`);
    }

    // Anthropic expects the canonical lowercase media type.
    let mediaType = header.split(';', 1)[0]!.toLowerCase() || 'image/jpeg';

    // Ensure it's a supported media type
    const supportedTypes: SupportedImageMediaType[] = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ];

    if (!supportedTypes.includes(mediaType as SupportedImageMediaType)) {
      // Default to jpeg if not recognized
      mediaType = 'image/jpeg';
    }

    return [mediaType as SupportedImageMediaType, data];
  }

  private _cloneMessage(message: Message): Message {
    if (message instanceof UserMessage) {
      const clone = new UserMessage(
        this._cloneContent(message.content),
        message.name
      );
      clone.cache = message.cache;
      return clone;
    }

    if (message instanceof SystemMessage) {
      const clone = new SystemMessage(
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => new ContentPartTextParam(part.text)),
        message.name
      );
      clone.cache = message.cache;
      return clone;
    }

    if (message instanceof AssistantMessage) {
      const clone = new AssistantMessage({
        content:
          message.content === null
            ? null
            : typeof message.content === 'string'
              ? message.content
              : message.content.map((part) => {
                  if (part instanceof ContentPartTextParam) {
                    return new ContentPartTextParam(part.text);
                  }
                  if (part instanceof ContentPartRefusalParam) {
                    return new ContentPartRefusalParam(part.refusal);
                  }
                  if (part instanceof ContentPartImageParam) {
                    return new ContentPartImageParam(
                      new ImageURL(
                        part.image_url.url,
                        part.image_url.detail,
                        part.image_url.media_type
                      )
                    );
                  }
                  return part;
                }),
        tool_calls: message.tool_calls
          ? message.tool_calls.map(
              (toolCall) =>
                new ToolCall(
                  toolCall.id,
                  new FunctionCall(
                    toolCall.functionCall.name,
                    toolCall.functionCall.arguments
                  )
                )
            )
          : null,
        refusal: message.refusal,
      });
      clone.cache = message.cache;
      return clone;
    }

    return message;
  }

  private _cloneContent(
    content:
      | string
      | (
          | ContentPartTextParam
          | ContentPartImageParam
          | ContentPartRefusalParam
        )[]
  ):
    | string
    | (
        | ContentPartTextParam
        | ContentPartImageParam
        | ContentPartRefusalParam
      )[] {
    if (typeof content === 'string') {
      return content;
    }
    return content.map((part) => {
      if (part instanceof ContentPartTextParam) {
        return new ContentPartTextParam(part.text);
      }
      if (part instanceof ContentPartRefusalParam) {
        return new ContentPartRefusalParam(part.refusal);
      }
      return new ContentPartImageParam(
        new ImageURL(
          part.image_url.url,
          part.image_url.detail,
          part.image_url.media_type
        )
      );
    });
  }

  /**
   * Clean cache settings so only the last cache=true message remains cached
   *
   * Because of how Claude caching works, only the last cache message matters.
   * This method automatically removes cache=True from all messages except the last one.
   */
  private _cleanCacheMessages(
    messages: NonSystemMessage[]
  ): NonSystemMessage[] {
    if (!messages.length) {
      return messages;
    }

    // Create deep copies to avoid modifying originals
    const cleanedMessages = messages.map((msg) =>
      this._cloneMessage(msg)
    ) as NonSystemMessage[];

    // Find the last message with cache=true
    let lastCacheIndex = -1;
    for (let i = cleanedMessages.length - 1; i >= 0; i--) {
      if (cleanedMessages[i].cache) {
        lastCacheIndex = i;
        break;
      }
    }

    // If we found a cached message, disable cache for all others
    if (lastCacheIndex !== -1) {
      for (let i = 0; i < cleanedMessages.length; i++) {
        if (i !== lastCacheIndex && cleanedMessages[i].cache) {
          cleanedMessages[i].cache = false;
        }
      }
    }

    return cleanedMessages;
  }
}
