import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockAgentInstances: any[] = [];
const originalConsoleLog = console.log;

vi.mock('../src/config.js', () => ({
  CONFIG: {
    BROWSER_USE_LOGGING_LEVEL: 'info',
    BROWSER_USE_CONFIG_DIR: '/tmp/browser-use-test-config',
    ANONYMIZED_TELEMETRY: false,
  },
  load_browser_use_config: () => ({
    browser_profile: {
      allowed_domains: ['config.example'],
      file_system_path: '~/.browser-use-mcp-test',
      keep_alive: null,
    },
    llm: {
      api_key: 'test-openai-key',
      model: 'gpt-4o-mini',
      temperature: 0.5,
    },
  }),
  get_default_profile: (config: any) => config.browser_profile ?? {},
  get_default_llm: (config: any) => config.llm ?? {},
}));

vi.mock('../src/controller/service.js', () => {
  class Controller {
    registry = {
      get_all_actions: () => new Map(),
      execute_action: vi.fn(async () => ({ ok: true })),
    };
  }
  return { Controller };
});

vi.mock('../src/browser/profile.js', () => {
  class BrowserProfile {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown> = {}) {
      this.config = config;
    }
  }
  return { BrowserProfile };
});

vi.mock('../src/browser/session.js', () => {
  class BrowserSession {
    initialized = true;
    browser_profile: any;
    id = 'session-test';
    downloaded_files: string[] = [];
    constructor(init: any = {}) {
      this.browser_profile = init.browser_profile ?? { config: {} };
    }
    async start() {}
    async stop() {
      this.initialized = false;
    }
    async kill() {
      this.initialized = false;
    }
  }
  return { BrowserSession };
});

vi.mock('../src/filesystem/file-system.js', () => {
  class FileSystem {
    constructor(_baseDir: string) {}
  }
  return { FileSystem };
});

vi.mock('../src/agent/service.js', () => {
  class Agent {
    params: any;
    runMaxSteps: number | null = null;
    constructor(params: any) {
      this.params = params;
      mockAgentInstances.push(this);
    }

    async run(maxSteps: number) {
      this.runMaxSteps = maxSteps;
      return {
        history: [{}, {}],
        number_of_steps: () => 2,
        is_successful: () => true,
        final_result: () => 'Retry completed',
        errors: () => [null, null],
        urls: () => ['https://example.com'],
      };
    }

    async close() {}
  }
  return { Agent };
});

import { MCPServer } from '../src/mcp/server.js';
import { BrowserStateRequestEvent } from '../src/browser/events.js';

