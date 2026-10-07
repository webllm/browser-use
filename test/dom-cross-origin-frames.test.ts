import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserProfile } from '../src/browser/profile.js';
import { BrowserSession } from '../src/browser/session.js';
import { DomService } from '../src/dom/service.js';
import type { DOMElementNode } from '../src/dom/views.js';

const FRAME_STYLE = 'style="display:block;width:320px;height:140px;border:0"';

describe('cross-origin iframe extraction', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let mainUrl: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const { port } = server.address() as AddressInfo;
      const crossOrigin = `http://localhost:${port}`;
      const pages: Record<string, string> = {
        '/main': `
          <button id="main-btn">Main</button>
          <iframe id="same" src="/same" ${FRAME_STYLE}></iframe>
          <iframe id="cross" src="${crossOrigin}/frame" ${FRAME_STYLE}></iframe>
          <iframe id="tiny" src="${crossOrigin}/tiny" style="display:block;width:4px;height:4px;border:0"></iframe>
        `,
        '/same': `<button id="same-btn" onclick="this.textContent='same clicked'">Same</button>`,
        '/frame': `
          <button id="cross-btn" onclick="this.textContent='paid'">Pay</button>
          <input id="cross-input" style="display:block;width:200px;height:30px" />
        `,
        '/tiny': `<button id="tiny-btn">Tracking</button>`,
      };
      const body = pages[request.url ?? ''];
      response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
      response.end(body ? `<!doctype html><body>${body}</body>` : '');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    const { port } = server.address() as AddressInfo;
    mainUrl = `http://127.0.0.1:${port}/main`;

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const findById = (
    selectorMap: Record<number, DOMElementNode>,
    id: string
  ): [number, DOMElementNode] | undefined => {
    const entry = Object.entries(selectorMap).find(
      ([, node]) => node.attributes.id === id
    );
    return entry ? [Number(entry[0]), entry[1]] : undefined;
  };

  it('extracts interactive elements from cross-origin frames with unique indices', async () => {
    await page.goto(mainUrl, { waitUntil: 'load' });

    const state = await new DomService(page).get_clickable_elements(
      false,
      -1,
      -1
    );

    const main = findById(state.selector_map, 'main-btn');
    const same = findById(state.selector_map, 'same-btn');
    const cross = findById(state.selector_map, 'cross-btn');
    const crossInput = findById(state.selector_map, 'cross-input');

    expect(main).toBeDefined();
    expect(same).toBeDefined();
    expect(cross).toBeDefined();
    expect(crossInput).toBeDefined();
    // Frames smaller than 10px in either dimension are skipped.
    expect(findById(state.selector_map, 'tiny-btn')).toBeUndefined();

    const indices = Object.keys(state.selector_map).map(Number);
    expect(new Set(indices).size).toBe(indices.length);
    expect(cross![0]).toBeGreaterThan(main![0]);
    expect(state.llm_representation()).toContain('Pay');
  });

  it('respects the frame URL policy', async () => {
    await page.goto(mainUrl, { waitUntil: 'load' });

    const state = await new DomService(page, undefined, {
      is_frame_url_allowed: (url) => !url.includes('localhost'),
    }).get_clickable_elements(false, -1, -1);

    expect(findById(state.selector_map, 'same-btn')).toBeDefined();
    expect(findById(state.selector_map, 'cross-btn')).toBeUndefined();
  });

  it('clicks and types into elements inside same-origin and cross-origin frames', async () => {
    await page.goto(mainUrl, { waitUntil: 'load' });
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({ highlight_elements: false }),
    });
    session.update_current_page(page as any, 'Main', mainUrl);
    (session as any).initialized = true;

    const state = await session.get_browser_state_with_recovery({
      include_screenshot: false,
    });
    const same = findById(state.selector_map, 'same-btn')![1];
    const cross = findById(state.selector_map, 'cross-btn')![1];
    const crossInput = findById(state.selector_map, 'cross-input')![1];

    await session._click_element_node(same);
    await session._click_element_node(cross);
    await session._input_text_element_node(crossInput, 'hello frame');

    const sameFrame = page
      .frames()
      .find((frame) => frame.url().endsWith('/same'))!;
    const crossFrame = page
      .frames()
      .find((frame) => frame.url().endsWith('/frame'))!;
    await expect(
      sameFrame.evaluate(() => document.getElementById('same-btn')!.textContent)
    ).resolves.toBe('same clicked');
    await expect(
      crossFrame.evaluate(
        () => document.getElementById('cross-btn')!.textContent
      )
    ).resolves.toBe('paid');
    await expect(
      crossFrame.evaluate(
        () => (document.getElementById('cross-input') as HTMLInputElement).value
      )
    ).resolves.toBe('hello frame');
    // Each click waits briefly for a possible download before returning.
  }, 30_000);
});
