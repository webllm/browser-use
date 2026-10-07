import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomService } from '../src/dom/service.js';

describe('occluded and off-screen DOM text', () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  let html = '';
  let url = '';

  // DOM extraction skips about:blank, so fixtures are served over HTTP.
  const show = async (body: string) => {
    html = `<!doctype html><html><body style="margin:0">${body}</body></html>`;
    await page.goto(url);
  };

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const domText = async (viewportExpansion = 0) => {
    const state = await new DomService(page).get_clickable_elements(
      false,
      -1,
      viewportExpansion
    );
    return state.element_tree.clickable_elements_to_string();
  };

  it('omits text painted underneath other elements', async () => {
    await show(`
      <div style="position:absolute;left:10px;top:10px;width:300px;height:40px;background:#fff">covered text below</div>
      <div style="position:absolute;left:10px;top:10px;width:300px;height:40px;background:#fff;z-index:2">covering text on top</div>
      <p style="margin-top:120px">article paragraph under the modal</p>
      <div style="position:fixed;inset:0;top:100px;background:rgba(0,0,0,.9);z-index:10">
        <div style="background:#fff;margin:40px">modal dialog text</div>
      </div>
    `);

    const text = await domText();
    expect(text).toContain('covering text on top');
    expect(text).toContain('modal dialog text');
    expect(text).not.toContain('covered text below');
    expect(text).not.toContain('article paragraph under the modal');
  });

  it('omits text of a visible container that lies outside the viewport', async () => {
    await show(`
      <div id="article">
        visible intro text
        <div style="height:3000px"></div>
        far away footer text
      </div>
    `);

    const text = await domText(0);
    expect(text).toContain('visible intro text');
    expect(text).not.toContain('far away footer text');
    // With the whole page requested, off-screen text is included.
    expect(await domText(-1)).toContain('far away footer text');
  });
});
