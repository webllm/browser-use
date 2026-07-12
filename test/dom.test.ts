/**
 * Comprehensive tests for DOM service and History Tree Processor.
 *
 * Tests cover:
 * 1. DOM element hashing and comparison
 * 2. History element conversion
 * 3. Element matching across states
 * 4. DOM tree construction
 * 5. Clickable element extraction
 * 6. Special URL handling (chrome://, about:blank)
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

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
    match_url_with_domain_pattern: () => false,
    sanitize_surrogates: (text: string) => text,
    log_pretty_path: (p: string) => p,
  };
});

// Import after mocks
import { DOMElementNode, DOMTextNode, DOMState } from '../src/dom/views.js';
import {
  HashedDomElement,
  DOMHistoryElement,
} from '../src/dom/history-tree-processor/view.js';
import { HistoryTreeProcessor } from '../src/dom/history-tree-processor/service.js';
import { DomService } from '../src/dom/service.js';

describe('DomService script safeguards', () => {
  it('injects highlight cleanup before DOM rebuild', () => {
    const domService = new DomService({} as any);
    const script = (domService as any).jsCode as string;
    expect(script).toContain('function cleanupHighlights()');
    expect(script).toContain('cleanupHighlights();');
  });
});

describe('DOM Element Classes', () => {
  describe('DOMElementNode', () => {
    it('creates element node with basic properties', () => {
      const element = new DOMElementNode(
        true, // is_visible
        null, // parent
        'button', // tag_name
        '/html/body/button[1]', // xpath
        { id: 'btn1', class: 'primary' }, // attributes
        [] // children
      );

      expect(element.tag_name).toBe('button');
      expect(element.xpath).toBe('/html/body/button[1]');
      expect(element.is_visible).toBe(true);
      expect(element.attributes.id).toBe('btn1');
    });

    it('computes hash for element', () => {
      const element = new DOMElementNode(
        true,
        null,
        'div',
        '/html/body/div[1]',
        { id: 'test' },
        []
      );

      const hash = element.hash;
      expect(hash).toBeDefined();
      expect(hash.branch_path_hash).toBeDefined();
      expect(hash.attributes_hash).toBeDefined();
      expect(hash.xpath_hash).toBeDefined();
    });

    it('computes stable hash without dynamic classes', () => {
      const first = new DOMElementNode(
        true,
        null,
        'button',
        '/html/body/button[1]',
        { class: 'btn focus active', id: 'cta' },
        []
      );
      const second = new DOMElementNode(
        true,
        null,
        'button',
        '/html/body/button[1]',
        { class: 'btn', id: 'cta' },
        []
      );

      const firstExact = HistoryTreeProcessor.compute_element_hash(first);
      const secondExact = HistoryTreeProcessor.compute_element_hash(second);
      const firstStable = HistoryTreeProcessor.compute_stable_hash(first);
      const secondStable = HistoryTreeProcessor.compute_stable_hash(second);

      expect(firstExact).not.toBe(secondExact);
      expect(firstStable).toBe(secondStable);
    });

    it('caches hash computation', () => {
      const element = new DOMElementNode(
        true,
        null,
        'div',
        '/html/body/div[1]',
        { id: 'test' },
        []
      );

      const hash1 = element.hash;
      const hash2 = element.hash;

      // Should return same object (cached)
      expect(hash1).toBe(hash2);
    });

    it('handles children correctly', () => {
      const child1 = new DOMTextNode(true, null, 'Hello');
      const child2 = new DOMTextNode(true, null, 'World');
      const parent = new DOMElementNode(
        true,
        null,
        'div',
        '/html/body/div[1]',
        {},
        [child1, child2]
      );

      expect(parent.children).toHaveLength(2);
      expect(parent.children[0]).toBe(child1);
      expect(parent.children[1]).toBe(child2);
    });

    it('tracks interactive state', () => {
      const element = new DOMElementNode(
        true,
        null,
        'button',
        '/button',
        {},
        []
      );
      element.is_interactive = true;
      element.highlight_index = 5;

      expect(element.is_interactive).toBe(true);
      expect(element.highlight_index).toBe(5);
    });

    it('tracks viewport state', () => {
      const element = new DOMElementNode(true, null, 'div', '/div', {}, []);
      element.is_in_viewport = true;
      element.is_top_element = true;

      expect(element.is_in_viewport).toBe(true);
      expect(element.is_top_element).toBe(true);
    });
  });

  describe('DOMTextNode', () => {
    it('creates text node', () => {
      const textNode = new DOMTextNode(true, null, 'Hello World');

      expect(textNode.text).toBe('Hello World');
      expect(textNode.is_visible).toBe(true);
    });

    it('has parent with highlight index check', () => {
      const parent = new DOMElementNode(true, null, 'div', '/div', {}, []);
      parent.highlight_index = 3;

      const textNode = new DOMTextNode(true, parent, 'Text');
      expect(textNode.has_parent_with_highlight_index()).toBe(true);
    });

    it('checks if parent is in viewport', () => {
      const parent = new DOMElementNode(true, null, 'div', '/div', {}, []);
      parent.is_in_viewport = true;

      const textNode = new DOMTextNode(true, parent, 'Text');
      expect(textNode.is_parent_in_viewport()).toBe(true);
    });

    it('checks if parent is top element', () => {
      const parent = new DOMElementNode(true, null, 'div', '/div', {}, []);
      parent.is_top_element = true;

      const textNode = new DOMTextNode(true, parent, 'Text');
      expect(textNode.is_parent_top_element()).toBe(true);
    });
  });

  describe('DOMState', () => {
    it('creates DOM state with tree and selector map', () => {
      const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
      const selectorMap = { 0: root };

      const state = new DOMState(root, selectorMap);

      expect(state.element_tree).toBe(root);
      expect(state.selector_map).toBe(selectorMap);
    });
  });
});

describe('DomService Pagination Detection', () => {
  it('detects next/prev/page-number buttons from selector map', () => {
    const nextButton = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/nav/button[1]',
      { 'aria-label': 'Next page', role: 'button' },
      [new DOMTextNode(true, null, 'Next')]
    );
    nextButton.highlight_index = 1;

    const prevButton = new DOMElementNode(
      true,
      null,
      'a',
      '/html/body/nav/a[1]',
      { 'aria-label': 'Previous page', role: 'link', 'aria-disabled': 'true' },
      [new DOMTextNode(true, null, 'Previous')]
    );
    prevButton.highlight_index = 2;

    const pageNumber = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/nav/button[2]',
      { role: 'button' },
      [new DOMTextNode(true, null, '2')]
    );
    pageNumber.highlight_index = 3;

    const unrelated = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/main/button[1]',
      { role: 'button' },
      [new DOMTextNode(true, null, 'Submit')]
    );
    unrelated.highlight_index = 4;

    const selectorMap = {
      1: nextButton,
      2: prevButton,
      3: pageNumber,
      4: unrelated,
    };

    const buttons = DomService.detect_pagination_buttons(selectorMap);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.button_type)).toEqual(
      expect.arrayContaining(['next', 'prev', 'page_number'])
    );
    expect(
      buttons.find((button) => button.backend_node_id === 2)?.is_disabled
    ).toBe(true);
  });
});

describe('HashedDomElement', () => {
  it('creates hashed element', () => {
    const hashed = new HashedDomElement(
      'branch_hash',
      'attr_hash',
      'xpath_hash'
    );

    expect(hashed.branch_path_hash).toBe('branch_hash');
    expect(hashed.attributes_hash).toBe('attr_hash');
    expect(hashed.xpath_hash).toBe('xpath_hash');
  });

  it('equals method compares all hash fields', () => {
    const hash1 = new HashedDomElement('a', 'b', 'c');
    const hash2 = new HashedDomElement('a', 'b', 'c');
    const hash3 = new HashedDomElement('x', 'b', 'c');

    expect(hash1.equals(hash2)).toBe(true);
    expect(hash1.equals(hash3)).toBe(false);
  });

  it('equals returns false for different branch_path_hash', () => {
    const hash1 = new HashedDomElement('a', 'b', 'c');
    const hash2 = new HashedDomElement('different', 'b', 'c');

    expect(hash1.equals(hash2)).toBe(false);
  });

  it('equals returns false for different attributes_hash', () => {
    const hash1 = new HashedDomElement('a', 'b', 'c');
    const hash2 = new HashedDomElement('a', 'different', 'c');

    expect(hash1.equals(hash2)).toBe(false);
  });

  it('equals returns false for different xpath_hash', () => {
    const hash1 = new HashedDomElement('a', 'b', 'c');
    const hash2 = new HashedDomElement('a', 'b', 'different');

    expect(hash1.equals(hash2)).toBe(false);
  });
});

describe('DOMHistoryElement', () => {
  it('creates history element from DOM element', () => {
    const domElement = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button',
      {
        id: 'submit-btn',
        class: 'primary focus',
        'aria-label': 'Submit order',
      },
      []
    );
    domElement.highlight_index = 5;

    const historyElement =
      HistoryTreeProcessor.convert_dom_element_to_history_element(domElement);

    expect(historyElement.tag_name).toBe('button');
    expect(historyElement.xpath).toBe('/html/body/button');
    expect(historyElement.highlight_index).toBe(5);
    expect(historyElement.attributes.id).toBe('submit-btn');
    expect(historyElement.element_hash).toBeTypeOf('string');
    expect(historyElement.stable_hash).toBeTypeOf('string');
    expect(historyElement.ax_name).toBe('Submit order');
  });

  it('to_dict returns serializable object', () => {
    // DOMHistoryElement constructor: (tag_name, xpath, highlight_index, entire_parent_branch_path, attributes, shadow_root, css_selector, page_coordinates, viewport_coordinates, viewport_info)
    const historyElement = new DOMHistoryElement(
      'div',
      '/html/body/div',
      3,
      ['body', 'div'], // entire_parent_branch_path
      { class: 'container' },
      false, // shadow_root
      null, // css_selector
      null, // page_coordinates
      null, // viewport_coordinates
      { width: 1920, height: 1080 } // viewport_info
    );

    const dict = historyElement.to_dict();

    expect(dict.tag_name).toBe('div');
    expect(dict.xpath).toBe('/html/body/div');
    expect(dict.highlight_index).toBe(3);
    expect(dict.attributes).toEqual({ class: 'container' });
  });
});

describe('HistoryTreeProcessor', () => {
  describe('Hashing Functions', () => {
    it('generates consistent branch path hash', () => {
      // _parent_branch_path_hash takes a string array of tag names
      const branchPath = ['html', 'body', 'div'];

      const hash1 = HistoryTreeProcessor._parent_branch_path_hash(branchPath);
      const hash2 = HistoryTreeProcessor._parent_branch_path_hash(branchPath);

      expect(hash1).toBe(hash2);
    });

    it('generates consistent attributes hash', () => {
      const attrs = { id: 'test', class: 'container', 'data-value': '123' };

      const hash1 = HistoryTreeProcessor._attributes_hash(attrs);
      const hash2 = HistoryTreeProcessor._attributes_hash(attrs);

      expect(hash1).toBe(hash2);
    });

    it('generates consistent xpath hash', () => {
      const xpath = '/html/body/div[1]/button[2]';

      const hash1 = HistoryTreeProcessor._xpath_hash(xpath);
      const hash2 = HistoryTreeProcessor._xpath_hash(xpath);

      expect(hash1).toBe(hash2);
    });

    it('generates different hashes for different xpaths', () => {
      const hash1 = HistoryTreeProcessor._xpath_hash('/html/body/div[1]');
      const hash2 = HistoryTreeProcessor._xpath_hash('/html/body/div[2]');

      expect(hash1).not.toBe(hash2);
    });

    it('generates different hashes for different attributes', () => {
      const hash1 = HistoryTreeProcessor._attributes_hash({ id: 'a' });
      const hash2 = HistoryTreeProcessor._attributes_hash({ id: 'b' });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Element Comparison', () => {
    it('compares history element with DOM element', () => {
      const domElement = new DOMElementNode(
        true,
        null,
        'button',
        '/html/body/button',
        { id: 'btn' },
        []
      );

      const historyElement =
        HistoryTreeProcessor.convert_dom_element_to_history_element(domElement);

      const matches =
        HistoryTreeProcessor.compare_history_element_and_dom_element(
          historyElement,
          domElement
        );

      expect(matches).toBe(true);
    });

    it('detects different elements', () => {
      const domElement1 = new DOMElementNode(
        true,
        null,
        'button',
        '/html/body/button[1]',
        { id: 'btn1' },
        []
      );

      const domElement2 = new DOMElementNode(
        true,
        null,
        'button',
        '/html/body/button[2]',
        { id: 'btn2' },
        []
      );

      const historyElement =
        HistoryTreeProcessor.convert_dom_element_to_history_element(
          domElement1
        );

      const matches =
        HistoryTreeProcessor.compare_history_element_and_dom_element(
          historyElement,
          domElement2
        );

      expect(matches).toBe(false);
    });
  });

  describe('Tree Search', () => {
    it('finds element in tree by hash', () => {
      // Build a simple tree with proper parent-child relationships
      const root = new DOMElementNode(true, null, 'body', '/html/body', {}, []);

      const parent = new DOMElementNode(
        true,
        root,
        'div',
        '/html/body/div',
        { class: 'container' },
        []
      );
      root.children.push(parent);

      const child1 = new DOMElementNode(
        true,
        parent,
        'button',
        '/html/body/div/button[1]',
        { id: 'btn1' },
        []
      );
      child1.highlight_index = 1;

      const child2 = new DOMElementNode(
        true,
        parent,
        'button',
        '/html/body/div/button[2]',
        { id: 'btn2' },
        []
      );
      child2.highlight_index = 2;

      parent.children.push(child1);
      parent.children.push(child2);

      // Convert child1 to history element
      const historyElement =
        HistoryTreeProcessor.convert_dom_element_to_history_element(child1);

      // Find it in the tree
      const found = HistoryTreeProcessor.find_history_element_in_tree(
        historyElement,
        root
      );

      expect(found).toBeDefined();
      expect(found?.xpath).toBe(child1.xpath);
    });

    it('returns null when element not found', () => {
      const tree = new DOMElementNode(
        true,
        null,
        'div',
        '/html/body/div',
        {},
        []
      );
      tree.highlight_index = 0;

      // Create a history element with different attributes that won't match
      const historyElement = new DOMHistoryElement(
        'button',
        '/html/body/nonexistent',
        99,
        ['body', 'button'], // entire_parent_branch_path
        { id: 'nonexistent' },
        false, // shadow_root
        null, // css_selector
        null, // page_coordinates
        null, // viewport_coordinates
        null // viewport_info
      );

      const found = HistoryTreeProcessor.find_history_element_in_tree(
        historyElement,
        tree
      );

      expect(found).toBeNull();
    });

    it('falls back to stable hash when dynamic classes differ', () => {
      const root = new DOMElementNode(true, null, 'body', '/html/body', {}, []);
      const current = new DOMElementNode(
        true,
        root,
        'button',
        '/html/body/button[1]',
        { class: 'btn active', id: 'settings' },
        []
      );
      current.highlight_index = 7;
      root.children.push(current);

      const historical = new DOMElementNode(
        true,
        root,
        'button',
        '/html/body/button[1]',
        { class: 'btn focus', id: 'settings' },
        []
      );
      const historyElement =
        HistoryTreeProcessor.convert_dom_element_to_history_element(historical);

      expect(historyElement.element_hash).toBeTruthy();
      expect(historyElement.stable_hash).toBeTruthy();

      const found = HistoryTreeProcessor.find_history_element_in_tree(
        historyElement,
        root
      );

      expect(found).toBeDefined();
      expect(found?.highlight_index).toBe(7);
    });
  });
});

describe('DomService', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  describe('Clickable Elements Extraction', () => {
    it('extracts clickable elements from page', async () => {
      await page.setContent(`
        <html>
          <body>
            <button id="btn1">Button 1</button>
            <a href="#" id="link1">Link 1</a>
            <input type="text" id="input1" />
            <div>Non-interactive div</div>
          </body>
        </html>
      `);

      const domService = new DomService(page);
      const state = await domService.get_clickable_elements();

      expect(state).toBeDefined();
      expect(state.element_tree).toBeDefined();
      expect(state.selector_map).toBeDefined();
    });

    it('excludes password values from DOM snapshots and LLM output', async () => {
      const secret = 'hunter2_super_secret';
      const html = `
        <style>input { display: block; width: 200px; height: 40px; }</style>
        <input
          id="password"
          name="password"
          type="password"
          value="${secret}"
          aria-valuetext="${secret}"
        />
        <input id="username" type="text" value="alice@example.com" />
      `;
      await page.goto(`data:text/html,${encodeURIComponent(html)}`);

      const state = await new DomService(page).get_clickable_elements();
      const password = Object.values(state.selector_map).find(
        (node) => node.attributes.id === 'password'
      );
      const username = Object.values(state.selector_map).find(
        (node) => node.attributes.id === 'username'
      );
      const serializedTree = JSON.stringify(state.element_tree.toJSON());
      const llmRepresentation = state.llm_representation();

      expect(password?.attributes).toMatchObject({
        id: 'password',
        name: 'password',
        type: 'password',
      });
      expect(password?.attributes).not.toHaveProperty('value');
      expect(password?.attributes).not.toHaveProperty('aria-valuetext');
      expect(serializedTree).not.toContain(secret);
      expect(llmRepresentation).not.toContain(secret);
      expect(username?.attributes.value).toBe('alice@example.com');
    });

    it('handles empty page', async () => {
      await page.setContent('<html><body></body></html>');

      const domService = new DomService(page);
      const state = await domService.get_clickable_elements();

      expect(state).toBeDefined();
      expect(state.element_tree).toBeDefined();
    });

    it('handles complex nested structure', async () => {
      await page.setContent(`
        <html>
          <body>
            <nav>
              <ul>
                <li><a href="#1">Item 1</a></li>
                <li><a href="#2">Item 2</a></li>
                <li>
                  <button>Dropdown</button>
                  <ul>
                    <li><a href="#sub1">Sub 1</a></li>
                    <li><a href="#sub2">Sub 2</a></li>
                  </ul>
                </li>
              </ul>
            </nav>
            <main>
              <form>
                <input type="text" name="name" />
                <input type="email" name="email" />
                <textarea name="message"></textarea>
                <button type="submit">Submit</button>
              </form>
            </main>
          </body>
        </html>
      `);

      const domService = new DomService(page);
      const state = await domService.get_clickable_elements();

      expect(state).toBeDefined();
      expect(state.element_tree).toBeDefined();
      expect(state.selector_map).toBeDefined();
    });
  });

  describe('Special URL Handling', () => {
    it('handles about:blank page', async () => {
      await page.goto('about:blank');

      const domService = new DomService(page);
      const state = await domService.get_clickable_elements();

      expect(state).toBeDefined();
      expect(state.element_tree).toBeDefined();
    });
  });

  describe('Cross-Origin Iframes', () => {
    it('detects cross-origin iframes', async () => {
      await page.setContent(`
        <html>
          <body>
            <h1>Main Page</h1>
            <iframe src="about:blank" id="same-origin"></iframe>
          </body>
        </html>
      `);

      const domService = new DomService(page);
      const crossOriginIframes = await domService.get_cross_origin_iframes();

      expect(Array.isArray(crossOriginIframes)).toBe(true);
    });
  });
});

describe('Clickable Elements to String', () => {
  it('converts element tree to string representation', () => {
    const child1 = new DOMElementNode(
      true,
      null,
      'button',
      '/button[1]',
      { id: 'btn1' },
      []
    );
    child1.highlight_index = 0;
    child1.is_interactive = true;

    const textNode = new DOMTextNode(true, child1, 'Click me');
    child1.children = [textNode];

    const root = new DOMElementNode(true, null, 'div', '/div', {}, [child1]);
    child1.parent = root;

    const str = root.clickable_elements_to_string();

    expect(typeof str).toBe('string');
  });

  it('handles empty tree', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);

    const str = root.clickable_elements_to_string();

    expect(typeof str).toBe('string');
  });
});