describe('MCPServer browser_click new_tab', () => {
  it('does not redirect console output at module import time', () => {
    expect(console.log).toBe(originalConsoleLog);
  });

  it('marks read-only tools with readOnlyHint annotations', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const tools = (server as any).tools as Record<string, any>;

    for (const name of [
      'browser_get_state',
      'browser_list_tabs',
      'browser_list_sessions',
    ]) {
      expect(tools[name]?.annotations).toEqual({ readOnlyHint: true });
    }
    for (const name of ['browser_navigate', 'browser_click', 'browser_type']) {
      expect(tools[name]?.annotations).toBeUndefined();
    }

    const listHandler = (server as any).server?._requestHandlers?.get(
      'tools/list'
    );
    if (listHandler) {
      const listed = await listHandler(
        { method: 'tools/list', params: {} },
        {}
      );
      const getState = listed.tools.find(
        (tool: any) => tool.name === 'browser_get_state'
      );
      expect(getState.annotations).toEqual({ readOnlyHint: true });
    }
  });

  it('opens href targets in a new tab and reports tab index', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const createNewTab = vi.fn(async () => ({}));
    const browserSession = {
      initialized: true,
      start: vi.fn(),
      get_dom_element_by_index: vi.fn(async () => ({
        attributes: { href: '/next' },
      })),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com/current',
      })),
      create_new_tab: createNewTab,
      active_tab_index: 2,
    };

    (server as any).ensureBrowserSession = vi.fn(async () => browserSession);
    (server as any).executeControllerAction = vi.fn(async () => 'fallback');

    const result = await (server as any).tools.browser_click.handler({
      index: 7,
      new_tab: true,
    });

    expect(createNewTab).toHaveBeenCalledWith('https://example.com/next');
    expect(result).toContain('new tab #2');
    expect((server as any).executeControllerAction).not.toHaveBeenCalled();
  });

  it('uses modifier click for non-link elements when new_tab=true', async () => {
    vi.useFakeTimers();
    try {
      const server = new MCPServer('test-mcp', '1.0.0');
      const locatorClick = vi.fn(async () => undefined);
      const pageBeforeClick = { url: () => 'https://example.com/start' };
      const pageAfterClick = { url: () => 'https://example.com/after' };
      const validatePageAfterAction = vi.fn(async () => undefined);
      const browserSession = {
        initialized: true,
        start: vi.fn(),
        get_dom_element_by_index: vi.fn(async () => ({
          attributes: {},
        })),
        get_current_page: vi
          .fn()
          .mockResolvedValueOnce(pageBeforeClick)
          .mockResolvedValueOnce(pageAfterClick),
        get_locate_element: vi.fn(async () => ({
          click: locatorClick,
        })),
        validate_page_after_action: validatePageAfterAction,
      };

      (server as any).ensureBrowserSession = vi.fn(async () => browserSession);
      (server as any).executeControllerAction = vi.fn(async () => 'fallback');

      const handlerPromise = (server as any).tools.browser_click.handler({
        index: 9,
        new_tab: true,
      });
      await vi.advanceTimersByTimeAsync(500);
      const result = await handlerPromise;

      const expectedModifier =
        process.platform === 'darwin' ? 'Meta' : 'Control';
      expect(locatorClick).toHaveBeenCalledWith({
        modifiers: [expectedModifier],
      });
      expect(validatePageAfterAction).toHaveBeenCalledWith(pageAfterClick);
      expect(result).toContain('new tab if supported');
      expect((server as any).executeControllerAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MCPServer browser_get_state', () => {
  it('returns enriched browser state fields for events/network/pagination/popups', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const browserSession = {
      initialized: true,
      start: vi.fn(),
      get_browser_state_with_recovery: vi.fn(async () => ({
        url: 'https://example.com/list',
        title: 'List',
        tabs: [],
        page_info: null,
        pixels_above: 0,
        pixels_below: 0,
        browser_errors: [],
        loading_status: null,
        recent_events:
          '[{"event_type":"tab_switched","timestamp":"2026-01-01T00:00:00Z"}]',
        pending_network_requests: [
          {
            url: 'https://example.com/api/items',
            method: 'GET',
            loading_duration_ms: 150,
            resource_type: 'fetch',
          },
        ],
        pagination_buttons: [
          {
            button_type: 'next',
            backend_node_id: 8,
            text: 'Next',
            selector: '/html/body/nav/button[2]',
            is_disabled: false,
          },
        ],
        closed_popup_messages: ['[alert] Session expired soon'],
        screenshot: null,
        element_tree: {
          clickable_elements_to_string: () => '',
        },
        selector_map: {},
      })),
    };

    (server as any).ensureBrowserSession = vi.fn(async () => browserSession);

    const result = await (server as any).tools.browser_get_state.handler({
      include_screenshot: false,
    });

    expect(result.recent_events).toContain('tab_switched');
    expect(result.pending_network_requests).toHaveLength(1);
    expect(result.pagination_buttons).toHaveLength(1);
    expect(result.closed_popup_messages).toEqual([
      '[alert] Session expired soon',
    ]);
  });

  it('forwards include_recent_events option to browser session', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const getState = vi.fn(async () => ({
      url: 'https://example.com',
      title: 'Example',
      tabs: [],
      page_info: null,
      pixels_above: 0,
      pixels_below: 0,
      browser_errors: [],
      loading_status: null,
      recent_events: null,
      pending_network_requests: [],
      pagination_buttons: [],
      closed_popup_messages: [],
      screenshot: null,
      element_tree: {
        clickable_elements_to_string: () => '',
      },
      selector_map: {},
    }));
    const browserSession = {
      initialized: true,
      start: vi.fn(),
      get_browser_state_with_recovery: getState,
    };
    (server as any).ensureBrowserSession = vi.fn(async () => browserSession);

    await (server as any).tools.browser_get_state.handler({
      include_screenshot: false,
      include_recent_events: true,
    });

    expect(getState).toHaveBeenCalledWith({
      include_screenshot: false,
      include_recent_events: true,
      cache_clickable_elements_hashes: true,
    });
  });

  it('dispatches BrowserStateRequestEvent when browser event bus is available', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const dispatchSpy = vi.fn(
      async (event: BrowserStateRequestEvent) =>
        ({
          event: {
            event_result: {
              url: 'https://event.example',
              title: 'From Event',
              tabs: [],
              page_info: null,
              pixels_above: 0,
              pixels_below: 0,
              browser_errors: [],
              loading_status: null,
              recent_events: null,
              pending_network_requests: [],
              pagination_buttons: [],
              closed_popup_messages: [],
              screenshot: null,
              element_tree: {
                clickable_elements_to_string: () => '',
              },
              selector_map: {},
            },
            event_name: 'BrowserStateRequestEvent',
          },
          handler_results: [{ handler_id: 'watchdog', result: null }],
          errors: [],
        }) as any
    );
    const getState = vi.fn(async () => {
      throw new Error('fallback should not execute');
    });
    const browserSession = {
      initialized: true,
      start: vi.fn(),
      dispatch_browser_event: dispatchSpy,
      get_browser_state_with_recovery: getState,
    };
    (server as any).ensureBrowserSession = vi.fn(async () => browserSession);

    const result = await (server as any).tools.browser_get_state.handler({
      include_screenshot: false,
      include_recent_events: true,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchedEvent = dispatchSpy.mock.calls[0]?.[0];
    expect(dispatchedEvent).toBeInstanceOf(BrowserStateRequestEvent);
    expect(dispatchedEvent.include_recent_events).toBe(true);
    expect(getState).not.toHaveBeenCalled();
    expect(result.url).toBe('https://event.example');
    expect(result.title).toBe('From Event');
  });

  it('formats browser_get_state screenshots as MCP ImageContent blocks', () => {
    const server = new MCPServer('test-mcp', '1.0.0');

    const formatted = (server as any).formatToolResult('browser_get_state', {
      url: 'https://example.com',
      title: 'Example',
      tabs: [],
      page_info: {
        viewport_width: 1280,
        viewport_height: 720,
      },
      pixels_above: 0,
      pixels_below: 0,
      browser_errors: [],
      loading_status: null,
      recent_events: null,
      pending_network_requests: [],
      pagination_buttons: [],
      closed_popup_messages: [],
      screenshot: 'base64png',
      interactive_elements: '',
      interactive_count: 0,
    });

    expect(formatted.content).toHaveLength(2);
    expect(formatted.content[0]).toMatchObject({ type: 'text' });
    expect(formatted.content[1]).toEqual({
      type: 'image',
      data: 'base64png',
      mimeType: 'image/png',
    });

    const textPayload = JSON.parse(
      (formatted.content[0] as { type: 'text'; text: string }).text
    );
    expect(textPayload.screenshot).toBeUndefined();
    expect(textPayload.screenshot_dimensions).toEqual({
      width: 1280,
      height: 720,
    });
  });
});

describe('MCPServer tab tools parameter routing', () => {
  it('routes browser_switch_tab tab_id to switch_tab action tab_id', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const executeAction = vi.fn(async () => 'ok');
    (server as any).executeControllerAction = executeAction;

    await (server as any).tools.browser_switch_tab.handler({
      tab_id: '0007',
    });

    expect(executeAction).toHaveBeenCalledWith('switch_tab', {
      tab_id: '0007',
    });
  });

  it('routes browser_close_tab legacy tab_index to close_tab action page_id', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const executeAction = vi.fn(async () => 'ok');
    (server as any).executeControllerAction = executeAction;

    await (server as any).tools.browser_close_tab.handler({
      tab_index: 3,
    });

    expect(executeAction).toHaveBeenCalledWith('close_tab', {
      page_id: 3,
    });
  });
});

