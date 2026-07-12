import { describe, expect, it, vi } from 'vitest';
import {
  extractBoundedPageHtml,
  MAX_MAIN_PAGE_HTML_CHARS,
  MAX_PAGE_HTML_SELECTOR_CHARS,
} from '../src/browser/page-content.js';

describe('bounded page HTML extraction', () => {
  it('uses the bounded page-context serializer instead of content()', async () => {
    const content = vi.fn(async () => 'secret'.repeat(1_000_000));
    const evaluate = vi.fn(async (_fn: unknown, limits: any) => ({
      html: 'x'.repeat(limits.maxOutputChars + 1_000),
      truncated: false,
      visitedNodes: 12,
      sourceUrl: 'https://example.com/page',
      rootFound: true,
    }));

    const result = await extractBoundedPageHtml(
      { evaluate, content },
      MAX_MAIN_PAGE_HTML_CHARS
    );

    expect(result.html).toHaveLength(MAX_MAIN_PAGE_HTML_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.visitedNodes).toBe(12);
    expect(result.sourceUrl).toBe('https://example.com/page');
    expect(result.rootFound).toBe(true);
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxOutputChars: MAX_MAIN_PAGE_HTML_CHARS,
      })
    );
    expect(content).not.toHaveBeenCalled();
  });

  it('defensively bounds content-only compatibility adapters', async () => {
    const result = await extractBoundedPageHtml(
      { content: vi.fn(async () => 'x'.repeat(10_000)) },
      1_000
    );

    expect(result.html).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
  });

  it('passes a bounded selector to the page serializer', async () => {
    const evaluate = vi.fn(async (_fn: unknown, limits: any) => ({
      html: '<main>content</main>',
      truncated: false,
      visitedNodes: 2,
      sourceUrl: 'https://example.com/page',
      rootFound: true,
      selector: limits.rootSelector,
    }));

    const result = await extractBoundedPageHtml(
      { evaluate },
      MAX_MAIN_PAGE_HTML_CHARS,
      { selector: `main${'x'.repeat(3_000)}` }
    );

    expect(result.rootFound).toBe(true);
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        rootSelector: expect.stringMatching(/^mainx+$/),
      })
    );
    expect((evaluate.mock.calls[0]?.[1] as any).rootSelector).toHaveLength(
      MAX_PAGE_HTML_SELECTOR_CHARS
    );
  });
});
