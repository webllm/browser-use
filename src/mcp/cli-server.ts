import { createCanvas, loadImage } from 'canvas';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  run_direct_command,
  type DirectCliEnvironment,
} from '../skill-cli/direct.js';
import { redactMcpLogMessage } from './redaction.js';

type DirectCommandRunner = (
  argv: string[],
  options?: DirectCliEnvironment
) => Promise<number>;

type CliMcpArguments = Record<string, unknown> | undefined;

export interface CliMCPServerOptions {
  runDirectCommand?: DirectCommandRunner;
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

const instructions = `Use browser_exec for browser-use-direct commands such as open, state, click,
input, scroll, get, html, eval, and close. Arguments are passed directly to the command; no shell is
involved. Use browser_screenshot when visual inspection is useful. Browser state persists across calls.`;

const outputCollector = () => {
  let value = '';
  return {
    stream: {
      write(chunk: string) {
        value += chunk;
      },
    },
    value: () => value,
  };
};

const errorResult = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

const parseMaxOutputChars = (value: number | undefined): number => {
  if (Number.isInteger(value) && Number(value) > 0) {
    return Number(value);
  }
  const configured = Number(
    process.env.BROWSER_USE_CLI_MCP_MAX_OUTPUT_CHARS ?? DEFAULT_MAX_OUTPUT_CHARS
  );
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_OUTPUT_CHARS;
};

export class CliMCPServer {
  private readonly server: Server;
  private readonly runDirectCommand: DirectCommandRunner;
  private readonly maxOutputChars: number;
  private executionTail: Promise<void> = Promise.resolve();
  private restoreConsole: (() => void) | null = null;
  private isRunning = false;

  constructor(
    name: string,
    version: string,
    options: CliMCPServerOptions = {}
  ) {
    this.runDirectCommand = options.runDirectCommand ?? run_direct_command;
    this.maxOutputChars = parseMaxOutputChars(options.maxOutputChars);
    this.server = new Server(
      { name, version },
      { capabilities: { tools: {} }, instructions }
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getToolDefinitions(),
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callTool(request.params.name, request.params.arguments)
    );
  }

  public getToolDefinitions(): Tool[] {
    return [
      {
        name: 'browser_exec',
        description:
          'Execute one browser-use-direct command in the persistent browser session. This does not invoke a shell.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'Command name, for example open, state, click, input, scroll, get, html, eval, or close.',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Command arguments, passed without shell parsing.',
              default: [],
            },
            remote: {
              type: 'boolean',
              description: 'Use a Browser Use cloud browser.',
              default: false,
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'browser_screenshot',
        description:
          'Capture the current page and return a PNG image. Prefer this over the screenshot direct command.',
        inputSchema: {
          type: 'object',
          properties: {
            full: {
              type: 'boolean',
              description: 'Capture beyond the viewport.',
              default: false,
            },
            max_dim: {
              type: 'integer',
              minimum: 1,
              description:
                'Downscale the image so neither side exceeds this number of pixels.',
            },
            remote: {
              type: 'boolean',
              description: 'Use a Browser Use cloud browser.',
              default: false,
            },
          },
        },
      },
    ];
  }

  public async callTool(
    name: string,
    args: CliMcpArguments
  ): Promise<CallToolResult> {
    return this.withExecutionLock(async () => {
      try {
        if (name === 'browser_exec') {
          return await this.executeBrowserCommand(args);
        }
        if (name === 'browser_screenshot') {
          return await this.captureBrowserScreenshot(args);
        }
        return errorResult(`Unknown tool: ${name}`);
      } catch (error) {
        return errorResult(redactMcpLogMessage(error));
      }
    });
  }

  private async withExecutionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail;
    let release: () => void = () => {};
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private validateRemote(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
  }

  private limitOutput(value: string): string {
    if (value.length <= this.maxOutputChars) {
      return value;
    }
    const omitted = value.length - this.maxOutputChars;
    return `${value.slice(0, this.maxOutputChars)}\n...[truncated ${omitted} characters]`;
  }