describe('MCPServer retry_with_browser_use_agent', () => {
  it('runs retry tool with isolated session/profile and returns summary', async () => {
    mockAgentInstances.length = 0;
    const server = new MCPServer('test-mcp', '1.0.0');

    const result = await (
      server as any
    ).tools.retry_with_browser_use_agent.handler({
      task: 'Try task again',
      max_steps: 7,
      model: 'gpt-4o',
      allowed_domains: ['retry.example'],
      use_vision: false,
    });

    expect(result).toContain('Task completed in 2 steps');
    expect(result).toContain('Success: true');
    expect(result).toContain('Final result');
    expect(result).toContain('URLs visited: https://example.com');

    expect(mockAgentInstances.length).toBe(1);
    const instance = mockAgentInstances[0];
    expect(instance.params.task).toBe('Try task again');
    expect(instance.params.use_vision).toBe(false);
    expect(
      instance.params.browser_session.browser_profile.config.allowed_domains
    ).toEqual(['config.example']);
    expect(
      instance.params.browser_session.browser_profile.config.keep_alive
    ).toBe(false);
    expect(instance.runMaxSteps).toBe(7);
  });

  it('uses retry allowed_domains when no defaults are configured', async () => {
    mockAgentInstances.length = 0;
    const server = new MCPServer('test-mcp', '1.0.0');
    (server as any).config = {
      browser_profile: {},
      llm: {
        api_key: 'test-openai-key',
        model: 'gpt-4o-mini',
      },
    };

    await (server as any).tools.retry_with_browser_use_agent.handler({
      task: 'Retry with domain input',
      allowed_domains: ['retry.example'],
    });

    expect(mockAgentInstances.length).toBe(1);
    const instance = mockAgentInstances[0];
    expect(
      instance.params.browser_session.browser_profile.config.allowed_domains
    ).toEqual(['retry.example']);
  });

  it('preserves configured allowed_domains when retry argument is omitted', async () => {
    mockAgentInstances.length = 0;
    const server = new MCPServer('test-mcp', '1.0.0');
    (server as any).config = {
      browser_profile: {
        allowed_domains: ['admin.example'],
      },
      llm: {},
    };

    await (server as any).tools.retry_with_browser_use_agent.handler({
      task: 'Retry without domain override input',
    });

    expect(mockAgentInstances.length).toBe(1);
    const instance = mockAgentInstances[0];
    expect(
      instance.params.browser_session.browser_profile.config.allowed_domains
    ).toEqual(['admin.example']);
    expect(instance.runMaxSteps).toBe(100);
  });

  it('does not let explicit empty allowed_domains wipe configured defaults', async () => {
    mockAgentInstances.length = 0;
    const server = new MCPServer('test-mcp', '1.0.0');
    (server as any).config = {
      browser_profile: {
        allowed_domains: ['admin.example'],
      },
      llm: {},
    };

    await (server as any).tools.retry_with_browser_use_agent.handler({
      task: 'Retry without domain override input',
      allowed_domains: [],
    });

    expect(mockAgentInstances.length).toBe(1);
    const instance = mockAgentInstances[0];
    expect(
      instance.params.browser_session.browser_profile.config.allowed_domains
    ).toEqual(['admin.example']);
  });

  it('does not let retry allowed_domains broaden configured defaults', async () => {
    mockAgentInstances.length = 0;
    const server = new MCPServer('test-mcp', '1.0.0');
    (server as any).config = {
      browser_profile: {
        allowed_domains: ['admin.example'],
      },
      llm: {},
    };

    await (server as any).tools.retry_with_browser_use_agent.handler({
      task: 'Retry with attempted domain override',
      allowed_domains: ['evil.example'],
    });

    expect(mockAgentInstances.length).toBe(1);
    const instance = mockAgentInstances[0];
    expect(
      instance.params.browser_session.browser_profile.config.allowed_domains
    ).toEqual(['admin.example']);
  });

  it('uses configured default model when model argument is omitted', async () => {
    mockAgentInstances.length = 0;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';

    try {
      const server = new MCPServer('test-mcp', '1.0.0');

      await (server as any).tools.retry_with_browser_use_agent.handler({
        task: 'Retry with configured default model',
      });

      expect(mockAgentInstances.length).toBe(1);
      const instance = mockAgentInstances[0];
      expect(instance.params.llm.provider).toBe('openai');
      expect(instance.params.llm.model).toBe('gpt-4o-mini');
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
    }
  });

  it('supports non-openai models via shared llm factory', async () => {
    mockAgentInstances.length = 0;
    const previousBrowserUseApiKey = process.env.BROWSER_USE_API_KEY;
    process.env.BROWSER_USE_API_KEY = 'test-browser-use-key';

    try {
      const server = new MCPServer('test-mcp', '1.0.0');
      (server as any).config = {
        browser_profile: {},
        llm: { model: 'bu-2-0' },
      };

      await (server as any).tools.retry_with_browser_use_agent.handler({
        task: 'Run with browser-use model',
        model: 'bu-2-0',
      });

      expect(mockAgentInstances.length).toBe(1);
      const instance = mockAgentInstances[0];
      expect(instance.params.llm.provider).toBe('browser-use');
      expect(instance.params.llm.model).toBe('bu-2-0');
    } finally {
      if (previousBrowserUseApiKey === undefined) {
        delete process.env.BROWSER_USE_API_KEY;
      } else {
        process.env.BROWSER_USE_API_KEY = previousBrowserUseApiKey;
      }
    }
  });

  it('does not seed OPENAI_API_KEY from placeholder llm config values', () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const server = new MCPServer('test-mcp', '1.0.0');

      (server as any).seedOpenAiApiKeyFromConfig({
        api_key: 'your-openai-api-key-here',
      });
      expect(process.env.OPENAI_API_KEY).toBeUndefined();

      (server as any).seedOpenAiApiKeyFromConfig({
        api_key: 'real-openai-key',
      });
      expect(process.env.OPENAI_API_KEY).toBe('real-openai-key');
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
    }
  });

  it('redacts sensitive tool errors returned by the MCP call handler', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    server.registerTool(
      'leaky_tool',
      'Throws a sensitive error',
      z.object({}).strict(),
      async () => {
        throw new Error(
          'failed api_key=sk-test Authorization: Bearer bearer-secret https://example.com/cb?token=query-secret#frag'
        );
      }
    );

    const handler = (server as any).server._requestHandlers.get('tools/call');
    const result = await handler({
      method: 'tools/call',
      params: { name: 'leaky_tool', arguments: {} },
    });
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).toContain('api_key=<redacted>');
    expect(text).toContain('Authorization:<redacted>');
    expect(text).toContain('https://example.com/cb?<redacted>#<redacted>');
    expect(text).not.toContain('sk-test');
    expect(text).not.toContain('bearer-secret');
    expect(text).not.toContain('query-secret');
  });

  it('returns explicit error when configured model credentials are missing', async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const server = new MCPServer('test-mcp', '1.0.0');
      (server as any).config = {
        browser_profile: {},
        llm: {},
      };

      const result = await (
        server as any
      ).tools.retry_with_browser_use_agent.handler({
        task: 'Try task again',
      });

      expect(result).toContain('Error: Failed to initialize LLM');
      expect(result).toContain('OPENAI_API_KEY');
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
    }
  });
});

