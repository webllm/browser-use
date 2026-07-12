import { describe, expect, it, vi } from 'vitest';
import {
  buildScrollToTextExpression,
  MAX_SCROLL_TEXT_CHARS,
} from '../src/browser/text-search.js';

const runExpression = (expression: string, textNodes: string[]) => {
  const scrollIntoView = vi.fn();
  const nodes = textNodes.map((nodeValue) => ({
    nodeValue,
    parentElement: { tagName: 'P', scrollIntoView },
  }));
  let index = 0;
  const document = {
    body: {},
    createTreeWalker: () => ({
      nextNode: () => nodes[index++] ?? null,
    }),
  };
  const execute = new Function(
    'document',
    'NodeFilter',
    `return ${expression};`
  );
  const result = execute(document, { SHOW_TEXT: 4 });
  return { result, scrollIntoView };
};

describe('bounded scroll-to-text search', () => {
  it('finds text across adjacent text nodes without scanning parent subtrees', () => {
    const { result, scrollIntoView } = runExpression(
      buildScrollToTextExpression('checkout', 'down'),
      ['check', 'out now']
    );

    expect(result.found).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('contains script-like query text and enforces the scan budget', () => {
    const malicious = `not-found"}); globalThis.__scrollSearchPwned = true; //`;
    const { result } = runExpression(
      buildScrollToTextExpression(malicious, 'down'),
      ['x'.repeat(MAX_SCROLL_TEXT_CHARS + 100)]
    );

    expect(result).toMatchObject({
      found: false,
      truncated: true,
      scannedChars: MAX_SCROLL_TEXT_CHARS,
    });
    expect((globalThis as any).__scrollSearchPwned).toBeUndefined();
  });
});
