import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  chromium,
  type Browser,
  type Page as PlaywrightPage,
} from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Element,
  Mouse,
  Page,
  resolveScrollAnchor,
} from '../src/actor/index.js';
import { BrowserSession } from '../src/browser/session.js';
import type { DOMElementNode } from '../src/dom/views.js';

const FIXTURE = `<!doctype html>
<html><body style="margin:0">
  <div id="pad" style="position:absolute;left:0;top:0;width:400px;height:300px;background:#eee"></div>
  <div style="position:absolute;left:420px;top:0">
    <input id="agree" type="checkbox" aria-label="Agree">
    <input id="name" aria-label="Name">
    <select id="fruit" aria-label="Fruit">
      <option value="">Pick</option>
      <optgroup label="Sweet"><option value="b">Banana</option><option value="c">Cherry</option></optgroup>
      <optgroup label="Sold out" disabled><option value="d">Durian</option></optgroup>
    </select>
    <select id="colors" multiple aria-label="Colors">
      <option value="red">Red</option><option value="blue">Blue</option><option value="green">Green</option>
    </select>
    <input id="file" type="file" multiple aria-label="Files">
    <button id="source" style="width:80px;height:40px">Source</button>
    <button id="target" style="width:80px;height:40px;margin-left:100px">Target</button>
  </div>
  <div style="height:3000px"></div>
  <button id="bottom">Bottom</button>
  <script>
    window.events = [];
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      document.addEventListener(type, (event) => {
        window.events.push({ type, detail: event.detail, shift: event.shiftKey, alt: event.altKey, x: Math.round(event.clientX), y: Math.round(event.clientY) });
      });
    }
    document.addEventListener('mousemove', (event) => {
      if (event.buttons) window.events.push({ type: 'drag', x: Math.round(event.clientX), y: Math.round(event.clientY) });
    });
    window.keys = [];
    document.addEventListener('keydown', (event) => window.keys.push('down:' + event.key));
    document.addEventListener('keyup', (event) => window.keys.push('up:' + event.key));
  </script>
</body></html>`;

