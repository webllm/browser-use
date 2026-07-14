import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import {
  ActionResult,
  AgentOutput,
  AgentState,
  AgentStepInfo,
} from '../src/agent/views.js';
import {
  ModelOutputTruncatedError,
  ModelProviderError,
  ModelRateLimitError,
} from '../src/llm/exceptions.js';
import { UserMessage } from '../src/llm/messages.js';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';
import { DEFAULT_FILE_SYSTEM_PATH } from '../src/filesystem/file-system.js';
import { Controller } from '../src/controller/service.js';
import {
  BrowserError,
  BrowserStateSummary,
  PLACEHOLDER_4PX_SCREENSHOT,
} from '../src/browser/views.js';
import {
  DEFAULT_INCLUDE_ATTRIBUTES,
  DOMElementNode,
  DOMState,
} from '../src/dom/views.js';
import { HistoryTreeProcessor } from '../src/dom/history-tree-processor/service.js';

const createLlm = (model = 'gpt-test', provider = 'test'): BaseChatModel =>
  ({
    model,
    get provider() {
      return provider;
    },
    get name() {
      return 'test';
    },
    get model_name() {
      return 'gpt-test';
    },
    ainvoke: vi.fn(async () => ({ completion: 'ok', usage: null })),
  }) as unknown as BaseChatModel;

const createBrowserStateSummary = (
  overrides: Partial<{
    url: string;
    title: string;
    tabs: Array<{ page_id: number; url: string; title: string }>;
    screenshot: string | null;
  }> = {}
) => {
  const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
  const domState = new DOMState(root, {});
  return new BrowserStateSummary(domState, {
    url: overrides.url ?? 'https://example.com',
    title: overrides.title ?? 'Example',
    tabs: overrides.tabs ?? [
      { page_id: 0, url: 'https://example.com', title: 'Example' },
    ],
    screenshot:
      overrides.screenshot === undefined
        ? PLACEHOLDER_4PX_SCREENSHOT
        : overrides.screenshot,
  });
};

