/**
 * Agentic loop for the Anthropic browser toolset.
 *
 * The SDK's tool runner dispatches tools by name, and the browser toolset has
 * no name (its members carry `toolset_name: "browser"`), so this helper runs
 * the loop: request, execute every `tool_use` in order, send the results back,
 * and repeat until Claude stops calling tools.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import {
  BATCH_HALT_TEXT,
  type BrowserUseToolset,
  type ToolResultBlock,
} from './browser-toolset.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type MessageCreateParams =
  Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export const DEFAULT_BROWSER_TOOLSET_MODEL = 'claude-opus-5-5';

export interface BrowserToolsetConversationOptions {
  client: Anthropic;
  toolset: BrowserUseToolset;
  /** Additional client tools, such as `createBashTool()` or `betaTool(...)`. */
  tools?: BetaRunnableTool[];
  /** Initial conversation. `task` is appended as a user message when given. */
  messages?: BetaMessageParam[];
  task?: string;
  system?: MessageCreateParams['system'];
  model?: string;
  maxTokens?: number;
  /** Requests to send before giving up (default 100). */
  maxIterations?: number;
  /** Extra request parameters such as `thinking` or `output_config`. */
  params?: Omit<
    Partial<MessageCreateParams>,
    'model' | 'max_tokens' | 'messages' | 'tools' | 'system' | 'stream'
  >;
  signal?: AbortSignal;
  onMessage?: (message: BetaMessage) => void | Promise<void>;
  onToolResult?: (
    result: ToolResultBlock,
    toolUse: BetaToolUseBlock
  ) => void | Promise<void>;
}

export interface BrowserToolsetConversationResult {
  /** The last assistant message. */
  message: BetaMessage;
  /** The full conversation, ending with the last assistant message or tool results. */
  messages: BetaMessageParam[];
  iterations: number;
}

const toolDefinition = (tool: BetaRunnableTool): BetaToolUnion => {
  const { run: _run, parse: _parse, close: _close, ...definition } = tool;
  return definition as BetaToolUnion;
};

const errorContent = (error: unknown): ToolResultBlock['content'] => {
  if (
    error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'ToolError' &&
    'content' in error
  ) {
    return (error as { content: ToolResultBlock['content'] }).content;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
};

const runClientTool = async (
  tool: BetaRunnableTool | undefined,
  toolUse: BetaToolUseBlock,
  signal: AbortSignal | undefined
): Promise<ToolResultBlock> => {
  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      is_error: true,
      content: `Error: Unknown tool ${toolUse.name}`,
    };
  }
  try {
    const input = tool.parse ? tool.parse(toolUse.input) : toolUse.input;
    const content = await tool.run(input, {
      toolUse,
      toolUseBlock: toolUse,
      signal: signal ?? null,
    });
    return { type: 'tool_result', tool_use_id: toolUse.id, content };
  } catch (error) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      is_error: true,
      content: errorContent(error),
    };
  }
};

/**
 * Run Claude with the browser toolset (and any client tools) until it stops
 * calling tools. Calls in one turn run in order; after the first failed call
 * the rest of the turn is reported as not executed.
 */
export async function runBrowserToolsetConversation(
  options: BrowserToolsetConversationOptions
): Promise<BrowserToolsetConversationResult> {
  const { client, toolset, signal } = options;
  const messages: BetaMessageParam[] = [...(options.messages ?? [])];
  if (options.task) {
    messages.push({ role: 'user', content: options.task });
  }
  if (!messages.length) {
    throw new Error('Provide messages or a task.');
  }
  const clientTools = options.tools ?? [];
  const toolsByName = new Map(clientTools.map((tool) => [tool.name, tool]));
  const tools: BetaToolUnion[] = [
    toolset.toolParam(),
    ...clientTools.map(toolDefinition),
  ];
  const maxIterations = options.maxIterations ?? 100;
  await toolset.start();

  let message: BetaMessage | null = null;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const stream = client.beta.messages.stream(
      {
        ...options.params,
        model: options.model ?? DEFAULT_BROWSER_TOOLSET_MODEL,
        max_tokens: options.maxTokens ?? 32_768,
        ...(options.system !== undefined ? { system: options.system } : {}),
        tools,
        messages,
      },
      signal ? { signal } : undefined
    );
    message = await stream.finalMessage();
    await options.onMessage?.(message);
    messages.push({
      role: 'assistant',
      content: message.content as BetaContentBlockParam[],
    });
    if (message.stop_reason === 'pause_turn') {
      continue;
    }
    const toolUses = message.content.filter(
      (
        block: Anthropic.Beta.Messages.BetaContentBlock
      ): block is BetaToolUseBlock => block.type === 'tool_use'
    );
    if (message.stop_reason !== 'tool_use' || !toolUses.length) {
      break;
    }

    const results: ToolResultBlock[] = [];
    let halted = false;
    for (const toolUse of toolUses) {
      let result: ToolResultBlock;
      if (halted) {
        result = toolset.handles(toolUse)
          ? toolset.haltResult(toolUse)
          : {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              is_error: true,
              content: BATCH_HALT_TEXT,
            };
      } else if (toolset.handles(toolUse)) {
        result = await toolset.execute(toolUse);
      } else {
        result = await runClientTool(
          toolsByName.get(toolUse.name),
          toolUse,
          signal
        );
      }
      halted ||= Boolean(result.is_error);
      results.push(result);
      await options.onToolResult?.(result, toolUse);
    }
    messages.push({ role: 'user', content: results });
  }

  if (!message) {
    throw new Error('maxIterations must allow at least one request.');
  }
  return { message, messages, iterations };
}
