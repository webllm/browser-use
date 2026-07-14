import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SMART_SCROLL_ELEMENTS,
  SMART_SCROLL_JS,
} from '../src/browser/smart-scroll.js';

describe('bounded smart scrolling', () => {
  it('shares the traversal budget with the active-element ancestor chain', () => {
    type ScrollNode = {
      clientHeight: number;
      scrollHeight: number;
      parentElement: ScrollNode | null;
    };
    const root: ScrollNode = {
      clientHeight: 10,
      scrollHeight: 10,
      parentElement: null,
    };
    let activeElement: ScrollNode = root;
    for (let index = 0; index < MAX_SMART_SCROLL_ELEMENTS + 100; index += 1) {
      activeElement = {
        clientHeight: 10,
        scrollHeight: 10,
        parentElement: activeElement,
      };
    }
    const createTreeWalker = vi.fn(() => ({
      nextNode: vi.fn(() => null),
    }));
    const document = {
      activeElement,
      body: root,
      documentElement: root,
      scrollingElement: root,
      createTreeWalker,
    };
    const getComputedStyle = vi.fn(() => ({ overflowY: 'visible' }));
    const window = { innerHeight: 800, scrollBy: vi.fn() };
    const execute = new Function(
      'window',
      'document',
      'NodeFilter',
      'getComputedStyle',
      `return (${SMART_SCROLL_JS})(500);`
    );

    execute(window, document, { SHOW_ELEMENT: 1 }, getComputedStyle);

    expect(getComputedStyle).toHaveBeenCalledTimes(MAX_SMART_SCROLL_ELEMENTS);
    expect(createTreeWalker).not.toHaveBeenCalled();
    expect(window.scrollBy).toHaveBeenCalledWith(0, 500);
  });

  it('does not enumerate an unbounded page when no scroll container exists', () => {
    const nodes = Array.from(
      { length: MAX_SMART_SCROLL_ELEMENTS + 100 },
      () => ({ clientHeight: 10, scrollHeight: 10, parentElement: null })
    );
    let index = 0;
    const root = { clientHeight: 10, scrollHeight: 10 };
    const document = {
      activeElement: null,
      body: root,
      documentElement: root,
      scrollingElement: root,
      createTreeWalker: vi.fn(() => ({
        nextNode: vi.fn(() => nodes[index++] ?? null),
      })),
    };
    const getComputedStyle = vi.fn(() => ({ overflowY: 'visible' }));
    const window = { innerHeight: 800, scrollBy: vi.fn() };
    const execute = new Function(
      'window',
      'document',
      'NodeFilter',
      'getComputedStyle',
      `return (${SMART_SCROLL_JS})(500);`
    );

    execute(window, document, { SHOW_ELEMENT: 1 }, getComputedStyle);

    expect(getComputedStyle).toHaveBeenCalledTimes(MAX_SMART_SCROLL_ELEMENTS);
    expect(window.scrollBy).toHaveBeenCalledWith(0, 500);
  });

  it('stops at the first bounded scroll container', () => {
    const scrollBy = vi.fn();
    const nodes = [
      { clientHeight: 10, scrollHeight: 10, parentElement: null },
      {
        clientHeight: 500,
        scrollHeight: 1000,
        parentElement: null,
        scrollBy,
      },
    ];
    let index = 0;
    const root = { clientHeight: 10, scrollHeight: 10 };
    const document = {
      activeElement: null,
      body: root,
      documentElement: root,
      scrollingElement: root,
      createTreeWalker: () => ({
        nextNode: () => nodes[index++] ?? null,
      }),
    };
    const execute = new Function(
      'window',
      'document',
      'NodeFilter',
      'getComputedStyle',
      `return (${SMART_SCROLL_JS})(250);`
    );

    execute(
      { innerHeight: 800, scrollBy: vi.fn() },
      document,
      { SHOW_ELEMENT: 1 },
      (element: unknown) => ({
        overflowY: element === nodes[1] ? 'auto' : 'visible',
      })
    );

    expect(scrollBy).toHaveBeenCalledWith(0, 250);
  });
});
