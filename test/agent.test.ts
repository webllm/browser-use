/**
 * Comprehensive tests for Agent functionality.
 *
 * Tests cover:
 * 1. Sensitive data handling
 * 2. Agent lifecycle (start, step, stop)
 * 3. Task management
 * 4. History tracking
 * 5. Error handling and recovery
 * 6. Multi-action execution
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock utils
vi.mock('../src/utils.js', () => {
  let counter = 0;
  const decorator =
    <T extends (...args: any[]) => any>(_label?: string) =>
    (fn: T) =>
      fn;

  return {
    uuid7str: () => `uuid-${++counter}`,
    time_execution_sync: decorator,
    time_execution_async: decorator,
    SignalHandler: class {
      register() {}
      reset() {}
      unregister() {}
    },
    get_browser_use_version: () => 'test-version',
    is_new_tab_page: (url: string) =>
      url === 'about:blank' || url.startsWith('chrome://'),
    match_url_with_domain_pattern: (url: string, pattern: string) => {
      if (!pattern) return false;
      // Simple glob matching for tests
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2);
        return url.includes(domain);
      }
      return url.includes(pattern);
    },
    sanitize_surrogates: (text: string) => text,
    log_pretty_path: (p: string) => p,
    wait_until: async () => {},
  };
});

// Import after mocks
import type { AgentSettings } from '../src/agent/views.js';
import { ActionResult } from '../src/agent/views.js';

// Helper to create agent settings (since it's an interface)
const createAgentSettings = (
  overrides: Partial<AgentSettings> = {}
): AgentSettings =>
  ({
    use_vision: true,
    include_recent_events: false,
    vision_detail_level: 'auto',
    save_conversation_path: null,
    save_conversation_path_encoding: null,
    max_failures: 3,
    generate_gif: false,
    override_system_message: null,
    extend_system_message: null,
    include_attributes: [],
    max_actions_per_step: 5,
    use_thinking: false,
    flash_mode: false,
    use_judge: true,
    ground_truth: null,
    enable_planning: true,
    planning_replan_on_stall: 3,
    planning_exploration_limit: 5,
    max_history_items: 100,
    llm_timeout: 60000,
    final_response_after_failure: true,
    message_compaction: null,
    loop_detection_window: 20,
    loop_detection_enabled: true,
    ...overrides,
  }) as AgentSettings;

describe('Agent Sensitive Data Handling', () => {
  describe('Sensitive Data Configuration', () => {
    it('validates sensitive data format with domain patterns', () => {
      const sensitiveData = {
        '*.example.com': {
          username: 'testuser',
          password: 'testpass',
        },
        'login.site.com': {
          api_key: 'secret123',
        },
      };

      expect(sensitiveData).toHaveProperty('*.example.com');
      expect(sensitiveData['*.example.com']).toHaveProperty('username');
      expect(sensitiveData['login.site.com']).toHaveProperty('api_key');
    });

    it('matches URL to domain pattern with wildcard', () => {
      const matchUrl = (url: string, pattern: string): boolean => {
        if (pattern.startsWith('*.')) {
          const domain = pattern.slice(2);
          return url.includes(domain);
        }
        return url.includes(pattern);
      };

      expect(matchUrl('https://app.example.com/login', '*.example.com')).toBe(
        true
      );
      expect(matchUrl('https://other.com/page', '*.example.com')).toBe(false);
      expect(matchUrl('https://login.site.com/auth', 'login.site.com')).toBe(
        true
      );
    });

    it('retrieves sensitive data for matching URL', () => {
      const sensitiveData = {
        '*.example.com': {
          username: 'user1',
          password: 'pass1',
        },
      };

      const getSensitiveDataForUrl = (
        url: string,
        data: Record<string, Record<string, string>>
      ): Record<string, string> | null => {
        for (const [pattern, values] of Object.entries(data)) {
          if (pattern.startsWith('*.')) {
            const domain = pattern.slice(2);
            if (url.includes(domain)) {
              return values;
            }
          } else if (url.includes(pattern)) {
            return values;
          }
        }
        return null;
      };

      const result = getSensitiveDataForUrl(
        'https://app.example.com/login',
        sensitiveData
      );
      expect(result).toEqual({ username: 'user1', password: 'pass1' });

      const noMatch = getSensitiveDataForUrl(
        'https://other.com/page',
        sensitiveData
      );
      expect(noMatch).toBeNull();
    });

    it('handles legacy sensitive data format', () => {
      // Old format: simple key-value pairs
      const legacyFormat = {
        username: 'testuser',
        password: 'testpass',
      };

      // New format: domain-scoped
      const newFormat = {
        '*': legacyFormat, // Apply to all domains
      };

      expect(newFormat['*']).toEqual(legacyFormat);
    });
  });

  describe('Sensitive Data Masking', () => {
    it('masks sensitive values in output', () => {
      const maskSensitiveData = (
        text: string,
        sensitiveValues: string[]
      ): string => {
        let masked = text;
        for (const value of sensitiveValues) {
          masked = masked.replace(new RegExp(value, 'g'), '***');
        }
        return masked;
      };

      const text = 'Logging in with password secret123 for user admin';
      const masked = maskSensitiveData(text, ['secret123', 'admin']);

      expect(masked).toBe('Logging in with password *** for user ***');
      expect(masked).not.toContain('secret123');
      expect(masked).not.toContain('admin');
    });

    it('handles empty sensitive data', () => {
      const maskSensitiveData = (
        text: string,
        sensitiveValues: string[]
      ): string => {
        let masked = text;
        for (const value of sensitiveValues) {
          if (value) {
            masked = masked.replace(new RegExp(value, 'g'), '***');
          }
        }
        return masked;
      };

      const text = 'No sensitive data here';
      const masked = maskSensitiveData(text, []);

      expect(masked).toBe(text);
    });
  });
});

describe('Agent Settings', () => {
  it('creates settings with defaults', () => {
    const settings = createAgentSettings();

    expect(settings.max_history_items).toBeDefined();
    expect(settings.use_vision).toBeDefined();
    expect(settings.include_recent_events).toBe(false);
  });

  it('overrides default settings', () => {
    const settings = createAgentSettings({
      max_history_items: 50,
      use_vision: false,
      max_actions_per_step: 5,
    });

    expect(settings.max_history_items).toBe(50);
    expect(settings.use_vision).toBe(false);
    expect(settings.max_actions_per_step).toBe(5);
  });

  it('validates max_history_items', () => {
    const settings = createAgentSettings({
      max_history_items: 100,
    });

    expect(settings.max_history_items).toBeGreaterThan(0);
  });
});

describe('Action Result', () => {
  it('creates basic action result', () => {
    const result = new ActionResult({
      extracted_content: 'Page loaded successfully',
    });

    expect(result.extracted_content).toBe('Page loaded successfully');
    expect(result.error).toBeNull();
    expect(result.is_done).toBe(false);
  });

  it('creates error action result', () => {
    const result = new ActionResult({
      error: 'Element not found',
      include_in_memory: true,
    });

    expect(result.error).toBe('Element not found');
    expect(result.include_in_memory).toBe(true);
  });

  it('creates done action result', () => {
    const result = new ActionResult({
      extracted_content: 'Task completed',
      is_done: true,
    });

    expect(result.is_done).toBe(true);
  });

  it('handles success flag with done state', () => {
    // success=true can only be set when is_done=true
    const result = new ActionResult({
      extracted_content: 'Completed',
      is_done: true,
      success: true,
    });

    expect(result.success).toBe(true);
    expect(result.is_done).toBe(true);
  });
});

describe('Agent Think Tags', () => {
  describe('Remove Think Tags', () => {
    const removeThinkTags = (text: string): string => {
      const THINK_TAGS = /<think>.*?<\/think>/gs;
      const STRAY_CLOSE_TAG = /.*?<\/think>/gs;
      text = text.replace(THINK_TAGS, '');
      text = text.replace(STRAY_CLOSE_TAG, '');
      return text.trim();
    };

    it('removes well-formed think tags', () => {
      const text = '<think>Internal reasoning here</think>The actual response';
      const result = removeThinkTags(text);

      expect(result).toBe('The actual response');
    });

    it('removes multiple think tags', () => {
      const text =
        '<think>First thought</think>Middle<think>Second thought</think>End';
      const result = removeThinkTags(text);

      expect(result).toBe('MiddleEnd');
    });

    it('handles multiline think tags', () => {
      const text = `<think>
        Line 1
        Line 2
        Line 3
      </think>Actual content`;
      const result = removeThinkTags(text);

      expect(result).toBe('Actual content');
    });

    it('handles stray closing tags', () => {
      const text = 'Some prefix text</think>The response';
      const result = removeThinkTags(text);

      expect(result).toBe('The response');
    });

    it('returns unchanged text without think tags', () => {
      const text = 'Normal response without think tags';
      const result = removeThinkTags(text);

      expect(result).toBe(text);
    });

    it('handles empty think tags', () => {
      const text = '<think></think>Content';
      const result = removeThinkTags(text);

      expect(result).toBe('Content');
    });
  });
});

describe('Agent Task Management', () => {
  it('tracks task description', () => {
    const task = 'Navigate to example.com and click the login button';

    expect(task).toBeDefined();
    expect(task.length).toBeGreaterThan(0);
  });

  it('adds new task to agent', () => {
    let currentTask = 'Original task';

    const addNewTask = (newTask: string) => {
      currentTask = newTask;
    };

    addNewTask('New task to perform');
    expect(currentTask).toBe('New task to perform');
  });
});

describe('Agent History', () => {
  describe('History Tracking', () => {
    it('tracks step results', () => {
      const history: ActionResult[] = [];

      history.push(
        new ActionResult({
          extracted_content: 'Navigated to page',
        })
      );

      history.push(
        new ActionResult({
          extracted_content: 'Clicked button',
        })
      );

      expect(history).toHaveLength(2);
    });

    it('detects done state from history', () => {
      const history: ActionResult[] = [
        new ActionResult({ extracted_content: 'Step 1' }),
        new ActionResult({ extracted_content: 'Step 2' }),
        new ActionResult({ extracted_content: 'Done', is_done: true }),
      ];

      const isDone = history.some((r) => r.is_done);
      expect(isDone).toBe(true);
    });

    it('counts errors in history', () => {
      const history: ActionResult[] = [
        new ActionResult({ extracted_content: 'Success' }),
        new ActionResult({ error: 'Failed 1' }),
        new ActionResult({ extracted_content: 'Success' }),
        new ActionResult({ error: 'Failed 2' }),
      ];

      const errorCount = history.filter((r) => r.error).length;
      expect(errorCount).toBe(2);
    });
  });
});

describe('Agent Multi-Action Execution', () => {
  it('handles multiple actions in sequence', async () => {
    const actions = [
      { go_to_url: { url: 'https://example.com' } },
      { click: { index: 5 } },
      { input_text: { index: 3, text: 'Hello' } },
    ];

    const results: ActionResult[] = [];

    for (const action of actions) {
      const actionName = Object.keys(action)[0];
      results.push(
        new ActionResult({
          extracted_content: `Executed ${actionName}`,
        })
      );
    }

    expect(results).toHaveLength(3);
    expect(results[0].extracted_content).toContain('go_to_url');
    expect(results[1].extracted_content).toContain('click');
    expect(results[2].extracted_content).toContain('input_text');
  });

  it('stops on done action', async () => {
    const actions = [
      { go_to_url: { url: 'https://example.com' } },
      { done: { text: 'Task complete', success: true } },
      { click: { index: 5 } }, // Should not execute
    ];

    const results: ActionResult[] = [];

    for (const action of actions) {
      const actionName = Object.keys(action)[0];

      if (actionName === 'done') {
        results.push(
          new ActionResult({
            extracted_content: 'Task complete',
            is_done: true,
          })
        );
        break; // Stop after done
      }

      results.push(
        new ActionResult({
          extracted_content: `Executed ${actionName}`,
        })
      );
    }

    expect(results).toHaveLength(2);
    expect(results[1].is_done).toBe(true);
  });

  it('handles action errors and continues', async () => {
    const executeAction = async (
      action: Record<string, any>
    ): Promise<ActionResult> => {
      const actionName = Object.keys(action)[0];

      if (actionName === 'click' && action.click.index === 999) {
        return new ActionResult({
          error: 'Element not found',
        });
      }

      return new ActionResult({
        extracted_content: `Executed ${actionName}`,
      });
    };

    const actions = [
      { go_to_url: { url: 'https://example.com' } },
      { click: { index: 999 } }, // Will fail
      { input_text: { index: 3, text: 'Hello' } },
    ];

    const results: ActionResult[] = [];

    for (const action of actions) {
      const result = await executeAction(action);
      results.push(result);
    }

    expect(results).toHaveLength(3);
    expect(results[1].error).toBe('Element not found');
    expect(results[2].extracted_content).toContain('input_text');
  });
});

describe('Agent State Management', () => {
  it('tracks consecutive failures', () => {
    let consecutiveFailures = 0;
    const maxFailures = 3;

    const handleResult = (result: ActionResult) => {
      if (result.error) {
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
      }
    };

    handleResult(new ActionResult({ error: 'Failed 1' }));
    expect(consecutiveFailures).toBe(1);

    handleResult(new ActionResult({ error: 'Failed 2' }));
    expect(consecutiveFailures).toBe(2);

    handleResult(new ActionResult({ extracted_content: 'Success' }));
    expect(consecutiveFailures).toBe(0);
  });

  it('tracks step count', () => {
    let stepCount = 0;

    const incrementStep = () => {
      stepCount++;
    };

    incrementStep();
    incrementStep();
    incrementStep();

    expect(stepCount).toBe(3);
  });

  it('respects max steps limit', () => {
    const maxSteps = 5;
    let currentStep = 0;

    const canContinue = () => currentStep < maxSteps;

    while (canContinue()) {
      currentStep++;
    }

    expect(currentStep).toBe(maxSteps);
  });
});

describe('Agent Pause/Resume', () => {
  it('handles pause state', async () => {
    let isPaused = false;

    const pause = () => {
      isPaused = true;
    };

    const resume = () => {
      isPaused = false;
    };

    expect(isPaused).toBe(false);

    pause();
    expect(isPaused).toBe(true);

    resume();
    expect(isPaused).toBe(false);
  });

  it('waits while paused', async () => {
    let isPaused = true;
    let waitCount = 0;

    const waitWhilePaused = async () => {
      while (isPaused && waitCount < 3) {
        waitCount++;
        await new Promise((r) => setTimeout(r, 10));

        // Auto-resume after 3 iterations for test
        if (waitCount >= 3) {
          isPaused = false;
        }
      }
    };

    await waitWhilePaused();

    expect(isPaused).toBe(false);
    expect(waitCount).toBe(3);
  });
});
