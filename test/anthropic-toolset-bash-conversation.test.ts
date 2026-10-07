import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_HALT_TEXT,
  createBashTool,
  runBash,
  runBrowserToolsetConversation,
  type BrowserToolUse,
  type BrowserUseToolset,
  type ToolResultBlock,
} from '../src/integrations/anthropic/index.js';

const posix = process.platform !== 'win32';

describe.runIf(posix)('runBash', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-bash-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const run = async (
    command: string,
    options: Parameters<typeof runBash>[1] = {}
  ) => JSON.parse(await runBash(command, { outputDir, ...options }));

  it('returns interleaved output and the exit code as JSON', async () => {
    await expect(run('echo out; echo err >&2; exit 3')).resolves.toEqual({
      exit_code: 3,
      timed_out: false,
      truncated: false,
      output: 'out\nerr\n',
    });
  });

  it('runs in the output directory with a stripped environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
    const result = await run(
      'echo "${ANTHROPIC_API_KEY:-unset}|$HOME|$PWD|$TMPDIR"; touch made.txt'
    );
    const realDir = fs.realpathSync(outputDir);
    expect(result.output.trim().split('|')[0]).toBe('unset');
    expect(result.output).toContain(`|${outputDir}|`);
    expect([outputDir, realDir]).toContain(result.output.trim().split('|')[2]);
    expect(
      result.output.trim().endsWith(`${path.join(outputDir, '.tmp')}`)
    ).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'made.txt'))).toBe(true);
  });

  it('caps output', async () => {
    const result = await run("head -c 5000 /dev/zero | tr '\\0' a", {
      maxOutputBytes: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(result.output).toBe('a'.repeat(1000));
  });

  it('kills the process group on timeout, including background jobs', async () => {
    const started = Date.now();
    const result = await run('echo started; sleep 30 & sleep 30', {
      timeoutSeconds: 0.3,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.timed_out).toBe(true);
    expect(result.output).toBe('started\n');
    expect(result.exit_code).toBe(-9);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await run('sleep 30', { signal: controller.signal });
    expect(result.timed_out).toBe(false);
    expect(result.exit_code).toBe(-9);
  });

  it('validates limits', async () => {
    await expect(
      runBash('true', { outputDir, timeoutSeconds: 0 })
    ).rejects.toThrow('timeoutSeconds must be positive');
    await expect(
      runBash('true', { outputDir, maxOutputBytes: 0 })
    ).rejects.toThrow('maxOutputBytes must be positive');
  });

  it('exposes a runnable bash tool', async () => {
    const tool = createBashTool({ outputDir });
    expect(tool.name).toBe('bash');
    expect((tool as { input_schema?: unknown }).input_schema).toMatchObject({
      type: 'object',
      required: ['command'],
    });
    const output = JSON.parse(
      (await tool.run({ command: 'echo ok' })) as string
    );
    expect(output).toMatchObject({ exit_code: 0, output: 'ok\n' });
  });
});

type FakeMessage = Omit<
  Partial<Anthropic.Beta.Messages.BetaMessage>,
  'content'
> & {
  content: any[];
  stop_reason: Anthropic.Beta.Messages.BetaMessage['stop_reason'];
};

const fakeClient = (responses: FakeMessage[]) => {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: any) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error('No more fake responses');
          return {
            finalMessage: async () => ({
              id: `msg_${requests.length}`,
              type: 'message',
              role: 'assistant',
              model: params.model,
              usage: {},
              ...next,
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
};

const fakeToolset = (fail: Set<string> = new Set()) => {
  const executed: string[] = [];
  const toolset = {
    toolParam: () => ({ type: 'browser_toolset_20260801', configs: {} }),
    start: async () => toolset,
    handles: (block: BrowserToolUse) => block.toolset_name === 'browser',
    haltResult: (block: BrowserToolUse): ToolResultBlock => ({
      type: 'tool_result',
      tool_use_id: block.id,
      toolset_name: 'browser',
      is_error: true,
      content: BATCH_HALT_TEXT,
    }),
    execute: async (block: BrowserToolUse): Promise<ToolResultBlock> => {
      executed.push(block.name);
      return fail.has(block.name)
        ? {
            type: 'tool_result',
            tool_use_id: block.id,
            toolset_name: 'browser',
            is_error: true,
            content: `${block.name} failed`,
          }
        : {
            type: 'tool_result',
            tool_use_id: block.id,
            toolset_name: 'browser',
            content: [{ type: 'text', text: `${block.name} ok` }],
          };
    },
  };
  return { toolset: toolset as unknown as BrowserUseToolset, executed };
};

const browserUse = (id: string, name: string, input: unknown = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
  toolset_name: 'browser',
});

describe('runBrowserToolsetConversation', () => {
  it('runs browser and client tools until Claude stops, resuming paused turns', async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Opening the page.' },
          browserUse('toolu_1', 'navigate', { url: 'example.com' }),
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'echo',
            input: { value: 'hi' },
          },
        ],
      },
      {
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: 'Still working.' }],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
    ]);
    const { toolset, executed } = fakeToolset();
    const echo = {
      type: 'custom' as const,
      name: 'echo',
      description: 'Echo a value.',
      input_schema: {
        type: 'object' as const,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      parse: (input: unknown) => input as { value: string },
      run: async ({ value }: { value: string }) => `echo: ${value}`,
    };
    const messages: string[] = [];

    const result = await runBrowserToolsetConversation({
      client,
      toolset,
      tools: [echo],
      task: 'Open example.com',
      system: 'Use the browser.',
      onMessage: (message) => {
        messages.push(message.stop_reason ?? '');
      },
    });

    expect(executed).toEqual(['navigate']);
    expect(result.iterations).toBe(3);
    expect(result.message.content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(messages).toEqual(['tool_use', 'pause_turn', 'end_turn']);

    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 32_768,
      system: 'Use the browser.',
      messages: [{ role: 'user', content: 'Open example.com' }],
    });
    expect(requests[0].tools).toEqual([
      { type: 'browser_toolset_20260801', configs: {} },
      {
        type: 'custom',
        name: 'echo',
        description: 'Echo a value.',
        input_schema: echo.input_schema,
      },
    ]);
    expect(requests[1].messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          toolset_name: 'browser',
          content: [{ type: 'text', text: 'navigate ok' }],
        },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'echo: hi' },
      ],
    });
    // A paused turn is resumed by sending the assistant content back as-is.
    expect(requests[2].messages).toHaveLength(4);
    expect(requests[2].messages[3]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Still working.' }],
    });
    expect(result.messages).toHaveLength(5);
  });

  it('halts the rest of the turn after a failed call', async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          browserUse('toolu_1', 'left_click'),
          { type: 'tool_use', id: 'toolu_2', name: 'echo', input: {} },
          browserUse('toolu_3', 'screenshot'),
        ],
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Stopped.' }],
      },
    ]);
    const { toolset, executed } = fakeToolset(new Set(['left_click']));

    await runBrowserToolsetConversation({
      client,
      toolset,
      messages: [{ role: 'user', content: 'Click it' }],
    });

    expect(executed).toEqual(['left_click']);
    expect(requests[1].messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        toolset_name: 'browser',
        is_error: true,
        content: 'left_click failed',
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        is_error: true,
        content: BATCH_HALT_TEXT,
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_3',
        toolset_name: 'browser',
        is_error: true,
        content: BATCH_HALT_TEXT,
      },
    ]);
  });

  it('turns client tool failures into error results', async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'structured', input: {} },
        ],
      },
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'missing', input: {} },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    ]);
    const { toolset } = fakeToolset();
    const structured = {
      type: 'custom' as const,
      name: 'structured',
      input_schema: { type: 'object' as const },
      parse: (input: unknown) => input,
      run: async () => {
        throw new ToolError([{ type: 'text', text: 'details' }]);
      },
    };

    await runBrowserToolsetConversation({
      client,
      toolset,
      tools: [structured],
      task: 'go',
    });

    expect(requests[1].messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      is_error: true,
      content: [{ type: 'text', text: 'details' }],
    });
    expect(requests[2].messages[4].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      is_error: true,
      content: 'Error: Unknown tool missing',
    });
  });

  it('stops at maxIterations and requires a prompt', async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [browserUse('toolu_1', 'screenshot')],
      },
      {
        stop_reason: 'tool_use',
        content: [browserUse('toolu_2', 'screenshot')],
      },
    ]);
    const { toolset } = fakeToolset();

    const result = await runBrowserToolsetConversation({
      client,
      toolset,
      task: 'loop',
      maxIterations: 1,
      model: 'claude-sonnet-5',
      maxTokens: 1024,
      params: { thinking: { type: 'adaptive' } },
    });
    expect(result.iterations).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
    });
    // The tool results are kept so the caller can continue the conversation.
    expect(result.messages.at(-1)!.role).toBe('user');

    await expect(
      runBrowserToolsetConversation({ client, toolset })
    ).rejects.toThrow('Provide messages or a task.');
  });
});
