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
  maxScreenshotBytes?: number;
  maxScreenshotPixels?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SCREENSHOT_PIXELS = 32 * 1024 * 1024;
const SCREENSHOT_JSON_OVERHEAD_CHARS = 4 * 1024;

const instructions = `Use browser_exec for browser-use-direct commands such as open, state, click,
input, scroll, get, html, eval, and close. Arguments are passed directly to the command; no shell is
involved. Use browser_screenshot when visual inspection is useful. Browser state persists across calls.`;

type OutputBudget = {
  remainingChars: number;
  omittedChars: number;
};

export const createBoundedOutputCollector = (budget: OutputBudget) => {
  let value = '';
  return {
    stream: {
      write(chunk: string) {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        const retained = text.slice(0, Math.max(0, budget.remainingChars));
        value += retained;
        budget.remainingChars -= retained.length;
        budget.omittedChars += text.length - retained.length;
      },
    },
    value: () => value,
    truncated: () => budget.omittedChars > 0,
  };
};

const createOutputBudget = (maxChars: number): OutputBudget => ({
  remainingChars: maxChars,
  omittedChars: 0,
});

const parsePositiveInteger = (
  value: number | undefined,
  environmentValue: string | undefined,
  fallback: number
): number => {
  if (Number.isSafeInteger(value) && Number(value) > 0) {
    return Number(value);
  }
  const configured = Number(environmentValue ?? fallback);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : fallback;
};

export class CliMCPServer {
  private readonly server: Server;
  private readonly runDirectCommand: DirectCommandRunner;
  private readonly maxOutputChars: number;
  private readonly maxScreenshotBytes: number;
  private readonly maxScreenshotPixels: number;
  private executionTail: Promise<void> = Promise.resolve();
  private restoreConsole: (() => void) | null = null;
  private isRunning = false;

