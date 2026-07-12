import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BROWSER_STATE_MESSAGE_CHARS,
  MAX_BROWSER_STATE_TABS,
  MAX_BROWSER_STATE_TITLE_CHARS,
  MAX_BROWSER_STATE_URL_CHARS,
  readBoundedPageTitle,
} from '../src/browser/state-limits.js';
import { BrowserStateSummary } from '../src/browser/views.js';
import { DOMElementNode, DOMState } from '../src/dom/views.js';

describe('browser state metadata limits', () => {
  it('bounds page-controlled metadata before it reaches consumers', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const state = new BrowserStateSummary(new DOMState(root, {}), {
      url: 'u'.repeat(100_000),
      title: 't'.repeat(100_000),
      tabs: Array.from({ length: 500 }, (_, page_id) => ({
        page_id,
        url: 'u'.repeat(100_000),
        title: 't'.repeat(100_000),
      })),
      browser_errors: Array.from({ length: 100 }, () => 'e'.repeat(100_000)),
      closed_popup_messages: Array.from({ length: 100 }, () =>
        'p'.repeat(100_000)
      ),
    });

    expect(state.url).toHaveLength(MAX_BROWSER_STATE_URL_CHARS);
    expect(state.title).toHaveLength(MAX_BROWSER_STATE_TITLE_CHARS);
    expect(state.tabs).toHaveLength(MAX_BROWSER_STATE_TABS);
    expect(state.tabs[0]?.url).toHaveLength(MAX_BROWSER_STATE_URL_CHARS);
    expect(state.tabs[0]?.title).toHaveLength(MAX_BROWSER_STATE_TITLE_CHARS);
    expect(state.browser_errors).toHaveLength(20);
    expect(state.browser_errors[0]).toHaveLength(
      MAX_BROWSER_STATE_MESSAGE_CHARS
    );
    expect(state.closed_popup_messages).toHaveLength(20);
    expect(state.closed_popup_messages[0]).toHaveLength(
      MAX_BROWSER_STATE_MESSAGE_CHARS
    );
  });

  it('requests only a bounded title from the page execution context', async () => {
    const title = vi.fn(async () => 'fallback');
    const evaluate = vi.fn(async (_fn: unknown, maxChars: number) =>
      'x'.repeat(maxChars)
    );
    const locator = vi.fn(() => ({ evaluate }));

    const result = await readBoundedPageTitle({ locator, title });

    expect(result).toHaveLength(MAX_BROWSER_STATE_TITLE_CHARS);
    expect(locator).toHaveBeenCalledWith(':root');
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      MAX_BROWSER_STATE_TITLE_CHARS
    );
    expect(title).not.toHaveBeenCalled();
  });
});
