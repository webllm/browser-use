import { describe, expect, it, vi } from 'vitest';
import {
  formatMcpCommandForLog,
  formatMcpToolArgsForLog,
  MCPClient,
  redactMcpLogMessage,
} from '../src/mcp/client.js';
import { Tools } from '../src/tools/service.js';
import { Controller } from '../src/controller/service.js';

describe('MCPClient tools alignment', () => {
  it('registers MCP tools into Tools registry', async () => {
    const client = new MCPClient('test-server', 'node', ['-e', '']);
    (client as any)._connected = true;
    (client as any)._tools = new Map([
      [
        'echo',
        {
          name: 'echo',
          description: 'Echoes the input',
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
        },
      ],
    ]);

    const callToolSpy = vi.spyOn(client, 'callToolResult').mockResolvedValue({
      content: [{ type: 'text', text: 'Echoed from MCP' }],
    });
    const tools = new Tools();

    await client.registerToTools(tools, ['echo'], 'mcp_');

    const registered = tools.registry.get_action('mcp_echo');
    expect(registered).not.toBeNull();

    const actionResult = (await tools.registry.execute_action(
      'mcp_echo',
      { value: 'hello' },
      {}
    )) as any;

    expect(callToolSpy).toHaveBeenCalledWith('echo', { value: 'hello' });
    expect(actionResult.extracted_content).toContain('Echoed from MCP');
  });

  it('reports MCP tool results flagged with isError as failed actions', async () => {
    const client = new MCPClient('test-server', 'node', ['-e', '']);
    (client as any)._connected = true;
    (client as any)._tools = new Map([
      [
        'lookup',
        {
          name: 'lookup',
          description: 'Looks something up',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    ]);
    vi.spyOn(client, 'callToolResult').mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'record not found' }],
    });
    const tools = new Tools();
    await client.registerToTools(tools, ['lookup']);

    const actionResult = (await tools.registry.execute_action(
      'lookup',
      {},
      {}
    )) as any;

    expect(actionResult.success).toBe(false);
    expect(actionResult.error).toBe(
      "MCP tool 'lookup' reported an error: record not found"
    );
    expect(actionResult.extracted_content).toBeNull();
  });

  it('keeps callTool returning only the content blocks', async () => {
    const client = new MCPClient('test-server', 'node', ['-e', '']);
    vi.spyOn(client, 'callToolResult').mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    });

    await expect(client.callTool('echo', {})).resolves.toEqual([
      { type: 'text', text: 'ok' },
    ]);
  });

  it('keeps registerToController as alias to registerToTools', async () => {
    const client = new MCPClient('test-server', 'node', ['-e', '']);
    const controller = new Controller();
    const registerSpy = vi
      .spyOn(client, 'registerToTools')
      .mockResolvedValue(undefined);

    await client.registerToController(controller, ['tool_a'], 'pref_');

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const [targetTools, filter, prefix] = registerSpy.mock.calls[0]!;
    expect((targetTools as any).registry).toBe(controller.registry);
    expect(filter).toEqual(['tool_a']);
    expect(prefix).toBe('pref_');
  });

  it('redacts sensitive MCP tool arguments for debug logs', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const formatted = formatMcpToolArgsForLog({
      username: 'alice',
      password: 'super-secret-password',
      apiKey: 'sk-test',
      headers: {
        authorization: 'Bearer secret-token',
        accept: 'application/json',
      },
      urls: [
        'https://example.com/path?token=secret#frag',
        'data:text/html,<input value=secret>',
        'blob:https://evil.test/uuid',
      ],
      nested: circular,
    });

    expect(formatted).toContain('"username":"alice"');
    expect(formatted).toContain('"accept":"application/json"');
    expect(formatted).toContain(
      '"https://example.com/path?<redacted>#<redacted>"'
    );
    expect(formatted).toContain('"data:<redacted>"');
    expect(formatted).toContain('"blob:https://evil.test/<redacted>"');
    expect(formatted).toContain('"self":"[Circular]"');
    expect(formatted).not.toContain('super-secret-password');
    expect(formatted).not.toContain('sk-test');
    expect(formatted).not.toContain('secret-token');
    expect(formatted).not.toContain('<input value=secret>');
  });

  it('redacts sensitive MCP process arguments for connection logs', () => {
    const formatted = formatMcpCommandForLog('node', [
      'server.js',
      '--api-key',
      'sk-test',
      '--token=secret-token',
      'OPENAI_API_KEY=env-secret',
      '--header',
      'Authorization: Bearer bearer-secret',
      '--url=https://example.com/cb?token=query-secret#frag',
      '--safe',
      'visible',
    ]);

    expect(formatted).toContain('node server.js');
    expect(formatted).toContain('--api-key <redacted>');
    expect(formatted).toContain('--token=<redacted>');
    expect(formatted).toContain('OPENAI_API_KEY=<redacted>');
    expect(formatted).toContain('Authorization:<redacted>');
    expect(formatted).toContain(
      '--url=https://example.com/cb?<redacted>#<redacted>'
    );
    expect(formatted).toContain('--safe visible');
    expect(formatted).not.toContain('sk-test');
    expect(formatted).not.toContain('secret-token');
    expect(formatted).not.toContain('env-secret');
    expect(formatted).not.toContain('bearer-secret');
    expect(formatted).not.toContain('query-secret');
  });

  it('redacts sensitive MCP error messages before logging or telemetry', () => {
    const formatted = redactMcpLogMessage(
      new Error(
        'Request failed api_key=sk-test Authorization: Bearer bearer-secret at https://example.com/callback?token=query-secret#frag data:text/html,<secret>'
      )
    );

    expect(formatted).toContain('api_key=<redacted>');
    expect(formatted).toContain('Authorization:<redacted>');
    expect(formatted).toContain(
      'https://example.com/callback?<redacted>#<redacted>'
    );
    expect(formatted).toContain('data:<redacted>');
    expect(formatted).not.toContain('sk-test');
    expect(formatted).not.toContain('bearer-secret');
    expect(formatted).not.toContain('query-secret');
    expect(formatted).not.toContain('<secret>');
  });
});
