import { createCanvas, loadImage } from 'canvas';
import { describe, expect, it, vi } from 'vitest';
import {
  CliMCPServer,
  createBoundedOutputCollector,
} from '../src/mcp/cli-server.js';

const textFrom = (result: Awaited<ReturnType<CliMCPServer['callTool']>>) => {
  const content = result.content[0];
  return content?.type === 'text' ? content.text : '';
};

describe('CliMCPServer', () => {
  it('exposes only the command and screenshot tools', () => {
    const server = new CliMCPServer('test', '1.0.0');

    const tools = server.getToolDefinitions();

    expect(tools.map((tool) => tool.name)).toEqual([
      'browser_exec',
      'browser_screenshot',
    ]);
    expect((tools[1]?.inputSchema.properties as any).max_dim.minimum).toBe(1);
  });

  it('executes direct commands without shell parsing', async () => {
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write('Navigated\n');
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
    });

    const result = await server.callTool('browser_exec', {
      command: 'open',
      args: ['https://example.com/?q=a b'],
      remote: true,
    });

    expect(runner).toHaveBeenCalledWith(
      ['--remote', 'open', 'https://example.com/?q=a b'],
      expect.objectContaining({
        stdout: expect.any(Object),
        stderr: expect.any(Object),
        max_screenshot_bytes: expect.any(Number),
        max_screenshot_pixels: expect.any(Number),
      })
    );
    expect(result.isError).toBeUndefined();
    expect(textFrom(result)).toBe('Navigated');
  });

  it('validates arguments and reports direct command failures', async () => {
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stderr.write(
        'failed api_key=secret https://example.com/?token=secret\n'
      );
      return 1;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
    });

    const invalid = await server.callTool('browser_exec', {
      command: '',
    });
    const failed = await server.callTool('browser_exec', {
      command: 'open',
      args: ['https://example.com'],
    });

    expect(invalid.isError).toBe(true);
    expect(textFrom(invalid)).toContain('non-empty string');
    expect(failed.isError).toBe(true);
    expect(textFrom(failed)).not.toContain('secret');
    expect(textFrom(failed)).toContain('<redacted>');
  });

  it('bounds large text results', async () => {
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write('x'.repeat(20));
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
      maxOutputChars: 10,
    });

    const result = await server.callTool('browser_exec', {
      command: 'html',
    });

    expect(textFrom(result)).toBe('xxxxxxxxxx\n...[truncated 10 characters]');
  });

  it('bounds and redacts errors thrown outside command output streams', async () => {
    const runner = vi.fn(async () => {
      throw new Error(`api_key=secret ${'x'.repeat(100)}`);
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
      maxOutputChars: 20,
    });

    const result = await server.callTool('browser_exec', {
      command: 'state',
    });

    expect(result.isError).toBe(true);
    expect(textFrom(result)).not.toContain('secret');
    expect(textFrom(result)).toContain('<redacted>');
    expect(textFrom(result)).toContain('...[truncated');
    expect(textFrom(result).length).toBeLessThan(80);
  });

  it('discards command output as soon as the collection budget is exhausted', () => {
    const budget = { remainingChars: 4, omittedChars: 0 };
    const output = createBoundedOutputCollector(budget);

    output.stream.write('abcdef');
    output.stream.write('gh');

    expect(output.value()).toBe('abcd');
    expect(output.truncated()).toBe(true);
    expect(budget).toEqual({ remainingChars: 0, omittedChars: 4 });
  });

  it('shares the text collection budget across stdout and stderr', async () => {
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write('x'.repeat(8));
      options.stderr.write('y'.repeat(8));
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
      maxOutputChars: 10,
    });

    const result = await server.callTool('browser_exec', { command: 'html' });

    expect(textFrom(result)).toBe('xxxxxxxx\ny\n...[truncated 7 characters]');
  });

  it('serializes concurrent browser commands', async () => {
    let active = 0;
    let maxActive = 0;
    const runner = vi.fn(async (_argv: string[], options: any) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      options.stdout.write('ok\n');
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
    });

    await Promise.all([
      server.callTool('browser_exec', { command: 'state' }),
      server.callTool('browser_exec', { command: 'state' }),
    ]);

    expect(maxActive).toBe(1);
  });

  it('returns a full-page screenshot and enforces max_dim', async () => {
    const source = createCanvas(4, 2);
    source.getContext('2d').fillRect(0, 0, 4, 2);
    const screenshot = source.toBuffer('image/png').toString('base64');
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write(`${JSON.stringify({ screenshot })}\n`);
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
    });

    const result = await server.callTool('browser_screenshot', {
      full: true,
      max_dim: 2,
    });

    expect(runner.mock.calls[0]?.[0]).toEqual(['screenshot', '--full']);
    const content = result.content[0];
    expect(content?.type).toBe('image');
    if (content?.type !== 'image') {
      throw new Error('Expected image content');
    }
    const resized = await loadImage(Buffer.from(content.data, 'base64'));
    expect([resized.width, resized.height]).toEqual([2, 1]);
  });

  it('rejects screenshots before decoding when their encoded size is too large', async () => {
    const source = createCanvas(4, 2);
    const screenshot = source.toBuffer('image/png').toString('base64');
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write(JSON.stringify({ screenshot }));
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
      maxScreenshotBytes: 8,
    });

    const result = await server.callTool('browser_screenshot', {});

    expect(result.isError).toBe(true);
    expect(textFrom(result)).toContain('maximum encoded size of 8 bytes');
  });

  it('rejects oversized PNG dimensions before loading the image', async () => {
    const source = createCanvas(4, 2);
    const screenshot = source.toBuffer('image/png').toString('base64');
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write(JSON.stringify({ screenshot }));
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
      maxScreenshotBytes: 1024,
      maxScreenshotPixels: 4,
    });

    const result = await server.callTool('browser_screenshot', {});

    expect(result.isError).toBe(true);
    expect(textFrom(result)).toContain('maximum pixel count of 4');
  });

  it('rechecks the PNG byte limit after canvas resizing', async () => {
    const compactTwoByTwoPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQAAAABazTCJAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC';
    expect(Buffer.from(compactTwoByTwoPng, 'base64')).toHaveLength(69);
    const runner = vi.fn(async (_argv: string[], options: any) => {
      options.stdout.write(JSON.stringify({ screenshot: compactTwoByTwoPng }));
      return 0;
    });
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
      maxScreenshotBytes: 80,
    });

    const result = await server.callTool('browser_screenshot', { max_dim: 1 });

    expect(result.isError).toBe(true);
    expect(textFrom(result)).toContain(
      'maximum encoded size of 80 bytes after resizing'
    );
  });

  it('routes in-memory screenshot requests to the bounded screenshot tool', async () => {
    const runner = vi.fn(async () => 0);
    const server = new CliMCPServer('test', '1.0.0', {
      runDirectCommand: runner,
    });

    const result = await server.callTool('browser_exec', {
      command: 'screenshot',
      args: ['--full'],
    });

    expect(result.isError).toBe(true);
    expect(textFrom(result)).toContain('Use browser_screenshot');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects invalid screenshot dimensions and unknown tools', async () => {
    const server = new CliMCPServer('test', '1.0.0');

    const invalid = await server.callTool('browser_screenshot', {
      max_dim: 0,
    });
    const unknown = await server.callTool('missing', {});

    expect(invalid.isError).toBe(true);
    expect(textFrom(invalid)).toContain('positive integer');
    expect(unknown.isError).toBe(true);
    expect(textFrom(unknown)).toContain('Unknown tool');
  });
});
