import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { ActionLoopDetector, compute_action_hash } from '../src/agent/views.js';

const createLlm = (): BaseChatModel =>
  ({
    model: 'gpt-test',
    get provider() {
      return 'test';
    },
    get name() {
      return 'test';
    },
    get model_name() {
      return 'gpt-test';
    },
    ainvoke: vi.fn(async () => ({ completion: 'ok', usage: null })),
  }) as unknown as BaseChatModel;

const getContextMessageTexts = (agent: Agent) =>
  agent.state.message_manager_state.history.context_messages
    .map((message: any) =>
      typeof message?.content === 'string' ? message.content : null
    )
    .filter((message): message is string => typeof message === 'string');

describe('Action loop detection', () => {
  it('normalizes search query token order and casing for hashing', () => {
    const first = compute_action_hash('search_google', {
      query: 'site:Example.com answers votes',
    });
    const second = compute_action_hash('search_google', {
      query: 'votes answers site:example.com',
    });

    expect(first).toBe(second);
  });

  it('treats different search engines as different loop signatures', () => {
    const googleHash = compute_action_hash('search', {
      query: 'best headphones under 100',
      engine: 'google',
    });
    const bingHash = compute_action_hash('search', {
      query: 'best headphones under 100',
      engine: 'bing',
    });

    expect(googleHash).not.toBe(bingHash);
  });

  it('normalizes scroll action aliases into one loop signature', () => {
    const scrollHash = compute_action_hash('scroll', {
      down: true,
      pages: 1,
      index: 3,
    });
    const scrollPageHash = compute_action_hash('scroll_page', {
      down: true,
      num_pages: 1,
      index: 3,
    });
    const scrollDownHash = compute_action_hash('scroll_down', {
      index: 3,
    });

    expect(scrollHash).toBe(scrollPageHash);
    expect(scrollHash).toBe(scrollDownHash);
  });

  it('bounds cyclic and deeply nested custom action parameters', () => {
    const cyclic: Record<string, unknown> = { value: 'same' };
    cyclic.self = cyclic;

    const deeplyNested: Record<string, unknown> = {};
    let cursor = deeplyNested;
    for (let depth = 0; depth < 5_000; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }

    const cyclicHash = compute_action_hash('custom', cyclic);
    expect(cyclicHash).toMatch(/^[a-f0-9]{12}$/);
    expect(compute_action_hash('custom', cyclic)).toBe(cyclicHash);
    expect(compute_action_hash('custom', deeplyNested)).toMatch(
      /^[a-f0-9]{12}$/
    );
  });

  it('does not invoke action parameter accessors while hashing', () => {
    const params: Record<string, unknown> = { safe: 'value' };
    Object.defineProperty(params, 'secret', {
      enumerable: true,
      get() {
        throw new Error('accessor should not run');
      },
    });

    expect(compute_action_hash('custom', params)).toMatch(/^[a-f0-9]{12}$/);
  });

  it('emits repeated-action nudge at threshold', () => {
    const detector = new ActionLoopDetector({ window_size: 20 });
    for (let i = 0; i < 5; i += 1) {
      detector.record_action('search_google', {
        query: 'site:hinative.com answers votes',
      });
    }

    const nudge = detector.get_nudge_message();
    expect(nudge).not.toBeNull();
    expect(nudge).toContain('repeated a similar action 5 times');
  });

  it('emits page stagnation nudge after repeated identical page states', () => {
    const detector = new ActionLoopDetector({ window_size: 20 });
    detector.record_page_state('https://example.com', 'same content', 50);
    for (let i = 0; i < 5; i += 1) {
      detector.record_page_state('https://example.com', 'same content', 50);
    }

    const nudge = detector.get_nudge_message();
    expect(nudge).not.toBeNull();
    expect(nudge).toContain('page content has not changed');
  });
});

describe('Agent loop detection integration', () => {
  it('injects loop nudge into context messages', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      for (let i = 0; i < 5; i += 1) {
        agent.state.loop_detector.record_action('search_google', {
          query: 'site:example.com answers',
        });
      }

      (agent as any)._inject_loop_detection_nudge();
      const messages = getContextMessageTexts(agent);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('repeated a similar action');
    } finally {
      await agent.close();
    }
  });

  it('skips exempt actions when recording loop detection history', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      agent.state.last_model_output = {
        action: [
          { model_dump: () => ({ wait: { seconds: 1 } }) },
          { model_dump: () => ({ done: { text: 'ok', success: true } }) },
          { model_dump: () => ({ go_back: {} }) },
          {
            model_dump: () => ({
              search_google: { query: 'site:example.com' },
            }),
          },
        ],
      } as any;

      (agent as any)._update_loop_detector_actions();
      expect(agent.state.loop_detector.recent_action_hashes).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });
});