  private async executeBrowserCommand(
    args: CliMcpArguments
  ): Promise<CallToolResult> {
    const command = args?.command;
    const commandArgs = args?.args ?? [];
    if (typeof command !== 'string' || !command.trim()) {
      return errorResult("'command' must be a non-empty string");
    }
    if (
      !Array.isArray(commandArgs) ||
      commandArgs.some((value) => typeof value !== 'string')
    ) {
      return errorResult("'args' must be an array of strings");
    }
    if (!this.validateRemote(args?.remote)) {
      return errorResult("'remote' must be a boolean");
    }

    const stdout = outputCollector();
    const stderr = outputCollector();
    const argv = [
      ...(args?.remote ? ['--remote'] : []),
      command.trim(),
      ...commandArgs,
    ];
    const exitCode = await this.runDirectCommand(argv, {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    const output = [stdout.value().trimEnd(), stderr.value().trimEnd()]
      .filter(Boolean)
      .join('\n');
    return {
      content: [
        {
          type: 'text',
          text: this.limitOutput(
            exitCode === 0
              ? output || '(no output)'
              : redactMcpLogMessage(output || `Command exited ${exitCode}`)
          ),
        },
      ],
      ...(exitCode === 0 ? {} : { isError: true }),
    };
  }

  private async captureBrowserScreenshot(
    args: CliMcpArguments
  ): Promise<CallToolResult> {
    if (args?.full !== undefined && typeof args.full !== 'boolean') {
      return errorResult("'full' must be a boolean");
    }
    if (!this.validateRemote(args?.remote)) {
      return errorResult("'remote' must be a boolean");
    }
    const maxDimension = args?.max_dim;
    if (
      maxDimension !== undefined &&
      (!Number.isInteger(maxDimension) || Number(maxDimension) < 1)
    ) {
      return errorResult("'max_dim' must be a positive integer");
    }

    const stdout = outputCollector();
    const stderr = outputCollector();
    const argv = [
      ...(args?.remote ? ['--remote'] : []),
      'screenshot',
      ...(args?.full ? ['--full'] : []),
    ];
    const exitCode = await this.runDirectCommand(argv, {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    if (exitCode !== 0) {
      return errorResult(
        redactMcpLogMessage(stderr.value().trim() || 'Screenshot failed')
      );
    }

    const payload = this.parseScreenshotPayload(stdout.value());
    if (!payload) {
      return errorResult('Screenshot command returned an invalid payload');
    }
    const data =
      maxDimension === undefined
        ? payload
        : await this.resizePng(payload, Number(maxDimension));
    return {
      content: [{ type: 'image', data, mimeType: 'image/png' }],
    };
  }

  private parseScreenshotPayload(output: string): string | null {
    const lines = output.trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { screenshot?: unknown };
        if (typeof parsed.screenshot === 'string' && parsed.screenshot) {
          return parsed.screenshot;
        }
      } catch {
        // Ignore non-JSON status lines.
      }
    }
    return null;
  }

  private async resizePng(data: string, maxDimension: number): Promise<string> {
    const image = await loadImage(Buffer.from(data, 'base64'));
    const currentMaximum = Math.max(image.width, image.height);
    if (currentMaximum <= maxDimension) {
      return data;
    }
    const scale = maxDimension / currentMaximum;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.toBuffer('image/png').toString('base64');
  }

  private redirectConsoleToStderr(): () => void {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);
    console.warn = (...args: unknown[]) => console.error(...args);
    return () => {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.restoreConsole ??= this.redirectConsoleToStderr();
    try {
      await this.server.connect(new StdioServerTransport());
      this.isRunning = true;
    } catch (error) {
      this.restoreConsole?.();
      this.restoreConsole = null;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.isRunning) {
      await this.server.close();
      this.isRunning = false;
    }
    this.restoreConsole?.();
    this.restoreConsole = null;
  }
}
