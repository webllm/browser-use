import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import {
  AgentStepInfo,
  normalizeMessageCompactionSettings,
} from '../src/agent/views.js';
import {
  HistoryItem,
  MessageManagerState,
} from '../src/agent/message-manager/views.js';
import { MessageManager } from '../src/agent/message-manager/service.js';
import { SystemMessage, type Message } from '../src/llm/messages.js';
import type { FileSystem } from '../src/filesystem/file-system.js';

const createLlm = (completion = 'ok', model = 'gpt-test'): BaseChatModel =>
  ({
    model,
    get provider() {
      return 'test';
    },
    get name() {
      return 'test';
    },
    get model_name() {
      return model;
    },
    ainvoke: vi.fn(async () => ({ completion, usage: null })),
  }) as unknown as BaseChatModel;

const createBoundedHistoryManager = (maxHistoryItems = 10) => {
  const state = new MessageManagerState();
  const manager = new MessageManager(
    'test task',
    new SystemMessage('system'),
    {} as FileSystem,
    state,
    true,
    null,
    undefined,
    maxHistoryItems
  );
  return { manager, state };
};

const appendHistoryItems = (
  state: MessageManagerState,
  firstStep: number,
  lastStep: number
) => {
  for (let step = firstStep; step <= lastStep; step += 1) {
    state.agent_history_items.push(
      new HistoryItem(step, null, `history-${step}`, null, null, null, null)
    );
  }
};

describe('Agent message compaction', () => {
  it.each([
    ['compact_every_n_steps', Number.POSITIVE_INFINITY],
    ['compact_every_n_steps', 0],
    ['trigger_char_count', Number.NaN],
    ['trigger_char_count', -1],
    ['trigger_token_count', Number.POSITIVE_INFINITY],
    ['chars_per_token', 0],
    ['keep_last_items', -1],
    ['summary_max_chars', Number.POSITIVE_INFINITY],
  ])('rejects invalid %s values', (key, value) => {
    const settings = {
      trigger_char_count: null,
      trigger_token_count: null,
      [key]: value,
    };

    expect(() => normalizeMessageCompactionSettings(settings)).toThrow();
  });

  it('rejects token thresholds whose derived character count is excessive', () => {
    expect(() =>
      normalizeMessageCompactionSettings({
        trigger_char_count: null,
        trigger_token_count: 4_000_000,
        chars_per_token: 1_000,
      })
    ).toThrow(/trigger threshold/);
  });

  it('compacts history into compacted_memory when thresholds are met', async () => {
    const compactionInvoke = vi.fn(async () => ({
      completion: 'Summary of history',
      usage: null,
    }));
    const compactionLlm = {
      ...createLlm('Summary of history', 'compact-model'),
      ainvoke: compactionInvoke,
    } as unknown as BaseChatModel;
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      message_compaction: {
        enabled: true,
        compact_every_n_steps: 1,
        trigger_char_count: 20,
        trigger_token_count: null,
        chars_per_token: 4,
        keep_last_items: 2,
        summary_max_chars: 200,
        include_read_state: false,
        compaction_llm: compactionLlm,
      },
    });

    try {
      agent.state.message_manager_state.agent_history_items.push(
        new HistoryItem(1, 'ok', 'memory', 'goal', 'A'.repeat(120), null, null)
      );

      await (agent as any)._maybe_compact_messages(new AgentStepInfo(2, 20));

      expect(agent.state.message_manager_state.compaction_count).toBe(1);
      expect(agent.state.message_manager_state.compacted_memory).toBe(
        'Summary of history'
      );
      expect(agent.state.message_manager_state.agent_history_items.length).toBe(
        2
      );
      expect(
        (agent as any)._message_manager.agent_history_description
      ).toContain('<compacted_memory>');
      expect(compactionInvoke).toHaveBeenCalledTimes(1);
    } finally {
      await agent.close();
    }
  });

  it('does not compact before configured step cadence', async () => {
    const compactionInvoke = vi.fn(async () => ({
      completion: 'Should not be used',
      usage: null,
    }));
    const compactionLlm = {
      ...createLlm('Should not be used', 'compact-model'),
      ainvoke: compactionInvoke,
    } as unknown as BaseChatModel;
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      message_compaction: {
        enabled: true,
        compact_every_n_steps: 5,
        trigger_char_count: 20,
        trigger_token_count: null,
        chars_per_token: 4,
        keep_last_items: 2,
        summary_max_chars: 200,
        include_read_state: false,
        compaction_llm: compactionLlm,
      },
    });

    try {
      agent.state.message_manager_state.agent_history_items.push(
        new HistoryItem(1, 'ok', 'memory', 'goal', 'B'.repeat(120), null, null)
      );

      await (agent as any)._maybe_compact_messages(new AgentStepInfo(2, 20));

      expect(agent.state.message_manager_state.compaction_count).toBe(0);
      expect(agent.state.message_manager_state.compacted_memory).toBeNull();
      expect(compactionInvoke).toHaveBeenCalledTimes(0);
    } finally {
      await agent.close();
    }
  });

  it('bounds the history text sent to the compaction model', async () => {
    const { manager, state } = createBoundedHistoryManager();
    for (let step = 1; step <= 12; step += 1) {
      state.agent_history_items.push(
        new HistoryItem(
          step,
          null,
          `${String(step).padStart(2, '0')}-${'x'.repeat(128 * 1024)}`,
          null,
          null,
          null,
          null
        )
      );
    }
    const invoke = vi.fn(async (_messages: Message[]) => ({
      completion: 'bounded',
      usage: null,
    }));
    const llm = {
      ...createLlm('bounded', 'compact-model'),
      ainvoke: invoke,
    } as unknown as BaseChatModel;

    await manager.maybe_compact_messages(
      llm,
      {
        enabled: true,
        compact_every_n_steps: 1,
        trigger_char_count: 1,
        trigger_token_count: null,
        chars_per_token: 4,
        keep_last_items: 2,
        summary_max_chars: 200,
        include_read_state: false,
        compaction_llm: null,
      },
      new AgentStepInfo(1, 20)
    );

    const messages = invoke.mock.calls[0]?.[0] ?? [];
    const compactionInput = messages[1]?.text ?? '';
    expect(compactionInput.length).toBeLessThanOrEqual(1024 * 1024 + 50);
    expect(compactionInput).toContain(
      'additional history omitted for compaction'
    );
  });
});