describe('Agent constructor browser session alignment', () => {
  it('creates BrowserSession from page/context when browser_session is omitted', async () => {
    const fakeContext = { id: 'ctx-1' };
    const fakePage = {
      context: () => fakeContext,
    } as any;

    const agent = new Agent({
      task: 'test auto session from page',
      llm: createLlm(),
      page: fakePage,
    });

    expect(agent.browser_session).toBeInstanceOf(BrowserSession);
    expect(agent.browser_session?.agent_current_page).toBe(fakePage);
    expect(agent.browser_session?.browser_context).toBe(fakeContext);
    expect(agent.browser_session?.id.slice(-4)).toBe(agent.id.slice(-4));

    await agent.close();
  });

  it('accepts BrowserSession passed via browser parameter', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const agent = new Agent({
      task: 'test browser as session',
      llm: createLlm(),
      browser: browserSession,
    });

    expect(agent.browser_session).toBe(browserSession);

    await agent.close();
  });

  it('defaults file_system_path to agent_directory when not provided (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'default file system directory',
      llm: createLlm(),
    });

    const fileSystemDir = (agent as any).file_system?.get_dir?.();
    expect(fileSystemDir).toBe(
      `${agent.agent_directory}/${DEFAULT_FILE_SYSTEM_PATH}`
    );
    expect((agent as any)._file_system_path).toBe(agent.agent_directory);
    if (process.platform !== 'win32') {
      expect(fs.statSync(agent.agent_directory).mode & 0o777).toBe(0o700);
    }

    await agent.close();
  });

  it('accepts tools as an alias of controller (python c011 parity)', async () => {
    const tools = new Controller();

    const agent = new Agent({
      task: 'tools alias controller',
      llm: createLlm(),
      tools: tools as any,
    });

    expect(agent.controller).toBe(tools);

    await agent.close();
  });

  it('throws when tools and controller are both provided (python c011 parity)', () => {
    const tools = new Controller();
    const controller = new Controller();

    expect(
      () =>
        new Agent({
          task: 'tools/controller conflict',
          llm: createLlm(),
          tools: tools as any,
          controller: controller as any,
        })
    ).toThrow(/Cannot specify both "tools" and "controller"/);
  });

  it('auto-enables flash mode for browser-use provider and disables planning', async () => {
    const agent = new Agent({
      task: 'browser-use provider flash mode',
      llm: createLlm('browser-use/agent', 'browser-use'),
      flash_mode: false,
      enable_planning: true,
    });

    expect(agent.settings.flash_mode).toBe(true);
    expect(agent.settings.enable_planning).toBe(false);

    await agent.close();
  });

  it('uses python-aligned default include_attributes when not provided', async () => {
    const agent = new Agent({
      task: 'default include attributes',
      llm: createLlm(),
    });

    expect(agent.settings.include_attributes).toEqual(
      DEFAULT_INCLUDE_ATTRIBUTES
    );

    await agent.close();
  });

  it('resolves llm from DEFAULT_LLM when constructor llm is omitted', async () => {
    const previousDefaultLlm = process.env.DEFAULT_LLM;
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.DEFAULT_LLM = 'openai_gpt_4o';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    try {
      const agent = new Agent({
        task: 'default llm from env',
      });

      expect(agent.llm.provider).toBe('openai');
      expect(agent.llm.model).toBe('gpt-4o');

      await agent.close();
    } finally {
      if (previousDefaultLlm === undefined) {
        delete process.env.DEFAULT_LLM;
      } else {
        process.env.DEFAULT_LLM = previousDefaultLlm;
      }
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
    }
  });

  it('falls back to ChatBrowserUse when DEFAULT_LLM is not set', async () => {
    const previousDefaultLlm = process.env.DEFAULT_LLM;
    const previousBrowserUseApiKey = process.env.BROWSER_USE_API_KEY;
    delete process.env.DEFAULT_LLM;
    process.env.BROWSER_USE_API_KEY = 'test-browser-use-key';

    try {
      const agent = new Agent({
        task: 'fallback browser-use llm',
      });

      expect(agent.llm.provider).toBe('browser-use');
      expect(agent.llm.model).toBe('bu-2-0');
      expect(agent.settings.flash_mode).toBe(true);
      expect(agent.settings.enable_planning).toBe(false);

      await agent.close();
    } finally {
      if (previousDefaultLlm === undefined) {
        delete process.env.DEFAULT_LLM;
      } else {
        process.env.DEFAULT_LLM = previousDefaultLlm;
      }
      if (previousBrowserUseApiKey === undefined) {
        delete process.env.BROWSER_USE_API_KEY;
      } else {
        process.env.BROWSER_USE_API_KEY = previousBrowserUseApiKey;
      }
    }
  });

  it('uses 500 max_steps by default when run() omits max_steps', async () => {
    const agent = new Agent({
      task: 'default max steps',
      llm: createLlm(),
    });
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});

    agent.state.stopped = true;
    await agent.run();

    const lastCall = logAgentEventSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(500);

    await agent.close();
  });

  it.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])(
    'rejects invalid run max_steps %s',
    async (maxSteps) => {
      const agent = new Agent({
        task: 'invalid run budget',
        llm: createLlm(),
      });
      try {
        await expect(agent.run(maxSteps)).rejects.toThrow(/max_steps/);
      } finally {
        await agent.close();
      }
    }
  );

  it('rejects invalid resumed step counters before starting a run', async () => {
    const agent = new Agent({
      task: 'invalid resumed state',
      llm: createLlm(),
    });
    agent.state.n_steps = Number.POSITIVE_INFINITY;
    try {
      await expect(agent.run()).rejects.toThrow(/state\.n_steps/);
    } finally {
      await agent.close();
    }
  });

  it('starts browser session for active runs (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'start browser session on run',
      llm: createLlm(),
    });
    const startSpy = vi
      .spyOn(agent.browser_session as any, 'start')
      .mockResolvedValue(undefined);
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});
    const stepSpy = vi
      .spyOn(agent as any, '_step')
      .mockImplementation(async () => {
        agent.state.stopped = true;
      });

    await agent.run(1);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stepSpy).toHaveBeenCalledTimes(1);

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('stops cleanly before step execution when register_should_stop_callback returns true (python c011 parity)', async () => {
    const shouldStopCallback = vi.fn(async () => true);
    const agent = new Agent({
      task: 'stop via external callback',
      llm: createLlm(),
      register_should_stop_callback: shouldStopCallback,
    });

    const infoSpy = vi.spyOn(agent.logger, 'info');
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});
    const stepSpy = vi.spyOn(agent as any, '_step');

    await agent.run(1);

    expect(shouldStopCallback).toHaveBeenCalledTimes(1);
    expect(stepSpy).not.toHaveBeenCalled();
    expect(agent.state.stopped).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith('External callback requested stop');

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('ignores InterruptedError raised during initial_actions and stops gracefully (python c011 parity)', async () => {
    const shouldStopCallback = vi.fn(async () => true);
    const agent = new Agent({
      task: 'stop during initial actions',
      llm: createLlm(),
      register_should_stop_callback: shouldStopCallback,
      initial_actions: [{ wait: { seconds: 0 } }],
    });

    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});
    const stepSpy = vi.spyOn(agent as any, '_step');

    await expect(agent.run(1)).resolves.toBeDefined();

    expect(shouldStopCallback).toHaveBeenCalled();
    expect(stepSpy).not.toHaveBeenCalled();
    expect(agent.state.stopped).toBe(true);

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('dispatches CreateAgentSessionEvent only once across multiple run calls (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'single session event across runs',
      llm: createLlm(),
    });
    const dispatchSpy = vi.spyOn(agent.eventbus, 'dispatch');
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});

    agent.state.stopped = true;
    await agent.run(1);
    agent.state.stopped = true;
    await agent.run(1);

    const sessionEventCount = dispatchSpy.mock.calls.filter(
      ([event]) => (event as any)?.event_type === 'CreateAgentSessionEvent'
    ).length;
    const taskEventCount = dispatchSpy.mock.calls.filter(
      ([event]) => (event as any)?.event_type === 'CreateAgentTaskEvent'
    ).length;

    expect(sessionEventCount).toBe(1);
    expect(taskEventCount).toBe(2);
    expect(agent.state.session_initialized).toBe(true);

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('uses python c011 failure log escalation in _handle_step_error', async () => {
    const agent = new Agent({
      task: 'step error escalation',
      llm: createLlm(),
      max_failures: 2,
      final_response_after_failure: false,
    });
    const warningSpy = vi
      .spyOn((agent as any).logger, 'warning')
      .mockImplementation(() => {});
    const errorSpy = vi
      .spyOn((agent as any).logger, 'error')
      .mockImplementation(() => {});

    await (agent as any)._handle_step_error(new Error('first failure'));
    await (agent as any)._handle_step_error(new Error('second failure'));

    expect(agent.state.consecutive_failures).toBe(2);
    expect(
      warningSpy.mock.calls.some(([message]) =>
        String(message).includes('❌ Result failed 1/2 times:')
      )
    ).toBe(true);
    expect(
      errorSpy.mock.calls.some(([message]) =>
        String(message).includes('❌ Result failed 2/2 times:')
      )
    ).toBe(true);
    expect(agent.state.last_result?.[0]?.error).toContain('second failure');

    await agent.close();
  });

  it('redacts sensitive_data in step error logs', async () => {
    const agent = new Agent({
      task: 'step error secret redaction',
      llm: createLlm(),
      max_failures: 1,
      sensitive_data: {
        password: 'super-secret-value',
      },
    });
    const errorSpy = vi
      .spyOn((agent as any).logger, 'error')
      .mockImplementation(() => {});
    const warningSpy = vi
      .spyOn((agent as any).logger, 'warning')
      .mockImplementation(() => {});

    await (agent as any)._handle_step_error(
      new Error('failed with super-secret-value')
    );

    const logs = [...errorSpy.mock.calls, ...warningSpy.mock.calls]
      .map(([message]) => String(message))
      .join('\n');
    expect(logs).not.toContain('super-secret-value');
    expect(logs).toContain('<secret>password</secret>');
    expect(agent.state.last_result?.[0]?.error).toContain('super-secret-value');

    await agent.close();
  });

  it('uses InterruptedError semantics for stop/pause guards and step-error handling (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'interrupted guard semantics',
      llm: createLlm(),
    });
    const warningSpy = vi
      .spyOn((agent as any).logger, 'warning')
      .mockImplementation(() => {});

    agent.state.stopped = true;
    await expect(
      (agent as any)._raise_if_stopped_or_paused()
    ).rejects.toMatchObject({
      name: 'InterruptedError',
      message: 'Agent stopped',
    });

    agent.state.stopped = false;
    agent.state.paused = true;
    await expect(
      (agent as any)._raise_if_stopped_or_paused()
    ).rejects.toMatchObject({
      name: 'InterruptedError',
      message: 'Agent paused',
    });

    agent.state.paused = false;
    const interrupted = new Error('Agent paused');
    interrupted.name = 'InterruptedError';
    await (agent as any)._handle_step_error(interrupted);
    expect(agent.state.consecutive_failures).toBe(0);
    expect(agent.state.last_result).toBeNull();
    expect(
      warningSpy.mock.calls.some(([message]) =>
        String(message).includes(
          'The agent was interrupted mid-step - Agent paused'
        )
      )
    ).toBe(true);

    await agent.close();
  });

  it('does not apply legacy retry_delay sleeps in _handle_step_error (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'rate-limit step error parity',
      llm: createLlm(),
    });
    const sleepSpy = vi
      .spyOn(agent as any, '_sleep')
      .mockResolvedValue(undefined);

    await (agent as any)._handle_step_error(
      new ModelRateLimitError('Rate limit exceeded', 429, 'test-model')
    );

    expect(sleepSpy).not.toHaveBeenCalled();
    expect(agent.state.last_result?.[0]?.error).toContain(
      'Rate limit exceeded'
    );

    await agent.close();
  });

  it('continues run loop from state.n_steps for resumed runs', async () => {
    const agent = new Agent({
      task: 'resume run loop from saved step',
      llm: createLlm(),
    });
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});
    const stepSpy = vi
      .spyOn(agent as any, '_step')
      .mockImplementation(async () => {
        agent.state.stopped = true;
      });

    agent.state.n_steps = 3;
    await agent.run(3);

    expect(stepSpy).toHaveBeenCalledTimes(1);
    const stepInfo = stepSpy.mock.calls[0]?.[0] as AgentStepInfo;
    expect(stepInfo.step_number).toBe(2);
    expect(stepInfo.max_steps).toBe(3);

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('uses python-aligned model-based llm_timeout defaults when not explicitly set', async () => {
    const defaultAgent = new Agent({
      task: 'default timeout',
      llm: createLlm('gemini-3-pro', 'google'),
    });
    const overrideAgent = new Agent({
      task: 'override timeout',
      llm: createLlm('gemini-2.5-flash', 'google'),
      llm_timeout: 123,
    });

    expect(defaultAgent.settings.llm_timeout).toBe(90);
    expect(overrideAgent.settings.llm_timeout).toBe(123);

    await defaultAgent.close();
    await overrideAgent.close();
  });

  it.each([
    ['max_failures', { max_failures: Number.POSITIVE_INFINITY }],
    ['max_actions_per_step', { max_actions_per_step: Number.NaN }],
    ['max_history_items', { max_history_items: Number.POSITIVE_INFINITY }],
    ['planning_replan_on_stall', { planning_replan_on_stall: 1.5 }],
    ['planning_exploration_limit', { planning_exploration_limit: -1 }],
    ['llm_timeout', { llm_timeout: Number.POSITIVE_INFINITY }],
    ['step_timeout', { step_timeout: Number.POSITIVE_INFINITY }],
    ['loop_detection_window', { loop_detection_window: 0 }],
    ['_url_shortening_limit', { _url_shortening_limit: Number.NaN }],
  ])('rejects invalid %s resource settings', (_name, options) => {
    expect(
      () =>
        new Agent({
          task: 'invalid resource setting',
          llm: createLlm(),
          ...options,
        })
    ).toThrow(RangeError);
  });

  it('rejects screenshot targets that exceed the pixel budget', () => {
    expect(
      () =>
        new Agent({
          task: 'oversized screenshot target',
          llm: createLlm(),
          llm_screenshot_size: [8_192, 8_192],
        })
    ).toThrow(/total pixels/);
  });

  it('only disables vision automatically for grok-3/grok-code models', async () => {
    const grok2Agent = new Agent({
      task: 'grok-2 vision',
      llm: createLlm('grok-2-vision', 'xai'),
      use_vision: true,
    });
    const grok3Agent = new Agent({
      task: 'grok-3 vision',
      llm: createLlm('grok-3-beta', 'xai'),
      use_vision: true,
    });
    const grokCodeAgent = new Agent({
      task: 'grok-code vision',
      llm: createLlm('grok-code-fast', 'xai'),
      use_vision: true,
    });

    expect(grok2Agent.settings.use_vision).toBe(true);
    expect(grok3Agent.settings.use_vision).toBe(false);
    expect(grokCodeAgent.settings.use_vision).toBe(false);

    await grok2Agent.close();
    await grok3Agent.close();
    await grokCodeAgent.close();
  });

  it('uses controller.exclude_action to hide screenshot when use_vision is not auto (python c011 parity)', async () => {
    const controller = new Controller();
    const excludeActionSpy = vi.spyOn(controller, 'exclude_action');

    const agent = new Agent({
      task: 'exclude screenshot action for fixed vision mode',
      llm: createLlm(),
      controller: controller as any,
      use_vision: true,
    });

    expect(excludeActionSpy).toHaveBeenCalledWith('screenshot');
    expect(controller.registry.get_action('screenshot')).toBeNull();

    await agent.close();
  });

  it('sets coordinate-clicking support from model family (python c011 parity)', async () => {
    const regularController = new Controller();
    const regularToggleSpy = vi.spyOn(
      regularController,
      'set_coordinate_clicking'
    );
    const regularAgent = new Agent({
      task: 'regular model coordinate toggle',
      llm: createLlm('gpt-4o-mini', 'openai'),
      controller: regularController as any,
    });

    expect(regularToggleSpy).toHaveBeenCalledWith(false);

    const supportedController = new Controller();
    const supportedToggleSpy = vi.spyOn(
      supportedController,
      'set_coordinate_clicking'
    );
    const supportedAgent = new Agent({
      task: 'supported model coordinate toggle',
      llm: createLlm('claude-sonnet-4-5', 'anthropic'),
      controller: supportedController as any,
    });

    expect(supportedToggleSpy).toHaveBeenCalledWith(true);

    await regularAgent.close();
    await supportedAgent.close();
  });

  it('auto-configures Claude screenshot size through provider-prefixed ids', async () => {
    const agent = new Agent({
      task: 'gateway Claude screenshot size',
      llm: createLlm('anthropic/claude-sonnet-4-6', 'browser-use'),
    });

    expect(agent.browser_session?.llm_screenshot_size).toEqual([1400, 850]);

    await agent.close();
  });

  it('initializes fallback llm state and exposes model tracking getters', async () => {
    const primary = createLlm('primary-model', 'openai');
    const fallback = createLlm('fallback-model', 'anthropic');
    const agent = new Agent({
      task: 'fallback state init',
      llm: primary,
      fallback_llm: fallback,
    });

    expect(agent.is_using_fallback_llm).toBe(false);
    expect(agent.current_llm_model).toBe('primary-model');
    expect((agent as any)._fallback_llm).toBe(fallback);
    expect((agent as any)._original_llm).toBe(primary);

    await agent.close();
  });

  it('switches to fallback llm on retryable provider errors', async () => {
    const primary = createLlm('primary-model');
    const fallback = createLlm('fallback-model');
    const agent = new Agent({
      task: 'fallback switch',
      llm: primary,
      fallback_llm: fallback,
    });
    const registerSpy = vi.spyOn(
      (agent as any).token_cost_service,
      'register_llm'
    );

    const switched = (agent as any)._try_switch_to_fallback_llm(
      new ModelProviderError('Service unavailable', 503, 'primary-model')
    );

    expect(switched).toBe(true);
    expect(agent.llm).toBe(fallback);
    expect(agent.is_using_fallback_llm).toBe(true);
    expect(agent.current_llm_model).toBe('fallback-model');
    expect(registerSpy).toHaveBeenCalledWith(fallback);

    await agent.close();
  });

  it('does not switch to fallback llm for non-retryable provider errors', async () => {
    const primary = createLlm('primary-model');
    const fallback = createLlm('fallback-model');
    const agent = new Agent({
      task: 'fallback non retryable',
      llm: primary,
      fallback_llm: fallback,
    });

    const switched = (agent as any)._try_switch_to_fallback_llm(
      new ModelProviderError('Bad request', 400, 'primary-model')
    );

    expect(switched).toBe(false);
    expect(agent.llm).toBe(primary);
    expect(agent.is_using_fallback_llm).toBe(false);
    expect(agent.current_llm_model).toBe('primary-model');

    await agent.close();
  });

  it('switches to fallback llm after output truncation', async () => {
    const primary = createLlm('primary-model');
    const fallback = createLlm('fallback-model');
    const agent = new Agent({
      task: 'fallback after truncation',
      llm: primary,
      fallback_llm: fallback,
    });

    const switched = (agent as any)._try_switch_to_fallback_llm(
      new ModelOutputTruncatedError('Output truncated', 'primary-model')
    );

    expect(switched).toBe(true);
    expect(agent.llm).toBe(fallback);
    expect(agent.is_using_fallback_llm).toBe(true);

    await agent.close();
  });

  it('retries model output generation with fallback llm after rate limit', async () => {
    const primaryInvoke = vi.fn(async () => {
      throw new ModelRateLimitError(
        'Rate limit exceeded',
        429,
        'primary-model'
      );
    });
    const fallbackInvoke = vi.fn(async () => ({
      completion: {
        thinking: null,
        evaluation_previous_goal: 'none',
        memory: 'none',
        next_goal: 'finish',
        action: [
          {
            done: {
              text: 'Task completed',
              success: true,
            },
          },
        ],
      },
      usage: null,
    }));
    const primary = {
      ...createLlm('primary-model'),
      ainvoke: primaryInvoke,
    } as unknown as BaseChatModel;
    const fallback = {
      ...createLlm('fallback-model'),
      ainvoke: fallbackInvoke,
    } as unknown as BaseChatModel;
    const agent = new Agent({
      task: 'fallback invoke retry',
      llm: primary,
      fallback_llm: fallback,
    });

    const output = await (agent as any)._get_model_output_with_retry(
      [{ role: 'user', content: 'test' }],
      null
    );

    expect(primaryInvoke).toHaveBeenCalledTimes(1);
    expect(fallbackInvoke).toHaveBeenCalledTimes(1);
    expect(agent.llm).toBe(fallback);
    expect(agent.is_using_fallback_llm).toBe(true);
    expect(output.action).toHaveLength(1);
    expect(output.action[0].model_dump()).toEqual({
      done: {
        text: 'Task completed',
        success: true,
        files_to_display: [],
      },
    });

    await agent.close();
  });

  it('passes session_id into llm invoke options for model output generation', async () => {
    const invokeMock = vi.fn(
      async (
        _messages: unknown[],
        _outputFormat?: unknown,
        _options?: Record<string, unknown>
      ) => ({
        completion: {
          thinking: null,
          evaluation_previous_goal: 'none',
          memory: 'none',
          next_goal: 'finish',
          action: [
            {
              done: {
                text: 'Task completed',
                success: true,
              },
            },
          ],
        },
        usage: null,
      })
    );
    const llm = {
      ...createLlm('primary-model'),
      ainvoke: invokeMock,
    } as unknown as BaseChatModel;
    const agent = new Agent({
      task: 'session id forwarding',
      llm,
    });

    await (agent as any)._get_model_output_with_retry(
      [{ role: 'user', content: 'test' }],
      null
    );

    const invokeOptions = (invokeMock.mock.calls[0]?.[2] ?? {}) as {
      session_id?: string;
    };
    expect(invokeOptions.session_id).toBe(agent.session_id);

    await agent.close();
  });

  it('shortens long URLs before invoke and restores original URLs in model output', async () => {
    const longUrl = `https://example.com/path?token=${'x'.repeat(80)}`;
    const seenMessages: any[] = [];
    const llm = {
      ...createLlm('primary-model'),
      ainvoke: vi.fn(async (messages: any[]) => {
        seenMessages.push(messages);
        const promptText =
          typeof messages?.[0]?.content === 'string' ? messages[0].content : '';
        return {
          completion: {
            thinking: null,
            evaluation_previous_goal: 'none',
            memory: 'none',
            next_goal: `Inspect ${promptText}`,
            action: [
              {
                done: {
                  text: `Processed ${promptText}`,
                  success: true,
                },
              },
            ],
          },
          usage: null,
        };
      }),
    } as unknown as BaseChatModel;
    const agent = new Agent({
      task: 'url shortening',
      llm,
      _url_shortening_limit: 12,
    });

    const inputMessages = [new UserMessage(`Visit ${longUrl} and summarize.`)];
    const output = await (agent as any)._get_model_output_with_retry(
      inputMessages,
      null
    );

    const forwardedPrompt = String(seenMessages[0]?.[0]?.content ?? '');
    expect(forwardedPrompt).not.toContain(longUrl);
    expect(forwardedPrompt).toContain('...');
    expect(output.next_goal).toContain(longUrl);
    expect(output.action[0].model_dump().done.text).toContain(longUrl);

    await agent.close();
  });

  it('logger getter works on partially initialized agent instances', () => {
    const partialAgent = Object.create(Agent.prototype) as Agent<any, any>;
    (partialAgent as any)._logger = null;

    expect(() => (partialAgent as any).logger).not.toThrow();
  });

  it('multi_act skips remaining actions after terminating navigation actions', async () => {
    const agent = new Agent({
      task: 'multi_act terminating action guard',
      llm: createLlm(),
    });
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockResolvedValue(new ActionResult({ extracted_content: 'ok' }));

    const results = await agent.multi_act(
      [
        { go_to_url: { url: 'https://example.com', new_tab: false } },
        { wait: { seconds: 1 } },
      ],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(executeActionSpy.mock.calls[0]?.[0]).toBe('go_to_url');
    expect(results).toHaveLength(1);

    await agent.close();
  });

  it('multi_act respects registry terminates_sequence metadata for custom actions', async () => {
    const agent = new Agent({
      task: 'multi_act custom terminates_sequence guard',
      llm: createLlm(),
    });

    (agent.controller.registry as any).action('Custom terminating action', {
      terminates_sequence: true,
    })(async function custom_terminate() {
      return new ActionResult({ extracted_content: 'custom terminate' });
    });

    const executeActionSpy = vi.spyOn(
      agent.controller.registry as any,
      'execute_action'
    );

    const results = await agent.multi_act(
      [{ custom_terminate: {} }, { wait: { seconds: 0 } }],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(executeActionSpy.mock.calls[0]?.[0]).toBe('custom_terminate');
    expect(results).toHaveLength(1);
    expect(results[0]?.extracted_content).toContain('custom terminate');

    await agent.close();
  });

  it('multi_act skips remaining actions when page URL changes after an action', async () => {
    const agent = new Agent({
      task: 'multi_act runtime page-change guard',
      llm: createLlm(),
    });
    let currentUrl = 'https://start.test';
    vi.spyOn(
      agent.browser_session as any,
      'get_current_page'
    ).mockImplementation(
      async () =>
        ({
          url: () => currentUrl,
        }) as any
    );
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async (..._args: unknown[]) => {
        currentUrl = 'https://changed.test';
        return new ActionResult({ extracted_content: 'ok' });
      });

    const results = await agent.multi_act(
      [{ wait: { seconds: 1 } }, { wait: { seconds: 1 } }],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);

    await agent.close();
  });

  it('multi_act skips remaining actions when focus target changes after an action', async () => {
    const agent = new Agent({
      task: 'multi_act runtime focus-change guard',
      llm: createLlm(),
    });
    let currentUrl = 'https://same.test';
    (agent.browser_session as any).agent_focus_target_id = 100;
    vi.spyOn(
      agent.browser_session as any,
      'get_current_page'
    ).mockImplementation(
      async () =>
        ({
          url: () => currentUrl,
        }) as any
    );
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async () => {
        (agent.browser_session as any).agent_focus_target_id = 101;
        return new ActionResult({ extracted_content: 'ok' });
      });

    const results = await agent.multi_act(
      [{ wait: { seconds: 0 } }, { wait: { seconds: 0 } }],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);

    await agent.close();
  });

  it('multi_act ignores legacy selector-map drift guards (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'multi_act selector-map drift parity',
      llm: createLlm(),
    });

    const selectorMapSpy = vi.spyOn(
      agent.browser_session as any,
      'get_selector_map'
    );
    const browserStateSpy = vi.spyOn(
      agent.browser_session as any,
      'get_browser_state_with_recovery'
    );
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockResolvedValue(new ActionResult({ extracted_content: 'ok' }));

    const results = await agent.multi_act(
      [{ click: { index: 1 } }, { click: { index: 1 } }],
      { check_for_new_elements: true }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(2);
    expect(selectorMapSpy).not.toHaveBeenCalled();
    expect(browserStateSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);

    await agent.close();
  });

  it('multi_act returns partial results when a later action raises a regular error', async () => {
    const agent = new Agent({
      task: 'multi_act partial error parity',
      llm: createLlm(),
    });
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[1] as { fail?: boolean } | undefined;
        if (params?.fail) {
          throw new Error('second action failed');
        }
        return new ActionResult({ extracted_content: 'first action ok' });
      });

    const results = await agent.multi_act(
      [
        { wait: { seconds: 0 } },
        { wait: { seconds: 0, fail: true } },
        { wait: { seconds: 0 } },
      ],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.extracted_content).toBe('first action ok');
    expect(results[1]?.error).toBe('Error: second action failed');

    await agent.close();
  });

  it('multi_act preserves BrowserError memory when returning partial failures', async () => {
    const agent = new Agent({
      task: 'multi_act BrowserError memory parity',
      llm: createLlm(),
    });
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[1] as { fail?: boolean } | undefined;
        if (params?.fail) {
          throw new BrowserError({
            message: 'Dropdown options changed',
            short_term_memory: 'Available options are A and B.',
            long_term_memory: 'Failed to select stale dropdown option C.',
          });
        }
        return new ActionResult({ extracted_content: 'first action ok' });
      });

    const results = await agent.multi_act(
      [
        { wait: { seconds: 0 } },
        { wait: { seconds: 0, fail: true } },
        { wait: { seconds: 0 } },
      ],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.extracted_content).toBe('first action ok');
    expect(results[1]?.extracted_content).toBe(
      'Available options are A and B.'
    );
    expect(results[1]?.error).toBe('Failed to select stale dropdown option C.');
    expect(results[1]?.include_extracted_content_only_once).toBe(true);

    await agent.close();
  });

  it('multi_act maps registry timeout errors before returning partial failures', async () => {
    const agent = new Agent({
      task: 'multi_act registry timeout parity',
      llm: createLlm(),
    });
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[1] as { fail?: boolean } | undefined;
        if (params?.fail) {
          throw new Error('Error executing action wait due to timeout.');
        }
        return new ActionResult({ extracted_content: 'first action ok' });
      });

    const results = await agent.multi_act(
      [
        { wait: { seconds: 0 } },
        { wait: { seconds: 0, fail: true } },
        { wait: { seconds: 0 } },
      ],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.extracted_content).toBe('first action ok');
    expect(results[1]?.error).toBe('wait was not executed due to timeout.');

    await agent.close();
  });

  it('multi_act still propagates interruption-style action errors', async () => {
    const agent = new Agent({
      task: 'multi_act propagates abort errors',
      llm: createLlm(),
    });
    const abortError = new Error('operation aborted');
    abortError.name = 'AbortError';
    vi.spyOn(
      agent.controller.registry as any,
      'execute_action'
    ).mockRejectedValue(abortError);

    await expect(
      agent.multi_act([{ wait: { seconds: 0 } }], {
        check_for_new_elements: false,
      })
    ).rejects.toBe(abortError);

    await agent.close();
  });

  it('multi_act caps each action with a wall-clock timeout', async () => {
    const agent = new Agent({
      task: 'multi_act action timeout parity',
      llm: createLlm(),
    });
    let sawAbort = false;
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async (...args: unknown[]) => {
        const ctx = args[2] as { signal?: AbortSignal | null };
        return new Promise<ActionResult>((resolve) => {
          ctx.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve(new ActionResult({ extracted_content: 'too late' }));
            },
            { once: true }
          );
        });
      });

    const results = await agent.multi_act(
      [{ wait: { seconds: 0 } }, { wait: { seconds: 0 } }],
      {
        check_for_new_elements: false,
        action_timeout: 0.01,
      }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(sawAbort).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toContain('Action wait timed out after');
    expect(results[0]?.error).toContain('browser may be unresponsive');

    await agent.close();
  });

  it('copies non-owning BrowserSession instances to avoid shared-agent state', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser: {} as any,
    });
    const copySpy = vi.spyOn(sharedSession, 'model_copy');

    const agent = new Agent({
      task: 'test shared session copy',
      llm: createLlm(),
      browser_session: sharedSession,
    });

    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(agent.browser_session).toBeInstanceOf(BrowserSession);
    expect(agent.browser_session).not.toBe(sharedSession);

    await agent.close();
  });

  it('reuses non-owning BrowserSession in shared attachment mode without cloning', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser: {} as any,
    });
    const copySpy = vi.spyOn(sharedSession, 'model_copy');

    const agent1 = new Agent({
      task: 'shared non-owning agent 1',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });
    const agent2 = new Agent({
      task: 'shared non-owning agent 2',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });

    expect(copySpy).toHaveBeenCalledTimes(0);
    expect(agent1.browser_session).toBe(sharedSession);
    expect(agent2.browser_session).toBe(sharedSession);
    expect(sharedSession.get_attached_agent_ids().sort()).toEqual(
      [agent1.id, agent2.id].sort()
    );

    await agent1.close();
    await agent2.close();
  });

  it('creates isolated copy when BrowserSession is already attached to another agent', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    expect(sharedSession.claim_agent('existing-agent')).toBe(true);

    const agent = new Agent({
      task: 'test attached session isolation',
      llm: createLlm(),
      browser_session: sharedSession,
    });

    expect(agent.browser_session).toBeInstanceOf(BrowserSession);
    expect(agent.browser_session).not.toBe(sharedSession);
    expect(sharedSession.get_attached_agent_id()).toBe('existing-agent');
    expect(
      (agent.browser_session as BrowserSession).get_attached_agent_id()
    ).toBe(agent.id);

    await agent.close();
  });

  it('releases BrowserSession claim on close', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const agent = new Agent({
      task: 'test claim release',
      llm: createLlm(),
      browser_session: session,
    });

    expect(session.get_attached_agent_id()).toBe(agent.id);
    await agent.close();
    expect(session.get_attached_agent_id()).toBeNull();
  });

  it('deduplicates concurrent close calls and releases claim once', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const stopSpy = vi.spyOn(session as any, 'stop').mockImplementation(
      async () =>
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        })
    );
    const releaseSpy = vi.spyOn(session as any, 'release_agent');

    const agent = new Agent({
      task: 'test concurrent close',
      llm: createLlm(),
      browser_session: session,
    });

    expect(session.get_attached_agent_id()).toBe(agent.id);
    await Promise.all([agent.close(), agent.close(), agent.close()]);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(session.get_attached_agent_id()).toBeNull();
  });

  it('throws in strict attachment mode when BrowserSession is already attached', () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    expect(sharedSession.claim_agent('existing-agent')).toBe(true);

    expect(
      () =>
        new Agent({
          task: 'strict attachment',
          llm: createLlm(),
          browser_session: sharedSession,
          session_attachment_mode: 'strict',
        })
    ).toThrow(/already attached to Agent existing-agent/);
  });

  it('throws in strict attachment mode when BrowserSession does not support claims', () => {
    const legacySession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    }) as any;
    legacySession.claim_agent = undefined;
    legacySession.claimAgent = undefined;

    expect(
      () =>
        new Agent({
          task: 'strict unsupported claims',
          llm: createLlm(),
          browser_session: legacySession,
          session_attachment_mode: 'strict',
        })
    ).toThrow(
      /requires BrowserSession\.claim_agent\(\)\/release_agent\(\) support/
    );
  });

  it('reuses BrowserSession in shared attachment mode and defers shutdown until last agent closes', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const stopSpy = vi
      .spyOn(sharedSession as any, 'stop')
      .mockImplementation(async () => {});

    const agent1 = new Agent({
      task: 'shared agent 1',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });
    const agent2 = new Agent({
      task: 'shared agent 2',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });

    expect(agent1.browser_session).toBe(sharedSession);
    expect(agent2.browser_session).toBe(sharedSession);
    expect(sharedSession.get_attached_agent_ids().sort()).toEqual(
      [agent1.id, agent2.id].sort()
    );

    await agent1.close();
    expect(stopSpy).toHaveBeenCalledTimes(0);
    expect(sharedSession.get_attached_agent_ids()).toEqual([agent2.id]);

    await agent2.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(sharedSession.get_attached_agent_ids()).toEqual([]);
  });

  it('throws in shared attachment mode when session is already exclusively attached', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const exclusiveAgent = new Agent({
      task: 'exclusive owner',
      llm: createLlm(),
      browser_session: sharedSession,
    });

    expect(
      () =>
        new Agent({
          task: 'shared join fails',
          llm: createLlm(),
          browser_session: sharedSession,
          session_attachment_mode: 'shared',
        })
    ).toThrow(/already attached in exclusive mode/);

    await exclusiveAgent.close();
  });

  it('throws in shared attachment mode when BrowserSession does not support claims', () => {
    const legacySession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    }) as any;
    legacySession.claim_agent = undefined;
    legacySession.claimAgent = undefined;

    expect(
      () =>
        new Agent({
          task: 'shared unsupported claims',
          llm: createLlm(),
          browser_session: legacySession,
          session_attachment_mode: 'shared',
        })
    ).toThrow(
      /requires BrowserSession\.claim_agent\(\)\/release_agent\(\) support/
    );
  });

  it('defaults page_extraction_llm to the main llm when omitted', async () => {
    const llm = createLlm();
    const agent = new Agent({
      task: 'test extraction llm default',
      llm,
    });

    expect(agent.settings.page_extraction_llm).toBe(llm);

    await agent.close();
  });

  it('auto-adds go_to_url initial action when task contains a single navigable URL', async () => {
    const agent = new Agent({
      task: 'Open https://example.com and verify the page title.',
      llm: createLlm(),
    });

    expect(agent.initial_actions).toHaveLength(1);
    expect(agent.initial_url).toBe('https://example.com');
    expect(agent.initial_actions?.[0]).toEqual({
      go_to_url: {
        url: 'https://example.com',
        new_tab: false,
      },
    });

    await agent.close();
  });

  it('does not auto-open URL when follow_up_task state is restored (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'Open https://example.com and verify the page title.',
      llm: createLlm(),
      injected_agent_state: new AgentState({
        follow_up_task: true,
      }),
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('does not auto-open URL when multiple URLs are present in task text', async () => {
    const agent = new Agent({
      task: 'Compare https://example.com with https://example.org and summarize.',
      llm: createLlm(),
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('logs c011 directly_open_url ambiguity message when multiple URLs are detected', async () => {
    const agent = new Agent({
      task: 'placeholder',
      llm: createLlm(),
    });

    const debugSpy = vi.spyOn(agent.logger, 'debug');
    const extracted = (agent as any)._extract_start_url(
      'Compare https://example.com with https://example.org and summarize.'
    );

    expect(extracted).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      'Multiple URLs found (4), skipping directly_open_url to avoid ambiguity'
    );

    await agent.close();
  });

  it('respects directly_open_url=false and skips URL auto-navigation', async () => {
    const agent = new Agent({
      task: 'Open https://example.com and verify the page title.',
      llm: createLlm(),
      directly_open_url: false,
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('ignores file-like URLs for automatic navigation', async () => {
    const agent = new Agent({
      task: 'Read data from https://example.com/report.pdf and summarize it.',
      llm: createLlm(),
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('enhances task text with structured output schema when provided', async () => {
    const outputSchema = {
      name: 'ResultSchema',
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      }),
    };

    const agent = new Agent({
      task: 'Extract the answer from the page',
      llm: createLlm(),
      output_model_schema: outputSchema as any,
    });

    expect(agent.task).toContain('Expected output format: ResultSchema');
    expect(agent.task).toContain('"answer"');

    await agent.close();
  });

  it('initializes message manager with schema-enhanced task text (python c011 parity)', async () => {
    const outputSchema = {
      name: 'ResultSchema',
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      }),
    };

    const agent = new Agent({
      task: 'Extract the answer from the page',
      llm: createLlm(),
      output_model_schema: outputSchema as any,
    });

    const messageManagerTask = String(
      (agent as any)._message_manager?.task ?? ''
    );
    expect(messageManagerTask).toContain(
      'Expected output format: ResultSchema'
    );
    expect(messageManagerTask).toContain('"answer"');

    await agent.close();
  });

  it('registers structured output done action for zod output_model_schema (python c011 parity)', async () => {
    const controller = new Controller();
    const outputSchema = z.object({
      answer: z.string(),
    });
    const useStructuredOutputSpy = vi.spyOn(
      controller,
      'use_structured_output_action'
    );

    const agent = new Agent({
      task: 'structured output action setup',
      llm: createLlm(),
      controller: controller as any,
      output_model_schema: outputSchema as any,
    });

    expect(useStructuredOutputSpy).toHaveBeenCalledTimes(1);
    expect(useStructuredOutputSpy).toHaveBeenCalledWith(outputSchema);

    await agent.close();
  });

  it('does not register structured output done action for non-zod output parsers', async () => {
    const controller = new Controller();
    const useStructuredOutputSpy = vi.spyOn(
      controller,
      'use_structured_output_action'
    );
    const outputSchema = {
      name: 'ResultSchema',
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      }),
    };

    const agent = new Agent({
      task: 'non-zod output parser',
      llm: createLlm(),
      controller: controller as any,
      output_model_schema: outputSchema as any,
    });

    expect(useStructuredOutputSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('auto-bridges controller output_model into agent output_model_schema (python c011 parity)', async () => {
    const controllerOutputSchema = z.object({
      answer: z.string(),
    });
    const controller = new Controller({
      output_model: controllerOutputSchema,
    });
    const useStructuredOutputSpy = vi.spyOn(
      controller,
      'use_structured_output_action'
    );

    const agent = new Agent({
      task: 'Bridge controller output model schema',
      llm: createLlm(),
      controller: controller as any,
    });

    expect((agent as any).output_model_schema).toBe(controllerOutputSchema);
    expect(agent.task).toContain('Expected output format');
    expect(agent.task).toContain('"answer"');
    expect(useStructuredOutputSpy).toHaveBeenCalledTimes(1);

    await agent.close();
  });

  it('prefers explicit output_model_schema over controller output_model', async () => {
    const controller = new Controller({
      output_model: z.object({
        controller_value: z.string(),
      }),
    });
    const explicitSchema = {
      name: 'ExplicitSchema',
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          explicit_value: { type: 'string' },
        },
      }),
    };

    const agent = new Agent({
      task: 'Prefer explicit output schema',
      llm: createLlm(),
      controller: controller as any,
      output_model_schema: explicitSchema as any,
    });

    expect((agent as any).output_model_schema).toBe(explicitSchema);
    expect(agent.task).toContain('"explicit_value"');
    expect(agent.task).not.toContain('"controller_value"');

    await agent.close();
  });

  it('aligns addNewTask with python c011 follow-up request wrapping', async () => {
    const agent = new Agent({
      task: 'Original task instructions',
      llm: createLlm(),
      task_id: 'task-1-23',
    });
    const initialEventBus = agent.eventbus;

    agent.addNewTask('Collect pricing details');

    const messageManager = (agent as any)._message_manager;
    expect((messageManager as any).task).toBe(
      '<initial_user_request>Original task instructions</initial_user_request>\n<follow_up_user_request> Collect pricing details </follow_up_user_request>'
    );

    const lastHistoryItem = (
      messageManager as any
    ).state.agent_history_items.at(-1);
    expect(lastHistoryItem?.system_message).toBe(
      '<follow_up_user_request> Collect pricing details </follow_up_user_request>'
    );
    expect(agent.state.follow_up_task).toBe(true);
    expect(agent.state.stopped).toBe(false);
    expect(agent.state.paused).toBe(false);
    expect(agent.eventbus).not.toBe(initialEventBus);
    expect(agent.eventbus.name).toBe('Agent_a1_23');

    await agent.close();
  });

  it('does not re-run initial_actions on follow-up tasks', async () => {
    const agent = new Agent({
      task: 'Open https://example.com then continue',
      llm: createLlm(),
      initial_actions: [
        {
          go_to_url: {
            url: 'https://example.com',
            new_tab: false,
          },
        },
      ],
    });

    const multiActSpy = vi.spyOn(agent, 'multi_act').mockResolvedValue([]);
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});

    agent.state.stopped = true;
    await agent.run(1);
    expect(multiActSpy).toHaveBeenCalledTimes(1);

    agent.addNewTask('Collect pricing details');
    agent.state.stopped = true;
    await agent.run(1);
    expect(multiActSpy).toHaveBeenCalledTimes(1);

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('stores manual initial_actions as step-0 history for rerun parity', async () => {
    const agent = new Agent({
      task: 'Open https://example.com and then continue',
      llm: createLlm(),
      initial_actions: [
        {
          go_to_url: {
            url: 'https://example.com',
            new_tab: false,
          },
        },
      ],
    });

    const initialResult = [
      new ActionResult({
        long_term_memory: 'Loaded start URL',
      }),
    ];
    const multiActSpy = vi
      .spyOn(agent, 'multi_act')
      .mockResolvedValue(initialResult as any);
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});

    agent.state.stopped = true;
    await agent.run(1);

    expect(multiActSpy).toHaveBeenCalledTimes(1);
    expect(agent.history.history).toHaveLength(1);
    expect(agent.history.history[0]?.metadata?.step_number).toBe(0);
    expect(agent.history.history[0]?.state.url).toBe('');
    expect(agent.history.history[0]?.state.title).toBe('Initial Actions');
    expect(agent.history.history[0]?.result[0]?.long_term_memory).toBe(
      'Loaded start URL'
    );

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('runs initial_actions with default multi_act options (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'Execute provided initial actions',
      llm: createLlm(),
      initial_actions: [
        {
          go_to_url: {
            url: 'https://example.com',
            new_tab: false,
          },
        },
      ],
    });

    const multiActSpy = vi
      .spyOn(agent, 'multi_act')
      .mockResolvedValue([
        new ActionResult({ extracted_content: 'ok' }),
      ] as any);
    const logAgentEventSpy = vi
      .spyOn(agent as any, '_log_agent_event')
      .mockImplementation(() => {});

    agent.state.stopped = true;
    await agent.run(1);

    expect(multiActSpy).toHaveBeenCalledTimes(1);
    expect(multiActSpy.mock.calls[0]).toHaveLength(1);

    logAgentEventSpy.mockRestore();
    await agent.close();
  });

  it('stores step-0 action results and read_state blocks using python c011 semantics', async () => {
    const agent = new Agent({
      task: 'Message manager step-0 format',
      llm: createLlm(),
    });

    const messageManager = (agent as any)._message_manager;
    const initialHistoryLength = (messageManager as any).state
      .agent_history_items.length;
    messageManager.prepare_step_state(
      createBrowserStateSummary(),
      null,
      [
        new ActionResult({
          include_extracted_content_only_once: true,
          extracted_content: 'Read-once content',
        }),
        new ActionResult({
          long_term_memory: 'Persisted action memory',
        }),
      ],
      new AgentStepInfo(0, 10)
    );

    const readState = (messageManager as any).state.read_state_description;
    expect(readState).toBe(
      '<read_state_0>\nRead-once content\n</read_state_0>'
    );
    expect((messageManager as any).state.agent_history_items).toHaveLength(
      initialHistoryLength + 1
    );
    const stepZeroHistoryItem = (
      messageManager as any
    ).state.agent_history_items.at(-1);
    expect(stepZeroHistoryItem?.action_results).toContain('Result');
    expect(stepZeroHistoryItem?.action_results).toContain(
      'Persisted action memory'
    );

    const output = new AgentOutput({
      evaluation_previous_goal: 'ok',
      memory: 'mem',
      next_goal: 'next',
      action: [],
    });
    messageManager.prepare_step_state(
      createBrowserStateSummary(),
      output as any,
      [
        new ActionResult({
          long_term_memory: 'Persisted action memory',
        }),
      ],
      new AgentStepInfo(1, 10)
    );

    const lastHistoryItem = (
      messageManager as any
    ).state.agent_history_items.at(-1);
    expect(lastHistoryItem?.action_results).toContain('Result');
    expect(lastHistoryItem?.action_results).toContain(
      'Persisted action memory'
    );

    await agent.close();
  });

  it('uses use_vision=auto to include screenshot only when requested by action metadata', async () => {
    const agent = new Agent({
      task: 'Auto screenshot inclusion',
      llm: createLlm(),
      use_vision: 'auto',
    } as any);

    const messageManager = (agent as any)._message_manager;

    messageManager.create_state_messages(
      createBrowserStateSummary(),
      null,
      [new ActionResult({ metadata: { include_screenshot: false } })],
      new AgentStepInfo(1, 10),
      'auto'
    );
    const noScreenshotStateMessage = (messageManager as any).state.history
      .state_message as any;
    expect(Array.isArray(noScreenshotStateMessage?.content)).toBe(false);

    messageManager.create_state_messages(
      createBrowserStateSummary(),
      null,
      [new ActionResult({ metadata: { include_screenshot: true } })],
      new AgentStepInfo(2, 10),
      'auto'
    );
    const screenshotStateMessage = (messageManager as any).state.history
      .state_message as any;
    expect(Array.isArray(screenshotStateMessage?.content)).toBe(true);
    expect(
      screenshotStateMessage.content.some((part: any) =>
        String(part?.image_url?.url ?? '').startsWith('data:image/png;base64,')
      )
    ).toBe(true);

    await agent.close();
  });

  it('throws when max_history_items is set to 5 or less', () => {
    expect(
      () =>
        new Agent({
          task: 'Invalid history limit',
          llm: createLlm(),
          max_history_items: 5,
        } as any)
    ).toThrow('max_history_items must be null or greater than 5');
  });

  it('filters sensitive data only in state messages (not system/context)', async () => {
    const secret = 'secret-value-123';
    const agent = new Agent({
      task: 'Sensitive data filtering scope',
      llm: createLlm(),
      sensitive_data: {
        'https://example.com': {
          token: secret,
        },
      },
      override_system_message: `System can reference ${secret}`,
      browser_session: new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
        }),
      }),
    });

    const messageManager = (agent as any)._message_manager;
    const systemMessageText = String(
      (messageManager as any).state.history.system_message?.text ?? ''
    );
    expect(systemMessageText).toContain(secret);

    messageManager._add_context_message(
      new UserMessage(`Context has ${secret}`)
    );
    const lastContextMessageText = String(
      (messageManager as any).state.history.context_messages.at(-1)?.text ?? ''
    );
    expect(lastContextMessageText).toContain(secret);

    messageManager.create_state_messages(
      createBrowserStateSummary(),
      {
        current_state: {
          evaluation_previous_goal: 'checked previous step',
          memory: `Memory contains ${secret}`,
          next_goal: 'continue',
        },
        action: [],
      } as any,
      [new ActionResult({ long_term_memory: `Action used ${secret}` })],
      new AgentStepInfo(1, 10),
      false
    );
    const stateMessageText = String(
      (messageManager as any).state.history.state_message?.text ?? ''
    );
    expect(stateMessageText).not.toContain(secret);
    expect(stateMessageText).toContain('<secret>token</secret>');
    expect(stateMessageText).toContain("['token']");

    await agent.close();
  });

  it('bridges extraction_schema from output_model_schema when not provided', async () => {
    const outputSchema = {
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      }),
    };

    const agent = new Agent({
      task: 'Bridge extraction schema',
      llm: createLlm(),
      output_model_schema: outputSchema as any,
    });

    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockResolvedValue(new ActionResult({ extracted_content: 'ok' }));

    await agent.multi_act([{ wait: { seconds: 0 } }], {
      check_for_new_elements: false,
    });

    const executeContext = executeActionSpy.mock.calls[0]?.[2] as
      | { extraction_schema?: unknown }
      | undefined;
    expect(executeContext?.extraction_schema).toEqual(
      outputSchema.model_json_schema()
    );

    await agent.close();
  });

  it('bridges extraction_schema from zod output_model_schema when not provided', async () => {
    const outputSchema = z.object({
      answer: z.string(),
    });

    const agent = new Agent({
      task: 'Bridge extraction schema from zod model',
      llm: createLlm(),
      output_model_schema: outputSchema as any,
    });

    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockResolvedValue(new ActionResult({ extracted_content: 'ok' }));

    await agent.multi_act([{ wait: { seconds: 0 } }], {
      check_for_new_elements: false,
    });

    const executeContext = executeActionSpy.mock.calls[0]?.[2] as
      | { extraction_schema?: unknown }
      | undefined;
    expect(executeContext?.extraction_schema).toMatchObject({
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
      required: ['answer'],
    });

    await agent.close();
  });

  it('prefers explicit extraction_schema over output_model_schema bridge', async () => {
    const outputSchema = {
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      }),
    };
    const explicitExtractionSchema = {
      type: 'object',
      properties: {
        price: { type: 'number' },
      },
      required: ['price'],
    };

    const agent = new Agent({
      task: 'Prefer explicit extraction schema',
      llm: createLlm(),
      output_model_schema: outputSchema as any,
      extraction_schema: explicitExtractionSchema,
    });

    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockResolvedValue(new ActionResult({ extracted_content: 'ok' }));

    await agent.multi_act([{ wait: { seconds: 0 } }], {
      check_for_new_elements: false,
    });

    const executeContext = executeActionSpy.mock.calls[0]?.[2] as
      | { extraction_schema?: unknown }
      | undefined;
    expect(executeContext?.extraction_schema).toEqual(explicitExtractionSchema);

    await agent.close();
  });

  it('clears timeout handles when timed execution rejects early', async () => {
    const agent = new Agent({
      task: 'test timeout cleanup',
      llm: createLlm(),
    });

    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await expect(
      (agent as any)._executeWithTimeout(Promise.reject(new Error('boom')), 5)
    ).rejects.toThrow('boom');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();

    await agent.close();
  });

  it('uses c011 split step-context logging with debug evaluation details', async () => {
    const agent = new Agent({
      task: 'step context logging',
      llm: createLlm(),
    });

    agent.state.n_steps = 3;
    const infoSpy = vi.spyOn(agent.logger, 'info');
    const debugSpy = vi.spyOn(agent.logger, 'debug');

    (agent as any)._log_step_context(null, {
      url: 'https://example.com/some/really/long/path/that/should/be/truncated/by-logger',
      selector_map: {
        1: {},
        2: {},
      },
    });

    expect(infoSpy).toHaveBeenCalledWith('\n');
    expect(infoSpy).toHaveBeenCalledWith('📍 Step 3:');
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('Evaluating page with 2 interactive elements on:')
    );

    await agent.close();
  });

  it('logs startup banner only before the first recorded step (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'first-step startup banner',
      llm: createLlm(),
    });

    const infoSpy = vi.spyOn(agent.logger, 'info');

    (agent as any)._log_first_step_startup();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Starting a browser-use agent with version')
    );

    infoSpy.mockClear();
    agent.history.history.push({} as any);
    (agent as any)._log_first_step_startup();
    expect(infoSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('logs c011 final-result block and attachment list in _post_process', async () => {
    const agent = new Agent({
      task: 'final result logging',
      llm: createLlm(),
    });

    agent.browser_session = {} as any;
    vi.spyOn(agent as any, '_check_and_update_downloads').mockResolvedValue(
      undefined
    );
    vi.spyOn(agent as any, '_update_loop_detector_actions').mockImplementation(
      () => {}
    );

    agent.state.last_result = [
      new ActionResult({
        is_done: true,
        success: false,
        extracted_content: 'partial completion',
        attachments: ['/tmp/a.txt', '/tmp/b.txt'],
      }),
    ];

    const infoSpy = vi.spyOn(agent.logger, 'info');
    await (agent as any)._post_process();

    expect(
      infoSpy.mock.calls.some((call) =>
        String(call[0] ?? '').includes('\u001b[31m Final Result:')
      )
    ).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith('👉 Attachment 1: /tmp/a.txt');
    expect(infoSpy).toHaveBeenCalledWith('👉 Attachment 2: /tmp/b.txt');

    await agent.close();
  });

  it('redacts sensitive_data in startup and final-result logs', async () => {
    const agent = new Agent({
      task: 'login with super-secret-value',
      llm: createLlm(),
      sensitive_data: {
        password: 'super-secret-value',
      },
    });

    agent.browser_session = {} as any;
    vi.spyOn(agent as any, '_check_and_update_downloads').mockResolvedValue(
      undefined
    );
    vi.spyOn(agent as any, '_update_loop_detector_actions').mockImplementation(
      () => {}
    );
    agent.state.last_result = [
      new ActionResult({
        is_done: true,
        success: true,
        extracted_content: 'finished with super-secret-value',
      }),
    ];

    const infoSpy = vi.spyOn(agent.logger, 'info');
    await (agent as any)._log_agent_run();
    await (agent as any)._post_process();

    const logs = infoSpy.mock.calls
      .map(([message]) => String(message))
      .join('\n');
    expect(logs).not.toContain('super-secret-value');
    expect(logs).toContain('<secret>password</secret>');

    await agent.close();
  });

  it('warns when sensitive_data is used without allowed_domains lock-down (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'test allowed domains empty',
      llm: createLlm(),
      browser_session: new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: [],
        }),
      }),
    });

    (agent as any).sensitive_data = {
      '*.example.com': {
        password: 'secret',
      },
    };

    const warningSpy = vi.spyOn(agent.logger, 'warning');
    expect(() => (agent as any)._validateSecuritySettings()).not.toThrow();
    expect(
      warningSpy.mock.calls.some((call) =>
        String(call[0] ?? '').includes(
          'Browser(allowed_domains=[...]) is not locked down'
        )
      )
    ).toBe(true);

    await agent.close();
  });

  it('does not block startup with TTY delay for unlocked sensitive_data (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'test tty delay',
      llm: createLlm(),
      browser_session: new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: [],
        }),
      }),
    });

    (agent as any).sensitive_data = {
      '*.example.com': {
        password: 'secret',
      },
    };

    const warningSpy = vi.spyOn(agent.logger, 'warning');
    expect(() => (agent as any)._validateSecuritySettings()).not.toThrow();
    expect(
      warningSpy.mock.calls.some((call) =>
        String(call[0] ?? '').includes('Waiting 10 seconds before continuing')
      )
    ).toBe(false);

    await agent.close();
  });

  it('does not fail fast at construction when sensitive_data lacks domain restrictions (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'constructor strict security',
      llm: createLlm(),
      sensitive_data: {
        password: 'secret',
      },
      browser_session: new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: [],
        }),
      }),
    });

    await agent.close();
  });

  it('starts and closes browser session during rerun_history (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'test rerun lifecycle parity',
      llm: createLlm(),
    });

    const startSpy = vi
      .spyOn(agent.browser_session as any, 'start')
      .mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(agent, 'close').mockResolvedValue(undefined);
    vi.spyOn(agent as any, '_execute_history_step').mockResolvedValue([
      new ActionResult({ extracted_content: 'replayed step' }),
    ]);
    vi.spyOn(agent as any, '_generate_rerun_summary').mockResolvedValue(
      new ActionResult({
        is_done: true,
        success: true,
        extracted_content: 'ok',
      })
    );

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history);

    expect(result).toHaveLength(2);
    expect(agent.state.session_initialized).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('uses zero-based step fallback for rerun history without metadata (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'test rerun step fallback parity',
      llm: createLlm(),
    });

    const infoSpy = vi.spyOn(agent.logger, 'info');
    vi.spyOn(agent as any, '_execute_history_step').mockResolvedValue([
      new ActionResult({ extracted_content: 'replayed step' }),
    ]);
    vi.spyOn(agent as any, '_generate_rerun_summary').mockResolvedValue(
      new ActionResult({
        is_done: true,
        success: true,
        extracted_content: 'ok',
      })
    );

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history);

    expect(result).toHaveLength(2);
    expect(
      infoSpy.mock.calls.some((call) =>
        String(call[0] ?? '').includes('Replaying Initial actions (1/1)')
      )
    ).toBe(true);

    await agent.close();
  });

  it('uses step_name in no-action rerun logs for metadata-free steps (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'test rerun no-action step name parity',
      llm: createLlm(),
    });

    const warningSpy = vi.spyOn(agent.logger, 'warning');
    vi.spyOn(agent as any, '_generate_rerun_summary').mockResolvedValue(
      new ActionResult({
        is_done: true,
        success: false,
        extracted_content: 'summary',
      })
    );

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'No-op replay' },
            action: [],
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history);

    expect(result).toHaveLength(2);
    expect(
      warningSpy.mock.calls.some((call) =>
        String(call[0] ?? '').includes(
          'Initial actions: No action to replay, skipping'
        )
      )
    ).toBe(true);

    await agent.close();
  });

  it('passes signal through rerun_history to history step execution', async () => {
    const agent = new Agent({
      task: 'test rerun signal propagation',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([
        new ActionResult({ extracted_content: 'replayed step' }),
      ]);
    const signalController = new AbortController();
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history, {
      signal: signalController.signal,
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.is_done).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model_output: expect.objectContaining({
          current_state: expect.objectContaining({
            next_goal: 'Replay action',
          }),
        }),
      }),
      2,
      signalController.signal,
      false
    );

    await agent.close();
  });

  it('does not execute initial_actions before rerun_history replay', async () => {
    const agent = new Agent({
      task: 'test rerun initial action guard',
      llm: createLlm(),
      initial_actions: [
        {
          go_to_url: {
            url: 'https://example.com',
            new_tab: false,
          },
        },
      ],
    });

    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const multiActSpy = vi.spyOn(agent, 'multi_act').mockResolvedValue([]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history);

    expect(result).toHaveLength(2);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(multiActSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('uses saved step_interval and caps it by max_step_interval during rerun_history', async () => {
    const agent = new Agent({
      task: 'test rerun step timing',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay slow step' },
            action: [{}],
          },
          metadata: {
            step_number: 1,
            step_interval: 90,
          },
        },
        {
          model_output: {
            current_state: { next_goal: 'Replay fast step' },
            action: [{}],
          },
          metadata: {
            step_number: 2,
            step_interval: 0.25,
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history, {
      max_step_interval: 45,
    });

    expect(result).toHaveLength(3);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[0]?.[1]).toBe(45);
    expect(executeSpy.mock.calls[1]?.[1]).toBe(0.25);

    await agent.close();
  });

  it('aborts rerun_history before replay execution when signal is already aborted', async () => {
    const agent = new Agent({
      task: 'test rerun abort',
      llm: createLlm(),
    });
    const executeSpy = vi.spyOn(agent as any, '_execute_history_step');
    const signalController = new AbortController();
    signalController.abort();
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    await expect(
      agent.rerun_history(history, { signal: signalController.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('skips originally failed history steps when skip_failures=true', async () => {
    const agent = new Agent({
      task: 'test rerun skip original failures',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([
        new ActionResult({ extracted_content: 'should not run' }),
      ]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
          metadata: {
            step_number: 1,
          },
          result: [
            new ActionResult({ error: 'element not found in previous run' }),
          ],
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      skip_failures: true,
    });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0]?.error).toContain('Skipped - original step had error');

    await agent.close();
  });

  it('uses exponential backoff delays for rerun retries', async () => {
    const agent = new Agent({
      task: 'test rerun retry backoff',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const sleepSpy = vi
      .spyOn(agent as any, '_sleep')
      .mockResolvedValue(undefined);

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action with retries' },
            action: [{}],
          },
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 3,
    });

    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(2);
    const retryDelays = sleepSpy.mock.calls.map((call) => call[0]);
    expect(retryDelays).toEqual([5, 10]);

    await agent.close();
  });

  it('uses step_name in rerun retry logs for metadata-free steps (python c011 parity)', async () => {
    const agent = new Agent({
      task: 'test rerun retry log step name',
      llm: createLlm(),
    });
    const warningSpy = vi.spyOn(agent.logger, 'warning');
    vi.spyOn(agent as any, '_execute_history_step')
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'));
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);
    vi.spyOn(agent as any, '_generate_rerun_summary').mockResolvedValue(
      new ActionResult({
        is_done: true,
        success: false,
        extracted_content: 'summary',
      })
    );

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action with retries' },
            action: [{}],
          },
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 2,
      skip_failures: true,
    });

    expect(results).toHaveLength(2);
    expect(
      warningSpy.mock.calls.some((call) =>
        String(call[0] ?? '').includes('Initial actions failed (attempt 1/2)')
      )
    ).toBe(true);

    await agent.close();
  });

  it('skips redundant retry steps when previous equivalent step already succeeded', async () => {
    const agent = new Agent({
      task: 'test rerun redundant retry skip',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'clicked' })]);

    const clickAction = {
      get_index: () => 7,
      model_dump: () => ({ click: { index: 7 } }),
    };

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Open menu' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'button',
                xpath: '/html/body/button[1]',
                attributes: { 'aria-label': 'Open menu' },
              },
            ],
          },
          result: [],
        },
        {
          model_output: {
            current_state: { next_goal: 'Retry open menu' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'button',
                xpath: '/html/body/button[1]',
                attributes: { 'aria-label': 'Open menu' },
              },
            ],
          },
          result: [],
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 1,
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results[1]?.extracted_content).toContain(
      'Skipped - redundant retry'
    );

    await agent.close();
  });

  it('forwards wait_for_elements option to history step execution', async () => {
    const agent = new Agent({
      task: 'test wait_for_elements forwarding',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    await agent.rerun_history(history, {
      wait_for_elements: true,
    });

    expect(executeSpy.mock.calls[0]?.[3]).toBe(true);

    await agent.close();
  });

  it('forwards ai_step_llm option to history step execution', async () => {
    const agent = new Agent({
      task: 'test ai_step_llm forwarding',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const aiStepLlm = createLlm('gpt-ai-step', 'openai');
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    await agent.rerun_history(history, {
      ai_step_llm: aiStepLlm,
    });

    expect(executeSpy.mock.calls[0]?.[4]).toBe(aiStepLlm);

    await agent.close();
  });

  it('uses markdown extraction stats and page URL in _execute_ai_step (python c011 parity)', async () => {
    const ainvoke = vi.fn(
      async (
        _messages: unknown[],
        _outputFormat?: unknown,
        _options?: Record<string, unknown>
      ) => ({
        completion: 'ai result',
        usage: null,
      })
    );
    const llm = {
      model: 'gpt-test',
      provider: 'test',
      name: 'test',
      model_name: 'gpt-test',
      ainvoke,
    } as unknown as BaseChatModel;
    const agent = new Agent({
      task: 'test ai step markdown extraction',
      llm,
    });

    vi.spyOn(
      agent.browser_session as any,
      'get_current_page'
    ).mockResolvedValue({
      url: () => 'https://example.com/path',
      content: vi.fn(
        async () => '<html><body><h1>Title</h1><p>Hello world</p></body></html>'
      ),
    } as any);

    const result = await (agent as any)._execute_ai_step(
      'Find title',
      false,
      false,
      null,
      null
    );

    expect(ainvoke).toHaveBeenCalledTimes(1);
    const messages =
      ((ainvoke.mock.calls[0] as unknown[] | undefined)?.[0] as any[]) ?? [];
    expect(String(messages?.[1]?.content ?? '')).toContain(
      'Content processed:'
    );
    expect(String(messages?.[1]?.content ?? '')).toContain('HTML chars');
    expect(result.extracted_content).toContain(
      '<url>\nhttps://example.com/path\n</url>'
    );
    expect(result.extracted_content).toContain('<query>\nFind title\n</query>');

    await agent.close();
  });

  it('bounds page-controlled HTML before an AI step', async () => {
    const ainvoke = vi.fn(async () => ({
      completion: 'ai result',
      usage: null,
    }));
    const llm = {
      model: 'gpt-test',
      provider: 'test',
      name: 'test',
      model_name: 'gpt-test',
      ainvoke,
    } as unknown as BaseChatModel;
    const agent = new Agent({ task: 'test bounded ai step', llm });
    const content = vi.fn(async () => {
      throw new Error(
        'page.content must not be used when evaluate is available'
      );
    });

    vi.spyOn(
      agent.browser_session as any,
      'get_current_page'
    ).mockResolvedValue({
      url: () => 'https://example.com/path',
      content,
      evaluate: vi.fn(async () => ({
        html: '<html><body><p>bounded content</p></body></html>',
        truncated: true,
        visitedNodes: 5,
        sourceUrl: 'https://example.com/path',
      })),
    } as any);

    await (agent as any)._execute_ai_step(
      'Find content',
      false,
      false,
      null,
      null
    );

    expect(content).not.toHaveBeenCalled();
    const messages =
      ((ainvoke.mock.calls[0] as unknown[] | undefined)?.[0] as any[]) ?? [];
    expect(String(messages?.[1]?.content ?? '')).toContain(
      'source HTML truncated at 4,194,304 chars'
    );

    await agent.close();
  });

  it('rejects AI-step content captured after a disallowed navigation', async () => {
    const agent = new Agent({
      task: 'test ai step domain policy',
      llm: createLlm(),
    });
    vi.spyOn(
      agent.browser_session as any,
      'get_current_page'
    ).mockResolvedValue({
      url: () => 'https://example.com/path',
      evaluate: vi.fn(async () => ({
        html: '<html><body>secret</body></html>',
        truncated: false,
        visitedNodes: 3,
        sourceUrl: 'https://evil.test/private',
      })),
    } as any);
    vi.spyOn(agent.browser_session as any, 'is_url_allowed').mockReturnValue(
      false
    );

    const result = await (agent as any)._execute_ai_step(
      'Find content',
      false,
      false,
      null,
      null
    );

    expect(result.error).toContain('blocked by browser domain policy');
    await agent.close();
  });

  it('executes extract actions via AI step during history replay', async () => {
    const agent = new Agent({
      task: 'test extract ai-step replay',
      llm: createLlm(),
    });

    vi.spyOn(
      agent.browser_session as any,
      'get_browser_state_with_recovery'
    ).mockResolvedValue({
      element_tree: {
        clickable_elements_to_string: () => '',
      },
      selector_map: {},
    } as any);
    const multiActSpy = vi
      .spyOn(agent, 'multi_act')
      .mockResolvedValue([
        new ActionResult({ extracted_content: 'clicked menu button' }),
      ]);
    const aiStepSpy = vi
      .spyOn(agent as any, '_execute_ai_step')
      .mockResolvedValue(
        new ActionResult({ extracted_content: 'ai extracted content' })
      );
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);

    const clickAction = {
      get_index: () => 3,
      model_dump: () => ({ click: { index: 3 } }),
    };
    const extractAction = {
      get_index: () => null,
      model_dump: () => ({
        extract_structured_data: { query: 'Find pricing', extract_links: true },
      }),
    };

    const results = await (agent as any)._execute_history_step(
      {
        model_output: {
          action: [clickAction, extractAction],
        },
        state: {
          interacted_element: [null, null],
        },
      },
      0,
      null,
      false,
      createLlm('gpt-ai-step', 'openai')
    );

    expect(multiActSpy).toHaveBeenCalledTimes(1);
    expect(multiActSpy.mock.calls[0]?.[0]).toEqual([{ click: { index: 3 } }]);
    expect(aiStepSpy).toHaveBeenCalledWith(
      'Find pricing',
      false,
      true,
      expect.anything(),
      null
    );
    expect(
      results.map((result: ActionResult) => result.extracted_content)
    ).toEqual(['clicked menu button', 'ai extracted content']);

    await agent.close();
  });

  it('waits step delay before executing replayed actions', async () => {
    const agent = new Agent({
      task: 'test replay delay ordering',
      llm: createLlm(),
    });

    vi.spyOn(
      agent.browser_session as any,
      'get_browser_state_with_recovery'
    ).mockResolvedValue({
      element_tree: {
        clickable_elements_to_string: () => '',
      },
      selector_map: {},
    } as any);
    const sleepSpy = vi
      .spyOn(agent as any, '_sleep')
      .mockResolvedValue(undefined);
    const multiActSpy = vi
      .spyOn(agent, 'multi_act')
      .mockResolvedValue([new ActionResult({ extracted_content: 'done' })]);

    const action = {
      get_index: () => null,
      model_dump: () => ({ done: { text: 'ok', success: true } }),
    };

    await (agent as any)._execute_history_step(
      {
        model_output: { action: [action] },
        state: { interacted_element: [null] },
      },
      0.75,
      null,
      false,
      null
    );

    expect(sleepSpy).toHaveBeenCalledWith(0.75, null);
    const sleepOrder = sleepSpy.mock.invocationCallOrder[0] ?? 0;
    const multiActOrder = multiActSpy.mock.invocationCallOrder[0] ?? 0;
    expect(sleepOrder).toBeGreaterThan(0);
    expect(multiActOrder).toBeGreaterThan(0);
    expect(sleepOrder).toBeLessThan(multiActOrder);

    await agent.close();
  });

  it('wait_for_elements skips minimum-element wait for non-element actions', async () => {
    const agent = new Agent({
      task: 'test conditional wait - skip',
      llm: createLlm(),
    });

    const waitSpy = vi
      .spyOn(agent as any, '_waitForMinimumElements')
      .mockResolvedValue(null);
    vi.spyOn(
      agent.browser_session as any,
      'get_browser_state_with_recovery'
    ).mockResolvedValue({
      element_tree: {
        clickable_elements_to_string: () => '',
      },
      selector_map: {},
    } as any);
    vi.spyOn(agent, 'multi_act').mockResolvedValue([
      new ActionResult({ extracted_content: 'done' }),
    ]);
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);

    await (agent as any)._execute_history_step(
      {
        model_output: {
          action: [
            {
              get_index: () => null,
              model_dump: () => ({ done: { text: 'ok', success: true } }),
            },
          ],
        },
        state: { interacted_element: [null] },
      },
      0,
      null,
      true,
      null
    );

    expect(waitSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('wait_for_elements waits for element-targeting actions with history element', async () => {
    const agent = new Agent({
      task: 'test conditional wait - use',
      llm: createLlm(),
    });

    const liveNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      { id: 'cta' },
      []
    );
    liveNode.highlight_index = 0;

    const waitedState = {
      element_tree: {
        clickable_elements_to_string: () => '',
      },
      selector_map: {
        0: liveNode,
      },
    } as any;
    const waitSpy = vi
      .spyOn(agent as any, '_waitForMinimumElements')
      .mockResolvedValue(waitedState);
    const stateSpy = vi.spyOn(
      agent.browser_session as any,
      'get_browser_state_with_recovery'
    );
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);
    vi.spyOn(agent, 'multi_act').mockResolvedValue([
      new ActionResult({ extracted_content: 'clicked' }),
    ]);

    const clickAction = {
      _index: 0,
      get_index() {
        return this._index;
      },
      set_index(index: number) {
        this._index = index;
      },
      model_dump() {
        return { click: { index: this._index } };
      },
    };

    await (agent as any)._execute_history_step(
      {
        model_output: { action: [clickAction] },
        state: {
          interacted_element: [
            {
              tag_name: 'button',
              xpath: '/html/body/button[1]',
              attributes: { id: 'cta' },
            },
          ],
        },
      },
      0,
      null,
      true,
      null
    );

    expect(waitSpy).toHaveBeenCalledWith(1, 15, 1, null);
    expect(stateSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('reopens dropdown menu once when rerun cannot match a menu item element', async () => {
    const agent = new Agent({
      task: 'test rerun dropdown reopen',
      llm: createLlm(),
    });

    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValueOnce([
        new ActionResult({ extracted_content: 'opened' }),
      ])
      .mockRejectedValueOnce(
        new Error('Could not find matching element for action 0')
      )
      .mockResolvedValueOnce([
        new ActionResult({ extracted_content: 'menu reopened' }),
      ])
      .mockResolvedValueOnce([
        new ActionResult({ extracted_content: 'menu item clicked' }),
      ]);
    const sleepSpy = vi
      .spyOn(agent as any, '_sleep')
      .mockResolvedValue(undefined);

    const clickAction = {
      get_index: () => 1,
      model_dump: () => ({ click: { index: 1 } }),
    };

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Open menu' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'button',
                xpath: '/html/body/button[1]',
                attributes: {
                  role: 'button',
                  'aria-haspopup': 'true',
                  'aria-expanded': 'false',
                },
              },
            ],
          },
          result: [],
        },
        {
          model_output: {
            current_state: { next_goal: 'Click menu item' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'div',
                xpath: '/html/body/div[2]',
                attributes: {
                  role: 'menuitem',
                  class: 'dropdown-menu-item',
                },
                ax_name: 'Settings',
              },
            ],
          },
          result: [],
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 2,
    });

    expect(executeSpy).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(3);
    expect(results[1]?.extracted_content).toBe('menu item clicked');
    expect(sleepSpy).toHaveBeenCalledWith(0.3, null);

    await agent.close();
  });

  it('matches history elements with ax_name fallback when hash and xpath differ', async () => {
    const agent = new Agent({
      task: 'test ax_name fallback',
      llm: createLlm(),
    });

    const action = {
      _index: 4,
      get_index() {
        return this._index;
      },
      set_index(index: number) {
        this._index = index;
      },
      model_dump() {
        return { click: { index: this._index } };
      },
    };

    const updatedAction = await (agent as any)._update_action_indices(
      {
        tag_name: 'div',
        xpath: '/html/body/div[4]',
        attributes: {},
        ax_name: 'Open Settings',
      },
      action,
      {
        selector_map: {
          11: {
            tag_name: 'div',
            xpath: '/html/body/div[99]',
            attributes: { 'aria-label': 'Open Settings' },
            highlight_index: 11,
            get_all_text_till_next_clickable_element: () => '',
            children: [],
          },
        },
      }
    );

    expect(updatedAction).toBe(action);
    expect(action._index).toBe(11);

    await agent.close();
  });

  it('matches history elements with stable_hash fallback when classes drift', async () => {
    const agent = new Agent({
      task: 'test stable hash fallback',
      llm: createLlm(),
    });

    const historicalNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      { class: 'btn focus', id: 'settings' },
      []
    );
    const liveNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[9]',
      { class: 'btn active', id: 'settings' },
      []
    );
    liveNode.highlight_index = 12;
    const stableHash = HistoryTreeProcessor.compute_stable_hash(historicalNode);

    const action = {
      _index: 4,
      get_index() {
        return this._index;
      },
      set_index(index: number) {
        this._index = index;
      },
      model_dump() {
        return { click: { index: this._index } };
      },
    };

    const updatedAction = await (agent as any)._update_action_indices(
      {
        tag_name: 'button',
        xpath: '/html/body/button[1]',
        attributes: { class: 'btn focus', id: 'settings' },
        element_hash: 'old-hash',
        stable_hash: stableHash,
      },
      action,
      {
        selector_map: {
          12: liveNode,
        },
      }
    );

    expect(updatedAction).toBe(action);
    expect(action._index).toBe(12);

    await agent.close();
  });
});
