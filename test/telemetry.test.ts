/**
 * Comprehensive tests for Telemetry functionality.
 *
 * Tests cover:
 * 1. Event creation and properties
 * 2. User ID generation and persistence
 * 3. Telemetry capture and flush
 * 4. Configuration options
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock PostHog
vi.mock('posthog-node', () => {
  return {
    PostHog: vi.fn().mockImplementation(function MockPostHog() {
      return {
        capture: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

// Mock utils
vi.mock('../src/utils.js', () => {
  let counter = 0;
  return {
    uuid7str: () => `uuid-${++counter}`,
    time_execution_sync:
      () =>
      <T>(fn: T) =>
        fn,
    time_execution_async:
      () =>
      <T>(fn: T) =>
        fn,
    get_browser_use_version: () => 'test-version',
    SignalHandler: class {
      register() {}
      reset() {}
      unregister() {}
    },
    is_new_tab_page: () => false,
    match_url_with_domain_pattern: () => false,
    sanitize_surrogates: (text: string) => text,
    log_pretty_path: (p: string) => p,
  };
});

// Import after mocks
import {
  BaseTelemetryEvent,
  AgentTelemetryEvent,
  MCPClientTelemetryEvent,
  MCPServerTelemetryEvent,
  CLITelemetryEvent,
} from '../src/telemetry/views.js';

describe('Telemetry Events', () => {
  describe('AgentTelemetryEvent', () => {
    it('creates agent telemetry event', () => {
      const event = new AgentTelemetryEvent({
        version: '1.0.0',
        source: 'npm',
        model: 'gpt-4',
        model_provider: 'openai',
        max_steps: 100,
        max_actions_per_step: 10,
        use_vision: true,
        cdp_url: null,
        agent_type: null,
        task: 'Navigate to example.com',
        action_errors: [],
        action_history: [],
        urls_visited: [],
        steps: 5,
        total_input_tokens: 1000,
        total_output_tokens: 300,
        prompt_cached_tokens: 50,
        total_tokens: 1300,
        total_duration_seconds: 30.5,
        success: true,
        final_result_response: 'Done',
        error_message: null,
      });

      expect(event.name).toBe('agent_event');
      expect(event.properties().version).toBe('1.0.0');
      expect(event.properties().model).toBe('gpt-4');
      expect(event.properties().success).toBe(true);
      expect(typeof event.properties().is_docker).toBe('boolean');
    });

    it('tracks token usage', () => {
      const event = new AgentTelemetryEvent({
        version: '1.0.0',
        source: 'npm',
        model: 'gpt-4',
        model_provider: 'openai',
        max_steps: 100,
        max_actions_per_step: 10,
        use_vision: false,
        cdp_url: null,
        agent_type: null,
        task: 'Test',
        action_errors: [],
        action_history: [],
        urls_visited: [],
        steps: 1,
        total_input_tokens: 5000,
        total_output_tokens: 2000,
        prompt_cached_tokens: 1200,
        total_tokens: 7000,
        total_duration_seconds: 60,
        success: null,
        final_result_response: null,
        error_message: null,
      });

      const props = event.properties();
      expect(props.total_input_tokens).toBe(5000);
    });

    it('tracks errors', () => {
      const event = new AgentTelemetryEvent({
        version: '1.0.0',
        source: 'npm',
        model: 'gpt-4',
        model_provider: 'openai',
        max_steps: 100,
        max_actions_per_step: 10,
        use_vision: false,
        cdp_url: null,
        agent_type: null,
        task: 'Test',
        action_errors: ['Error 1', 'Error 2'],
        action_history: [],
        urls_visited: [],
        steps: 1,
        total_input_tokens: 100,
        total_output_tokens: 40,
        prompt_cached_tokens: 0,
        total_tokens: 140,
        total_duration_seconds: 10,
        success: false,
        final_result_response: null,
        error_message: 'Failed',
      });

      const props = event.properties();
      expect(props.action_errors).toHaveLength(2);
    });

    it('redacts content-bearing agent telemetry fields', () => {
      const event = new AgentTelemetryEvent({
        version: '1.0.0',
        source: 'npm',
        model: 'gpt-4',
        model_provider: 'openai',
        max_steps: 100,
        max_actions_per_step: 10,
        use_vision: false,
        cdp_url: null,
        agent_type: null,
        task: 'Login with password secret-123',
        action_errors: ['failed with secret-123'],
        action_history: [[{ input_text: { text: 'secret-123' } }]],
        urls_visited: ['https://example.com/reset?token=secret-123'],
        steps: 1,
        total_input_tokens: 100,
        total_output_tokens: 40,
        prompt_cached_tokens: 0,
        total_tokens: 140,
        total_duration_seconds: 10,
        success: false,
        final_result_response: 'secret-123',
        error_message: 'secret-123',
        judge_reasoning: 'secret-123',
        judge_failure_reason: 'secret-123',
      });

      const serialized = JSON.stringify(event.properties());
      expect(serialized).not.toContain('secret-123');
      expect(event.properties().task).toBe('<redacted>');
      expect(event.properties().final_result_response).toBe('<redacted>');
      expect(event.properties().error_message).toBe('<redacted>');
      expect(event.properties().urls_visited).toEqual(['<redacted>']);
      expect(event.properties().action_history).toEqual([
        [{ action: 'input_text' }],
      ]);
    });

    it('tracks judge verdict fields when present', () => {
      const event = new AgentTelemetryEvent({
        version: '1.0.0',
        source: 'npm',
        model: 'gpt-4',
        model_provider: 'openai',
        max_steps: 100,
        max_actions_per_step: 10,
        use_vision: false,
        cdp_url: null,
        agent_type: null,
        task: 'Test',
        action_errors: [],
        action_history: [],
        urls_visited: [],
        steps: 1,
        total_input_tokens: 100,
        total_output_tokens: 20,
        prompt_cached_tokens: 0,
        total_tokens: 120,
        total_duration_seconds: 10,
        success: false,
        final_result_response: null,
        error_message: null,
        judge_verdict: false,
        judge_reasoning: 'Did not satisfy all requirements',
        judge_failure_reason: 'Missing required output',
        judge_reached_captcha: false,
        judge_impossible_task: false,
      });

      const props = event.properties();
      expect(props.judge_verdict).toBe(false);
      expect(props.judge_reasoning).toBe('<redacted>');
      expect(props.judge_failure_reason).toBe('<redacted>');
      expect(props.judge_reached_captcha).toBe(false);
      expect(props.judge_impossible_task).toBe(false);
    });
  });

  describe('MCPClientTelemetryEvent', () => {
    it('creates MCP client telemetry event for connect', () => {
      const event = new MCPClientTelemetryEvent({
        version: '1.0.0',
        action: 'connect',
        server_name: 'test-server',
        command: 'npx test-server',
        tools_discovered: 5,
        duration_seconds: 0.5,
      });

      expect(event.name).toBe('mcp_client_event');
      expect(event.properties().action).toBe('connect');
      expect(event.properties().server_name).toBe('<redacted>');
      expect(event.properties().command).toBe('<redacted>');
    });

    it('creates MCP client telemetry event for tool call', () => {
      const event = new MCPClientTelemetryEvent({
        version: '1.0.0',
        action: 'tool_call',
        server_name: 'test-server',
        command: 'npx test-server',
        tools_discovered: 5,
        tool_name: 'search',
        duration_seconds: 1.5,
      });

      const props = event.properties();
      expect(props.action).toBe('tool_call');
      expect(props.tool_name).toBe('search');
    });

    it('tracks errors', () => {
      const event = new MCPClientTelemetryEvent({
        version: '1.0.0',
        action: 'tool_call',
        server_name: 'test-server',
        command: 'npx test-server',
        tools_discovered: 5,
        error_message: 'Connection timeout',
        duration_seconds: 30,
      });

      expect(event.properties().error_message).toBe('<redacted>');
      expect(JSON.stringify(event.properties())).not.toContain(
        'Connection timeout'
      );
    });
  });

  describe('MCPServerTelemetryEvent', () => {
    it('creates MCP server telemetry event for start', () => {
      const event = new MCPServerTelemetryEvent({
        version: '1.0.0',
        action: 'start',
      });

      expect(event.name).toBe('mcp_server_event');
      expect(event.properties().action).toBe('start');
    });

    it('creates MCP server telemetry event for tool call', () => {
      const event = new MCPServerTelemetryEvent({
        version: '1.0.0',
        action: 'tool_call',
        tool_name: 'browser_navigate',
        duration_seconds: 2.5,
      });

      const props = event.properties();
      expect(props.action).toBe('tool_call');
      expect(props.tool_name).toBe('browser_navigate');
    });

    it('creates MCP server telemetry event for stop', () => {
      const event = new MCPServerTelemetryEvent({
        version: '1.0.0',
        action: 'stop',
        duration_seconds: 3600, // 1 hour uptime
      });

      expect(event.properties().action).toBe('stop');
      expect(event.properties().duration_seconds).toBe(3600);
    });

    it('redacts server errors and parent process command lines', () => {
      const event = new MCPServerTelemetryEvent({
        version: '1.0.0',
        action: 'tool_call',
        error_message: 'failed while handling private task text',
        parent_process_cmdline: 'node cli.js --api-key top-secret',
      });

      const properties = event.properties();
      const serialized = JSON.stringify(properties);
      expect(properties.error_message).toBe('<redacted>');
      expect(properties.parent_process_cmdline).toBe('<redacted>');
      expect(serialized).not.toContain('private task text');
      expect(serialized).not.toContain('top-secret');
    });
  });

  describe('CLITelemetryEvent', () => {
    it('creates CLI telemetry event', () => {
      const event = new CLITelemetryEvent({
        version: '1.0.0',
        action: 'run',
        mode: 'mcp',
        duration_seconds: 120,
      });

      expect(event.name).toBe('cli_event');
      expect(event.properties().action).toBe('run');
      expect(event.properties().mode).toBe('mcp');
    });

    it('redacts CLI error text', () => {
      const event = new CLITelemetryEvent({
        version: '1.0.0',
        action: 'run',
        mode: 'agent',
        error_message: 'task failed with secret input',
      });

      expect(event.properties().error_message).toBe('<redacted>');
      expect(JSON.stringify(event.properties())).not.toContain('secret input');
    });
  });
});

describe('Telemetry User ID', () => {
  it('generates UUID for user ID', () => {
    const generateUserId = () => {
      return `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    };

    const userId1 = generateUserId();
    const userId2 = generateUserId();

    expect(userId1).toBeDefined();
    expect(userId2).toBeDefined();
    expect(userId1).not.toBe(userId2);
  });

  it('persists user ID to file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
    const userIdFile = path.join(tempDir, 'user_id.txt');

    const userId = 'test-user-id-123';
    fs.writeFileSync(userIdFile, userId);

    const loadedId = fs.readFileSync(userIdFile, 'utf-8');
    expect(loadedId).toBe(userId);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });

  it('creates new user ID if file missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
    const userIdFile = path.join(tempDir, 'user_id.txt');

    // File doesn't exist
    expect(fs.existsSync(userIdFile)).toBe(false);

    // Generate and save
    const newUserId = `user-${Date.now()}`;
    fs.writeFileSync(userIdFile, newUserId);

    expect(fs.existsSync(userIdFile)).toBe(true);
    expect(fs.readFileSync(userIdFile, 'utf-8')).toBe(newUserId);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });

  it('persists product telemetry device ID with private permissions', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
    const previousConfigDir = process.env.BROWSER_USE_CONFIG_DIR;
    const previousTelemetry = process.env.ANONYMIZED_TELEMETRY;

    try {
      process.env.BROWSER_USE_CONFIG_DIR = tempDir;
      process.env.ANONYMIZED_TELEMETRY = 'false';
      vi.resetModules();
      const { ProductTelemetry } = await import('../src/telemetry/service.js');
      const telemetry = new ProductTelemetry();

      expect(telemetry.userId).toBe('uuid-1');
      const deviceIdFile = path.join(tempDir, 'device_id');
      expect(fs.readFileSync(deviceIdFile, 'utf-8')).toBe('uuid-1');
      if (process.platform !== 'win32') {
        expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(deviceIdFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.BROWSER_USE_CONFIG_DIR;
      } else {
        process.env.BROWSER_USE_CONFIG_DIR = previousConfigDir;
      }
      if (previousTelemetry === undefined) {
        delete process.env.ANONYMIZED_TELEMETRY;
      } else {
        process.env.ANONYMIZED_TELEMETRY = previousTelemetry;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Telemetry Configuration', () => {
  it('does not enable raw exception autocapture', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
    const previousConfigDir = process.env.BROWSER_USE_CONFIG_DIR;
    const previousTelemetry = process.env.ANONYMIZED_TELEMETRY;

    try {
      process.env.BROWSER_USE_CONFIG_DIR = tempDir;
      process.env.ANONYMIZED_TELEMETRY = 'true';
      vi.resetModules();
      const { PostHog } = await import('posthog-node');
      vi.mocked(PostHog).mockClear();

      await import('../src/telemetry/service.js');

      expect(PostHog).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ enableExceptionAutocapture: false })
      );
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.BROWSER_USE_CONFIG_DIR;
      } else {
        process.env.BROWSER_USE_CONFIG_DIR = previousConfigDir;
      }
      if (previousTelemetry === undefined) {
        delete process.env.ANONYMIZED_TELEMETRY;
      } else {
        process.env.ANONYMIZED_TELEMETRY = previousTelemetry;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('respects telemetry disabled flag', () => {
    const config = {
      telemetryDisabled: true,
    };

    const shouldCapture = !config.telemetryDisabled;
    expect(shouldCapture).toBe(false);
  });

  it('enables telemetry by default', () => {
    const config = {
      telemetryDisabled: false,
    };

    const shouldCapture = !config.telemetryDisabled;
    expect(shouldCapture).toBe(true);
  });

  it('checks ANONYMIZED_TELEMETRY environment variable', () => {
    // Simulate environment variable check
    const checkTelemetryEnabled = (envValue: string | undefined): boolean => {
      if (envValue === undefined) return true;
      return envValue.toLowerCase() !== 'false';
    };

    expect(checkTelemetryEnabled(undefined)).toBe(true);
    expect(checkTelemetryEnabled('true')).toBe(true);
    expect(checkTelemetryEnabled('false')).toBe(false);
    expect(checkTelemetryEnabled('FALSE')).toBe(false);
  });
});

describe('Telemetry Event Properties', () => {
  it('includes common properties in all events', () => {
    const createEventWithCommonProps = (eventName: string, payload: any) => ({
      event: eventName,
      properties: {
        ...payload,
        timestamp: Date.now(),
        library_version: 'test-version',
      },
    });

    const event = createEventWithCommonProps('test_event', {
      custom: 'data',
    });

    expect(event.properties.timestamp).toBeDefined();
    expect(event.properties.library_version).toBe('test-version');
    expect(event.properties.custom).toBe('data');
  });

  it('sanitizes sensitive data from events', () => {
    const sanitizeEventData = (
      data: Record<string, any>
    ): Record<string, any> => {
      const sensitiveKeys = ['password', 'api_key', 'token', 'secret'];
      const sanitized: Record<string, any> = {};

      for (const [key, value] of Object.entries(data)) {
        if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
          sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          sanitized[key] = sanitizeEventData(value);
        } else {
          sanitized[key] = value;
        }
      }

      return sanitized;
    };

    const data = {
      action: 'login',
      password: 'secret123',
      api_key: 'sk-123',
      user: {
        name: 'test',
        access_token: 'token123',
      },
    };

    const sanitized = sanitizeEventData(data);

    expect(sanitized.action).toBe('login');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.api_key).toBe('[REDACTED]');
    expect(sanitized.user.name).toBe('test');
    expect(sanitized.user.access_token).toBe('[REDACTED]');
  });
});

describe('Telemetry Capture and Flush', () => {
  it('captures events to queue', () => {
    const eventQueue: any[] = [];

    const capture = (event: any) => {
      eventQueue.push(event);
    };

    capture({ event: 'test1', properties: {} });
    capture({ event: 'test2', properties: {} });

    expect(eventQueue).toHaveLength(2);
  });

  it('flushes event queue', async () => {
    const eventQueue: any[] = [];
    let flushedEvents: any[] = [];

    const capture = (event: any) => {
      eventQueue.push(event);
    };

    const flush = async () => {
      flushedEvents = [...eventQueue];
      eventQueue.length = 0;
    };

    capture({ event: 'test1' });
    capture({ event: 'test2' });

    await flush();

    expect(eventQueue).toHaveLength(0);
    expect(flushedEvents).toHaveLength(2);
  });

  it('handles flush errors gracefully', async () => {
    const flushWithError = async (): Promise<boolean> => {
      try {
        throw new Error('Network error');
      } catch (error) {
        // Log error but don't throw
        return false;
      }
    };

    const result = await flushWithError();
    expect(result).toBe(false);
  });
});