describe('MessageManager bounded history window', () => {
  it('keeps the rendered prompt prefix stable between archive boundaries', () => {
    const { manager, state } = createBoundedHistoryManager(10);
    appendHistoryItems(state, 1, 10);

    const firstWindow = manager.agent_history_description;
    expect(firstWindow).toContain(
      '<sys>[... 4 archived history items omitted...]</sys>'
    );
    expect(firstWindow).not.toContain('\nhistory-4\n');
    expect(firstWindow).toContain('\nhistory-5\n');

    appendHistoryItems(state, 11, 11);
    const appendedWindow = manager.agent_history_description;

    expect(appendedWindow).toBe(`${firstWindow}\n<step>\nhistory-11`);
  });

  it('uses mergeable binary archive segments at window boundaries', () => {
    const { manager, state } = createBoundedHistoryManager(10);
    appendHistoryItems(state, 1, 17);

    const twoBatchWindow = manager.agent_history_description;
    expect(twoBatchWindow).toContain(
      '<sys>[... 8 archived history items omitted...]</sys>'
    );
    expect(twoBatchWindow).not.toContain('4 archived history items');

    appendHistoryItems(state, 18, 18);
    const threeBatchWindow = manager.agent_history_description;
    const stableArchivePrefix =
      'Agent initialized\n' +
      '<sys>[... 8 archived history items omitted...]</sys>';

    expect(threeBatchWindow.startsWith(stableArchivePrefix)).toBe(true);
    expect(threeBatchWindow).toContain(
      '<sys>[... 4 archived history items omitted...]</sys>'
    );
    expect(threeBatchWindow).toContain('\nhistory-13\n');
    expect(threeBatchWindow).not.toContain('\nhistory-12\n');
  });

  it('keeps archive metadata logarithmically bounded for long runs', () => {
    const { manager, state } = createBoundedHistoryManager(10);
    appendHistoryItems(state, 1, 10_000);

    const description = manager.agent_history_description;
    const segmentSizes = Array.from(
      description.matchAll(/\[\.\.\. (\d+) archived history items omitted/g),
      (match) => Number(match[1])
    );
    const visibleHistoryItems = Array.from(
      description.matchAll(/<step>/g)
    ).length;

    expect(segmentSizes.length).toBeLessThanOrEqual(12);
    expect(segmentSizes.reduce((sum, size) => sum + size, 0)).toBe(
      10_000 - visibleHistoryItems
    );
    expect(visibleHistoryItems).toBeLessThanOrEqual(9);
    expect(description.length).toBeLessThan(5_000);
  });
});
