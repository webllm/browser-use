import { describe, expect, it } from 'vitest';
import { BrowserStateHistory } from '../src/browser/views.js';
import {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentOutput,
} from '../src/agent/views.js';

describe('AgentHistoryList judgement and trace helpers', () => {
  it('returns judgement helpers from final action result', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        null,
        [
          new ActionResult({
            is_done: true,
            success: false,
            judgement: {
              verdict: false,
              reasoning: 'Missing required rows',
            },
          }),
        ],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        null
      )
    );

    expect(history.judgement()).toEqual({
      verdict: false,
      reasoning: 'Missing required rows',
    });
    expect(history.is_judged()).toBe(true);
    expect(history.is_validated()).toBe(false);
  });

  it('returns null validation state when no judgement exists', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        null,
        [new ActionResult({ is_done: true, success: true })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        null
      )
    );

    expect(history.judgement()).toBeNull();
    expect(history.is_judged()).toBe(false);
    expect(history.is_validated()).toBeNull();
  });

  it('formats agent step summaries for trace evaluation', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        new AgentOutput({
          action: [{ search_google: { query: 'browser-use latest' } }] as any,
        }),
        [
          new ActionResult({ extracted_content: 'Found release notes' }),
          new ActionResult({ error: 'Second action failed' }),
        ],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        null
      )
    );

    const steps = history.agent_steps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('Step 1');
    expect(steps[0]).toContain('Actions:');
    expect(steps[0]).toContain('Found release notes');
    expect(steps[0]).toContain('Second action failed');
  });

  it('stops formatting agent steps at the requested character budget', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        null,
        [new ActionResult({ extracted_content: 'x'.repeat(1_000) })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null)
      )
    );
    history.add_item(
      new AgentHistory(
        null,
        [new ActionResult({ extracted_content: 'unread-tail' })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null)
      )
    );

    const steps = history.agent_steps(64);

    expect(steps.join('')).toHaveLength(64);
    expect(steps.join('')).not.toContain('unread-tail');
    expect(() => history.agent_steps(Number.POSITIVE_INFINITY)).toThrow(
      'max_chars must be a non-negative integer or null'
    );
  });
});
