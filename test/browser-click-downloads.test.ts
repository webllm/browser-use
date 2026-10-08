import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserProfile } from '../src/browser/profile.js';
import {
  BrowserSession,
  type BrowserDownload,
} from '../src/browser/session.js';
import { URLNotAllowedError } from '../src/browser/views.js';
import type { DOMElementNode } from '../src/dom/views.js';

const PAGE = `<!doctype html><html><body>
  <button id="plain" onclick="document.title='clicked'">Plain button</button>
  <a id="file" href="/file">Download report</a>
  <a id="slow" href="/slow">Download slow report</a>
  <a id="popup" href="/file" target="_blank">Download in new tab</a>
  <a id="blocked" href="http://localhost:PORT/file">Download from another host</a>
  <button id="later" onclick="setTimeout(() => {
    const link = document.createElement('a');
    link.href = '/later';
    document.body.append(link);
    link.click();
  }, 1200)">Export later</button>
</body></html>`;

describe('click downloads', () => {
  let server: http.Server;
  let baseUrl: string;
  let browser: Browser;
  let context: BrowserContext;
  let downloadsDir: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const { port } = server.address() as AddressInfo;
      const sendFile = (name: string) => {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': `attachment; filename="${name}"`,
        });
        response.end(`contents of ${name}`);
      };
      if (request.url === '/file') return sendFile('report.txt');
      if (request.url === '/slow') {
        setTimeout(() => sendFile('slow-report.txt'), 1500);
        return;
      }
      if (request.url === '/later') return sendFile('later-report.txt');
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE.replace('PORT', String(port)));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let session: BrowserSession;

  beforeEach(async () => {
    await context?.close();
    downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-click-dl-'));
    context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    session = new BrowserSession({
      browser,
      browser_context: context,
      page,
      browser_profile: new BrowserProfile({
        downloads_path: downloadsDir,
        allowed_domains: ['http://127.0.0.1'],
        highlight_elements: false,
      }),
    });
    session.update_current_page(page as any, 'Downloads', `${baseUrl}/`);
  });

  const nodeFor = (id: string) =>
    ({
      tag_name: id === 'plain' || id === 'later' ? 'button' : 'a',
      xpath: `//*[@id="${id}"]`,
      attributes: { id },
      parent: null,
    }) as unknown as DOMElementNode;

  it('returns from a click that starts no download within the grace period', async () => {
    const started = Date.now();
    const result = await session._click_element_node(nodeFor('plain'));
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    // Previously every click waited 5 seconds for a possible download.
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns the saved file for a click that downloads', async () => {
    const started = Date.now();
    const result = await session._click_element_node(nodeFor('file'));

    expect(result).toBe(path.join(downloadsDir, 'report.txt'));
    expect(fs.readFileSync(result!, 'utf8')).toBe('contents of report.txt');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(session.get_downloaded_files()).toContain(result);
  });

  it('returns slow link downloads once the navigation becomes a download', async () => {
    // Playwright's click waits for the navigation it starts, so a slow
    // response is still reported by the click itself.
    const result = await session._click_element_node(nodeFor('slow'));

    expect(result).toBe(path.join(downloadsDir, 'slow-report.txt'));
    expect(fs.readFileSync(result!, 'utf8')).toBe(
      'contents of slow-report.txt'
    );
  }, 20_000);

  it('still saves downloads that start after the grace period', async () => {
    const seen: BrowserDownload[] = [];
    const stop = session.add_download_listener((download) => {
      seen.push(download);
    });
    try {
      const started = Date.now();
      const result = await session._click_element_node(nodeFor('later'));
      expect(result).toBeNull();
      expect(Date.now() - started).toBeLessThan(1200);

      const expected = path.join(downloadsDir, 'later-report.txt');
      await expect
        .poll(() => session.get_downloaded_files(), { timeout: 10_000 })
        .toContain(expected);
      expect(seen).toHaveLength(1);
      await expect(seen[0]!.completion).resolves.toEqual({
        path: expected,
        error: null,
      });
    } finally {
      stop();
    }
  }, 20_000);

  it('saves downloads started from a newly opened tab', async () => {
    await session._click_element_node(nodeFor('popup'));

    await expect
      .poll(() => session.get_downloaded_files(), { timeout: 10_000 })
      .toContain(path.join(downloadsDir, 'report.txt'));
  });

  it('refuses downloads from disallowed hosts without saving them', async () => {
    await expect(
      session._click_element_node(nodeFor('blocked'))
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(fs.readdirSync(downloadsDir)).toEqual([]);
  });
});