describe('actor input parity', () => {
  let browser: Browser;
  let page: PlaywrightPage;
  let session: BrowserSession;
  let actorPage: Page;
  let workDir: string;
  let server: http.Server;
  let fixtureUrl: string;

  const events = () => page.evaluate(() => (window as any).events.splice(0));

  const elementById = async (id: string) => {
    const state = await session.get_browser_state_with_recovery({
      include_screenshot: false,
    });
    const node = Object.values(state.selector_map).find(
      (candidate: DOMElementNode) => candidate.attributes.id === id
    );
    if (!node) throw new Error(`No interactive element #${id}`);
    return new Element(session, node);
  };

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-actor-'));
    fs.writeFileSync(path.join(workDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(workDir, 'b.txt'), 'b');
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(FIXTURE);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 900, height: 600 },
    });
    page = await context.newPage();
    session = new BrowserSession({
      browser,
      browser_context: context,
      page,
      // Include off-screen elements so scroll_into_view has a target.
      profile: { highlight_elements: false, viewport_expansion: -1 },
    });
    await session.start();
    actorPage = new Page(session);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await page.goto(fixtureUrl);
    session.update_current_page(page as any, 'Fixture', fixtureUrl);
  });

  it('emits complete click sequences with click_count and modifiers', async () => {
    const mouse = new Mouse(session);
    await mouse.click(100, 100, { click_count: 2 });
    const double = await events();
    expect(
      double
        .filter((event: any) => event.type === 'mousedown')
        .map((event: any) => event.detail)
    ).toEqual([1, 2]);
    expect(double.some((event: any) => event.type === 'dblclick')).toBe(true);

    await mouse.click(50, 60, { modifiers: ['Shift', 'Alt'] });
    expect(
      (await events()).find((event: any) => event.type === 'click')
    ).toMatchObject({ shift: true, alt: true, x: 50, y: 60 });
    // Modifiers are released after the click.
    await mouse.click(50, 60);
    expect(
      (await events()).find((event: any) => event.type === 'click')
    ).toMatchObject({ shift: false, alt: false });

    await expect(mouse.click(1, 1, { click_count: 0 })).rejects.toThrow(
      'click_count must be a positive integer'
    );
    await expect(
      mouse.click(1, 1, { modifiers: ['Hyper' as any] })
    ).rejects.toThrow('Unsupported modifier: Hyper');
  });

  it('drags with held buttons and moves in steps', async () => {
    const mouse = new Mouse(session);
    await mouse.move(20, 20);
    await mouse.down();
    await mouse.move(220, 120, { steps: 5 });
    await mouse.up();
    const drag = await events();
    expect(drag[0]).toMatchObject({ type: 'mousedown', x: 20, y: 20 });
    expect(drag.filter((event: any) => event.type === 'drag')).toHaveLength(5);
    expect(drag.find((event: any) => event.type === 'mouseup')).toMatchObject({
      x: 220,
      y: 120,
    });
    await expect(mouse.move(1, 1, { steps: 0 })).rejects.toThrow(
      'steps must be a positive integer'
    );
  });

  it('scrolls with the wheel and resolves explicit zero anchors', async () => {
    expect(resolveScrollAnchor(0, 0, 800, 600)).toEqual([0, 0]);
    expect(resolveScrollAnchor(null, undefined, 800, 600)).toEqual([400, 300]);

    await actorPage.mouse.scroll(null, null, 0, 400);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
  });

  it('holds keys and chords and validates them', async () => {
    await actorPage.hold_key('shift', 0.05);
    expect(await page.evaluate(() => (window as any).keys.splice(0))).toEqual([
      'down:Shift',
      'up:Shift',
    ]);
    await actorPage.hold_key('Control+a', 0);
    expect(await page.evaluate(() => (window as any).keys.splice(0))).toEqual([
      'down:Control',
      'down:a',
      'up:a',
      'up:Control',
    ]);
    await expect(actorPage.hold_key('a+b', 0)).rejects.toThrow(
      'Use one key or a modifier chord'
    );
    await expect(actorPage.hold_key('Shift', -1)).rejects.toThrow(
      'duration must be finite and non-negative'
    );
  });

  it('captures clipped, scaled, and JPEG screenshots', async () => {
    const clipped = Buffer.from(
      (await actorPage.screenshot({
        clip: { x: 0, y: 0, width: 100, height: 50, scale: 2 },
      }))!,
      'base64'
    );
    expect([clipped.readUInt32BE(16), clipped.readUInt32BE(20)]).toEqual([
      200, 100,
    ]);
    const jpeg = Buffer.from(
      (await actorPage.screenshot({ format: 'jpeg', quality: 50 }))!,
      'base64'
    );
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await expect(
      actorPage.screenshot({ clip: { x: 0, y: 0, width: 0, height: 10 } })
    ).rejects.toThrow(
      'Screenshot clip width, height and scale must be positive'
    );
  });

  it('selects options by label or value, including optgroups and multi-selects', async () => {
    const fruit = await elementById('fruit');
    await fruit.select_option('banana');
    expect(await page.inputValue('#fruit')).toBe('b');
    await fruit.select_option('C');
    expect(await page.inputValue('#fruit')).toBe('c');
    await expect(fruit.select_option('Durian')).rejects.toThrow(
      'Option is disabled: Durian'
    );
    await expect(fruit.select_option('Mango')).rejects.toThrow(
      'Option not found: Mango'
    );
    await expect(fruit.select_option(['b', 'c'])).rejects.toThrow(
      'This dropdown requires exactly one option'
    );

    const colors = await elementById('colors');
    await colors.select_option(['Red', 'blue']);
    expect(
      await page.$eval('#colors', (select) =>
        Array.from((select as HTMLSelectElement).selectedOptions).map(
          (option) => option.value
        )
      )
    ).toEqual(['red', 'blue']);
    await colors.select_option([]);
    expect(
      await page.$eval(
        '#colors',
        (select) => (select as HTMLSelectElement).selectedOptions.length
      )
    ).toBe(0);
  });

  it('sets files, focuses, scrolls into view, and drags elements', async () => {
    const files = await elementById('file');
    await files.set_input_files([
      path.join(workDir, 'a.txt'),
      path.join(workDir, 'b.txt'),
    ]);
    expect(
      await page.$eval(
        '#file',
        (input) => (input as HTMLInputElement).files!.length
      )
    ).toBe(2);
    await files.set_input_files([]);
    expect(
      await page.$eval(
        '#file',
        (input) => (input as HTMLInputElement).files!.length
      )
    ).toBe(0);

    const name = await elementById('name');
    await name.focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('name');

    const bottom = await elementById('bottom');
    await bottom.scroll_into_view();
    expect(
      await page.$eval('#bottom', (button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      })
    ).toBe(true);

    await page.evaluate(() => window.scrollTo(0, 0));
    await events();
    const source = await elementById('source');
    const target = await elementById('target');
    const sourceBox = (await source.get_bounding_box())!;
    const targetBox = (await target.get_bounding_box())!;
    await source.drag_to(target);
    const drag = await events();
    expect(drag[0]).toMatchObject({
      type: 'mousedown',
      x: Math.round(sourceBox.x + sourceBox.width / 2),
      y: Math.round(sourceBox.y + sourceBox.height / 2),
    });
    expect(drag.find((event: any) => event.type === 'mouseup')).toMatchObject({
      x: Math.round(targetBox.x + targetBox.width / 2),
      y: Math.round(targetBox.y + targetBox.height / 2),
    });

    await source.drag_to({ x: 10, y: 15 });
    expect(
      (await events()).find((event: any) => event.type === 'mouseup')
    ).toMatchObject({ x: 10, y: 15 });

    await source.drag_to(target, { target_position: { x: 5, y: 6 } });
    expect(
      (await events()).find((event: any) => event.type === 'mouseup')
    ).toMatchObject({
      x: Math.round(targetBox.x + 5),
      y: Math.round(targetBox.y + 6),
    });
  });

  it('checks checkboxes without toggling them off', async () => {
    const agree = await elementById('agree');
    await agree.check();
    expect(await page.isChecked('#agree')).toBe(true);
    // Already checked: no click, so it stays checked.
    await agree.check();
    expect(await page.isChecked('#agree')).toBe(true);

    const name = await elementById('name');
    await expect(name.check()).rejects.toThrow(
      'Element is not a checkbox or radio button'
    );
  }, 30_000);
});
