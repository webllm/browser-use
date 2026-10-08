import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClickElementActionSchema,
  SelectDropdownActionSchema,
} from '../src/controller/views.js';
import { DomService } from '../src/dom/service.js';

describe('interactive element numbering', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let url: string;

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><a href="/next">Only link</a><select><option>One</option></select>'
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('numbers from 1 so every element is reachable by index actions', async () => {
    await page.goto(url);
    const state = await new DomService(page).get_clickable_elements(
      false,
      -1,
      0
    );
    const indices = Object.keys(state.selector_map)
      .map(Number)
      .sort((a, b) => a - b);

    expect(indices).toEqual([1, 2]);
    expect(state.selector_map[1]!.tag_name).toBe('a');
    for (const index of indices) {
      expect(ClickElementActionSchema.safeParse({ index }).success).toBe(true);
      expect(
        SelectDropdownActionSchema.safeParse({ index, text: 'One' }).success
      ).toBe(true);
    }
    expect(state.element_tree.clickable_elements_to_string()).toContain(
      '[1]<a'
    );
  });
});
