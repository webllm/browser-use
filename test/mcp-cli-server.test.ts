import { createCanvas, loadImage } from 'canvas';
import { describe, expect, it, vi } from 'vitest';
import { CliMCPServer } from '../src/mcp/cli-server.js';

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