describe('MCPServer session management tools', () => {
  it('lists tracked sessions from direct tools lifecycle', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');

    await (server as any).ensureBrowserSession();
    const sessions = await (server as any).tools.browser_list_sessions.handler(
      {}
    );

    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]).toMatchObject({
      session_id: 'session-test',
      active: true,
      current_session: true,
    });
  });

  it('closes a specific tracked session and clears active browser session reference', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const kill = vi.fn(async () => undefined);
    const session = {
      id: 'session-a',
      initialized: true,
      kill,
    };

    (server as any).activeSessions = new Map([
      [
        'session-a',
        {
          session,
          created_at: 1,
          last_activity: 1,
        },
      ],
    ]);
    (server as any).browserSession = session;

    const result = await (server as any).tools.browser_close_session.handler({
      session_id: 'session-a',
    });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      session_id: 'session-a',
      closed: true,
    });
    expect((server as any).browserSession).toBeNull();
    expect((server as any).activeSessions.size).toBe(0);
  });

  it('closes all tracked sessions and returns aggregate summary', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const killA = vi.fn(async () => undefined);
    const killB = vi.fn(async () => undefined);
    const sessionA = {
      id: 'session-a',
      initialized: true,
      kill: killA,
    };
    const sessionB = {
      id: 'session-b',
      initialized: true,
      kill: killB,
    };

    (server as any).activeSessions = new Map([
      [
        'session-a',
        {
          session: sessionA,
          created_at: 1,
          last_activity: 1,
        },
      ],
      [
        'session-b',
        {
          session: sessionB,
          created_at: 2,
          last_activity: 2,
        },
      ],
    ]);

    const result = await (server as any).tools.browser_close_all.handler({});

    expect(killA).toHaveBeenCalledTimes(1);
    expect(killB).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      closed_count: 2,
      total_count: 2,
    });
    expect((server as any).activeSessions.size).toBe(0);
  });

  it('auto-closes sessions that exceed inactivity timeout during cleanup', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const now = Date.now() / 1000;
    const killExpired = vi.fn(async () => undefined);
    const killActive = vi.fn(async () => undefined);
    const expiredSession = {
      id: 'session-expired',
      initialized: true,
      kill: killExpired,
    };
    const activeSession = {
      id: 'session-active',
      initialized: true,
      kill: killActive,
    };

    (server as any).sessionTimeoutMinutes = 1;
    (server as any).activeSessions = new Map([
      [
        'session-expired',
        {
          session: expiredSession,
          created_at: now - 360,
          last_activity: now - 120,
        },
      ],
      [
        'session-active',
        {
          session: activeSession,
          created_at: now - 60,
          last_activity: now - 10,
        },
      ],
    ]);

    await (server as any).cleanupExpiredSessions();

    expect(killExpired).toHaveBeenCalledTimes(1);
    expect(killActive).not.toHaveBeenCalled();
    expect((server as any).activeSessions.has('session-expired')).toBe(false);
    expect((server as any).activeSessions.has('session-active')).toBe(true);
  });
});