  constructor(
    name: string,
    version: string,
    options: CliMCPServerOptions = {}
  ) {
    this.runDirectCommand = options.runDirectCommand ?? run_direct_command;
    this.maxOutputChars = parsePositiveInteger(
      options.maxOutputChars,
      process.env.BROWSER_USE_CLI_MCP_MAX_OUTPUT_CHARS,
      DEFAULT_MAX_OUTPUT_CHARS
    );
    this.maxScreenshotBytes = parsePositiveInteger(
      options.maxScreenshotBytes,
      process.env.BROWSER_USE_CLI_MCP_MAX_SCREENSHOT_BYTES,
      DEFAULT_MAX_SCREENSHOT_BYTES
    );
    this.maxScreenshotPixels = parsePositiveInteger(
      options.maxScreenshotPixels,
      process.env.BROWSER_USE_CLI_MCP_MAX_SCREENSHOT_PIXELS,
      DEFAULT_MAX_SCREENSHOT_PIXELS
    );
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
        return this.errorResult(`Unknown tool: ${name}`);
      } catch (error) {
        return this.errorResult(redactMcpLogMessage(error));
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

  private limitOutput(value: string, preOmittedChars = 0): string {
    if (value.length <= this.maxOutputChars && preOmittedChars === 0) {
      return value;
    }
    const retained = value.slice(0, this.maxOutputChars);
    const omitted =
      preOmittedChars + Math.max(0, value.length - this.maxOutputChars);
    return `${retained}\n...[truncated ${omitted} characters]`;
  }

  private errorResult(message: string, preOmittedChars = 0): CallToolResult {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${this.limitOutput(message, preOmittedChars)}`,
        },
      ],
      isError: true,
    };
  }

  private async executeBrowserCommand(
    args: CliMcpArguments
  ): Promise<CallToolResult> {
    const command = args?.command;
    const commandArgs = args?.args ?? [];
    if (typeof command !== 'string' || !command.trim()) {
      return this.errorResult("'command' must be a non-empty string");
    }
    if (
      !Array.isArray(commandArgs) ||
      commandArgs.some((value) => typeof value !== 'string')
    ) {
      return this.errorResult("'args' must be an array of strings");
    }
    if (!this.validateRemote(args?.remote)) {
      return this.errorResult("'remote' must be a boolean");
    }

    if (
      command.trim() === 'screenshot' &&
      !(commandArgs as string[]).some(
        (value) => value !== '--full' && value !== '--full-page'
      )
    ) {
      return this.errorResult(
        'Use browser_screenshot for screenshots without an output path'
      );
    }

    const outputBudget = createOutputBudget(this.maxOutputChars);
    const stdout = createBoundedOutputCollector(outputBudget);
    const stderr = createBoundedOutputCollector(outputBudget);
    const argv = [
      ...(args?.remote ? ['--remote'] : []),
      command.trim(),
      ...commandArgs,
    ];
    const exitCode = await this.runDirectCommand(argv, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      max_screenshot_bytes: this.maxScreenshotBytes,
      max_screenshot_pixels: this.maxScreenshotPixels,
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
              : redactMcpLogMessage(output || `Command exited ${exitCode}`),
            outputBudget.omittedChars
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
      return this.errorResult("'full' must be a boolean");
    }
    if (!this.validateRemote(args?.remote)) {
      return this.errorResult("'remote' must be a boolean");
    }
    const maxDimension = args?.max_dim;
    if (
      maxDimension !== undefined &&
      (!Number.isInteger(maxDimension) || Number(maxDimension) < 1)
    ) {
      return this.errorResult("'max_dim' must be a positive integer");
    }

    const maxScreenshotOutputChars =
      Math.ceil((this.maxScreenshotBytes * 4) / 3) +
      SCREENSHOT_JSON_OVERHEAD_CHARS;
    const screenshotBudget = createOutputBudget(maxScreenshotOutputChars);
    const stdout = createBoundedOutputCollector(screenshotBudget);
    const stderrBudget = createOutputBudget(this.maxOutputChars);
    const stderr = createBoundedOutputCollector(stderrBudget);
    const argv = [
      ...(args?.remote ? ['--remote'] : []),
      'screenshot',
      ...(args?.full ? ['--full'] : []),
    ];
    const exitCode = await this.runDirectCommand(argv, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      max_screenshot_bytes: this.maxScreenshotBytes,
      max_screenshot_pixels: this.maxScreenshotPixels,
    });
    if (exitCode !== 0) {
      return this.errorResult(
        redactMcpLogMessage(stderr.value().trim() || 'Screenshot failed'),
        stderrBudget.omittedChars
      );
    }
    if (stdout.truncated()) {
      return this.errorResult(
        `Screenshot exceeds maximum encoded size of ${this.maxScreenshotBytes} bytes`
      );
    }

    const payload = this.parseScreenshotPayload(stdout.value());
    if (!payload) {
      return this.errorResult('Screenshot command returned an invalid payload');
    }
    const png = this.decodeAndValidatePng(payload);
    const data =
      maxDimension === undefined
        ? payload
        : await this.resizePng(png, payload, Number(maxDimension));
    return {
      content: [{ type: 'image', data, mimeType: 'image/png' }],
    };
  }

  private parseScreenshotPayload(output: string): string | null {
    let end = output.trimEnd().length;
    while (end > 0) {
      const start = output.lastIndexOf('\n', end - 1) + 1;
      const line = output.slice(start, end).trim();
      try {
        const parsed = JSON.parse(line) as { screenshot?: unknown };
        if (typeof parsed.screenshot === 'string' && parsed.screenshot) {
          return parsed.screenshot;
        }
      } catch {
        // Ignore non-JSON status lines.
      }
      if (start === 0) break;
      end = start - 1;
    }
    return null;
  }

  private decodeAndValidatePng(data: string): Buffer {
    const normalized = data.trim();
    const padding = normalized.endsWith('==')
      ? 2
      : normalized.endsWith('=')
        ? 1
        : 0;
    const estimatedBytes = Math.max(
      0,
      Math.floor((normalized.length * 3) / 4) - padding
    );
    if (estimatedBytes > this.maxScreenshotBytes) {
      throw new Error(
        `Screenshot exceeds maximum encoded size of ${this.maxScreenshotBytes} bytes`
      );
    }

    const png = Buffer.from(normalized, 'base64');
    if (png.length === 0 || png.length > this.maxScreenshotBytes) {
      throw new Error(
        `Screenshot exceeds maximum encoded size of ${this.maxScreenshotBytes} bytes`
      );
    }
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (
      png.length < 24 ||
      !png.subarray(0, pngSignature.length).equals(pngSignature) ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new Error('Screenshot command returned a malformed PNG payload');
    }

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (
      width < 1 ||
      height < 1 ||
      width > Math.floor(this.maxScreenshotPixels / height)
    ) {
      throw new Error(
        `Screenshot exceeds maximum pixel count of ${this.maxScreenshotPixels}`
      );
    }
    return png;
  }

  private async resizePng(
    png: Buffer,
    data: string,
    maxDimension: number
  ): Promise<string> {
    const image = await loadImage(png);
    const currentMaximum = Math.max(image.width, image.height);
    if (currentMaximum <= maxDimension) {
      return data;
    }
    const scale = maxDimension / currentMaximum;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    const resized = canvas.toBuffer('image/png');
    if (resized.length > this.maxScreenshotBytes) {
      throw new Error(
        `Screenshot exceeds maximum encoded size of ${this.maxScreenshotBytes} bytes after resizing`
      );
    }
    return resized.toString('base64');
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
    try {
      if (this.isRunning) {
        await this.server.close();
      }
    } finally {
      this.isRunning = false;
      this.restoreConsole?.();
      this.restoreConsole = null;
    }
  }
}
