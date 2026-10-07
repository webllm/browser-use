import type { Content, Part } from '@google/genai';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
  type Message,
} from '../messages.js';

export interface SerializedGoogleMessages {
  contents: Content[];
  systemInstruction: string | null;
}

export class GoogleMessageSerializer {
  serialize(messages: Message[]): Content[] {
    return this.serializeWithSystem(messages).contents;
  }

  serializeWithSystem(
    messages: Message[],
    includeSystemInUser = false
  ): SerializedGoogleMessages {
    const contents: Content[] = [];
    // Collect every system message; a later one must not overwrite earlier ones.
    let systemParts: string[] = [];
    let firstUserMessageSerialized = false;

    for (const message of messages) {
      const role = (message as any)?.role;
      if (
        message instanceof SystemMessage ||
        role === 'system' ||
        role === 'developer'
      ) {
        const text = this.extractMessageText(message);
        if (text) {
          systemParts.push(text);
        }
        continue;
      }

      if (message instanceof UserMessage) {
        // Merge into the first user message only. Once a user message has been
        // serialized, later system text becomes the separate instruction.
        let prependSystem: string | null = null;
        if (
          includeSystemInUser &&
          !firstUserMessageSerialized &&
          systemParts.length > 0
        ) {
          prependSystem = systemParts.join('\n\n');
          systemParts = [];
        }
        contents.push(this.serializeUserMessage(message, prependSystem));
        firstUserMessageSerialized = true;
        continue;
      }

      if (message instanceof AssistantMessage) {
        contents.push(this.serializeAssistantMessage(message));
      }
    }

    if (
      includeSystemInUser &&
      systemParts.length > 0 &&
      !firstUserMessageSerialized
    ) {
      // Without any user turn, keep the request valid by sending the system
      // text as the opening user content.
      contents.unshift({
        role: 'user',
        parts: [{ text: systemParts.join('\n\n') }],
      });
      systemParts = [];
    }

    return {
      contents,
      systemInstruction:
        systemParts.length > 0 ? systemParts.join('\n\n') : null,
    };
  }

  private serializeUserMessage(
    message: UserMessage,
    prependSystem: string | null = null
  ): Content {
    const parts: Part[] = [];

    if (prependSystem) {
      parts.push({ text: prependSystem });
    }

    if (message instanceof UserMessage) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part instanceof ContentPartTextParam) {
            parts.push({ text: part.text });
          } else if (part instanceof ContentPartRefusalParam) {
            parts.push({ text: `[Refusal] ${part.refusal}` });
          } else if (part instanceof ContentPartImageParam) {
            parts.push(this.serializeImagePart(part));
          }
        }
      } else {
        parts.push({ text: message.content });
      }
    }

    return {
      role: 'user',
      parts,
    };
  }

  private serializeAssistantMessage(message: AssistantMessage): Content {
    const parts: Part[] = [];

    if (message instanceof AssistantMessage) {
      if (message.content) {
        if (typeof message.content === 'string') {
          parts.push({ text: message.content });
        } else if (Array.isArray(message.content)) {
          message.content.forEach((part) => {
            if (part instanceof ContentPartTextParam) {
              parts.push({ text: part.text });
            } else if (part instanceof ContentPartRefusalParam) {
              parts.push({ text: `[Refusal] ${part.refusal}` });
            } else if (part instanceof ContentPartImageParam) {
              parts.push(this.serializeImagePart(part));
            }
          });
        }
      }

      if (message.tool_calls) {
        message.tool_calls.forEach((toolCall) => {
          let args: Record<string, unknown>;
          try {
            const parsed = JSON.parse(toolCall.functionCall.arguments);
            args =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
          } catch {
            args = {};
          }
          parts.push({
            functionCall: {
              name: toolCall.functionCall.name,
              args,
            },
          });
        });
      }
    }

    return {
      role: 'model',
      parts: parts,
    };
  }

  private serializeImagePart(part: ContentPartImageParam): Part {
    const imageUrl = part.image_url.url;
    if (!imageUrl.startsWith('data:')) {
      return { text: imageUrl } as Part;
    }

    const commaIndex = imageUrl.indexOf(',');
    if (commaIndex === -1) {
      return { text: imageUrl } as Part;
    }

    const data = imageUrl.slice(commaIndex + 1);

    return {
      inlineData: {
        mimeType: part.image_url.media_type,
        data,
      },
    } as Part;
  }

  private extractMessageText(message: Message): string {
    const content = (message as any)?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }

    const parts: string[] = [];
    for (const part of content) {
      if (part instanceof ContentPartTextParam) {
        parts.push(part.text);
      } else if (
        part &&
        typeof part === 'object' &&
        (part as any).type === 'text' &&
        typeof (part as any).text === 'string'
      ) {
        parts.push((part as any).text);
      }
    }
    return parts.join('\n');
  }
}
