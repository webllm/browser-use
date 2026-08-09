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

  it('ships hard limits for page-controlled DOM extraction', () => {
    const domService = new DomService({} as any);
    const script = (domService as any).jsCode as string;

    expect(script).toContain('MAX_VISITED_NODES');
    expect(script).toContain('MAX_SERIALIZED_NODES');
    expect(script).toContain('MAX_DOM_DEPTH');
    expect(script).toContain('MAX_SERIALIZED_STRING_LENGTH');
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
    it('bounds nodes and strings returned by the page DOM script', async () => {
      await page.setContent(
        `<body>${Array.from(
          { length: 40 },
          (_, index) =>
            `<button aria-label="${'a'.repeat(100)}-${index}">${'b'.repeat(100)}</button>`
        ).join('')}</body>`
      );

      const script = (new DomService(page) as any).jsCode as string;
      const serialized = await page.evaluate(
        ({ domScript }) => {
          const buildTree = eval(domScript);
          return buildTree({
            doHighlightElements: false,
            focusHighlightIndex: -1,
            viewportExpansion: -1,
            debugMode: false,
            domLimits: {
              maxVisitedNodes: 100,
              maxSerializedNodes: 12,
              maxDepth: 20,
              maxTextLength: 32,
              maxAttributeNameLength: 20,
              maxAttributeValueLength: 24,
              maxAttributesPerNode: 4,
              maxSerializedStringLength: 1_000,
            },
          });
        },
        { domScript: script }
      );

      expect(Object.keys(serialized.map)).toHaveLength(12);
      expect(serialized.map[String(serialized.rootId)]?.tagName).toBe('body');
      expect(serialized.metadata.truncated).toBe(true);

      const nodes = Object.values(serialized.map) as Array<{
        type?: string;
        text?: string;
        attributes?: Record<string, string>;
      }>;
      const textNodes = nodes.filter((node) => node.type === 'TEXT_NODE');
      const ariaLabels = nodes
        .map((node) => node.attributes?.['aria-label'])
        .filter((value): value is string => value !== undefined);

      expect(textNodes.length).toBeGreaterThan(0);
      expect(textNodes.every((node) => (node.text?.length ?? 0) <= 32)).toBe(
        true
      );
      expect(ariaLabels.length).toBeGreaterThan(0);
      expect(ariaLabels.every((value) => value.length <= 24)).toBe(true);
    });

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

  describe('Shadow DOM Form Elements (offsetWidth/Height = 0)', () => {
    // Regression test for fix(dom): include shadow-DOM form elements when
    // offsetWidth/Height === 0. Auth0-style login widgets render <input>s
    // inside a shadow root that frequently report offsetWidth/Height = 0
    // even though they're visually interactable. Before the fix,
    // isElementVisible short-circuited to false and the inputs never made
    // it into selector_map.
    //
    // Note: we navigate via data: URL rather than setContent() because
    // DomService short-circuits to an empty selector_map for about:blank
    // (which is what setContent leaves the URL as).
    // Build the shadow tree imperatively (rather than via innerHTML with a
    // backtick-template) so the data: URL stays simple and we don't have to
    // escape nested template literals.
    const SHADOW_FORM_HTML = `<!doctype html>
<html>
  <body>
    <button id="light-btn">Visible Light DOM Button</button>
    <div id="shadow-host"></div>
    <script>
      const host = document.getElementById('shadow-host');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      // Force offsetWidth/offsetHeight to 0 while keeping the element rendered
      // (display !== none, visibility !== hidden). This reproduces the
      // shadow-DOM layout-reporting quirk where form elements inside a shadow
      // root can show 0/0 offset dimensions despite being functional.
      style.textContent =
        'input, button, select, textarea {' +
        '  width: 0;' +
        '  height: 0;' +
        '  padding: 0;' +
        '  border: 0;' +
        '  margin: 0;' +
        '  display: block;' +
        '}';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'shadow-input';
      input.name = 'username';
      input.placeholder = 'username';
      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.id = 'shadow-button';
      btn.textContent = 'Submit';
      shadow.appendChild(style);
      shadow.appendChild(input);
      shadow.appendChild(btn);
    </script>
  </body>
</html>`;

    it('discovers shadow-DOM input with offsetWidth/Height = 0', async () => {
      await page.goto(
        'data:text/html;charset=utf-8,' + encodeURIComponent(SHADOW_FORM_HTML)
      );

      // Sanity check: confirm the shadow input really does report
      // offsetWidth/Height = 0 under the chosen CSS. If this ever stops
      // being true the test no longer exercises the bug.
      const shadowInputDims = await page.evaluate(() => {
        const host = document.getElementById('shadow-host');
        const input = host?.shadowRoot?.getElementById('shadow-input') as
          | HTMLInputElement
          | null;
        if (!input) return null;
        return {
          offsetWidth: input.offsetWidth,
          offsetHeight: input.offsetHeight,
          display: getComputedStyle(input).display,
          visibility: getComputedStyle(input).visibility,
        };
      });
      expect(shadowInputDims).not.toBeNull();
      expect(shadowInputDims!.offsetWidth).toBe(0);
      expect(shadowInputDims!.offsetHeight).toBe(0);
      // The element is still rendered (not display:none / visibility:hidden);
      // it's the offsetWidth/Height = 0 short-circuit that loses it
      // without the fix.
      expect(shadowInputDims!.display).not.toBe('none');
      expect(shadowInputDims!.visibility).not.toBe('hidden');

      const domService = new DomService(page);
      // viewport_expansion=-1 ensures elements are picked regardless of
      // viewport intersection — the bug under test is about visibility
      // detection inside the shadow root, not viewport intersection.
      const state = await domService.get_clickable_elements(true, -1, -1);

      const selectorEntries = Object.values(state.selector_map);

      // The actual regression assertion: the shadow-DOM input must reach
      // selector_map. Without the SHADOW_DOM_FORM_TAGS exception this is
      // dropped because isElementVisible returns false (offsetWidth/Height = 0).
      const shadowInputEntries = selectorEntries.filter(
        (node) =>
          node.tag_name === 'input' &&
          (node.attributes?.id === 'shadow-input' ||
            node.attributes?.name === 'username')
      );
      expect(shadowInputEntries.length).toBeGreaterThan(0);

      // The submit button inside the shadow root should also be discovered.
      const shadowSubmitEntries = selectorEntries.filter(
        (node) =>
          node.tag_name === 'button' && node.attributes?.id === 'shadow-button'
      );
      expect(shadowSubmitEntries.length).toBeGreaterThan(0);
    });

    it('still skips non-form shadow-DOM elements with offsetWidth/Height = 0', async () => {
      // Guard: the SHADOW_DOM_FORM_TAGS whitelist must remain a *whitelist*.
      // A <div> inside a shadow root with width=0/height=0 should not be
      // promoted to selector_map by this code path. (It can still appear
      // via other interactivity heuristics, so we assert via highlight_index
      // not being assigned through the shadow-DOM exception.)
      const DIV_HTML = `<!doctype html>
<html>
  <body>
    <div id="shadow-host"></div>
    <script>
      const host = document.getElementById('shadow-host');
      const shadow = host.attachShadow({ mode: 'open' });
      const inner = document.createElement('div');
      inner.id = 'plain-div';
      inner.style.width = '0';
      inner.style.height = '0';
      inner.style.display = 'block';
      inner.textContent = 'plain non-form div';
      shadow.appendChild(inner);
    </script>
  </body>
</html>`;
      await page.goto(
        'data:text/html;charset=utf-8,' + encodeURIComponent(DIV_HTML)
      );

      const domService = new DomService(page);
      const state = await domService.get_clickable_elements(true, -1, -1);

      // A plain <div> inside the shadow root with no interactive cursor /
      // event handlers must not land in selector_map via the form-tag
      // exception. This guards against widening the whitelist accidentally.
      const plainDiv = Object.values(state.selector_map).filter(
        (node) =>
          node.tag_name === 'div' && node.attributes?.id === 'plain-div'
      );
      expect(plainDiv.length).toBe(0);
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
