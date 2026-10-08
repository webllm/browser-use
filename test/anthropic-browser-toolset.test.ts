import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BATCH_HALT_TEXT,
  BrowserUseToolset,
  type BrowserStateBlock,
  type BrowserToolUse,
  type ToolResultBlock,
} from '../src/integrations/anthropic/index.js';

const fixturePages = (port: number): Record<string, string> => ({
  '/': `
    <title>Toolset Fixture</title>
    <h1>Fixture Heading</h1>
    <a id="other-link" href="/other">Other page</a>
    <button id="btn" onclick="this.textContent='Clicked!'">Press me</button>
    <label for="name">Your name</label><input id="name" type="text">
    <label for="pw">Password</label><input id="pw" type="password" value="secret">
    <select id="fruit" aria-label="Fruit">
      <optgroup label="Sweet"><option value="a">Apple</option><option value="b">Banana</option></optgroup>
    </select>
    <label><input id="agree" type="checkbox"> I agree</label>
    <label><input id="r1" type="radio" name="size" value="s"> Small</label>
    <label><input id="r2" type="radio" name="size" value="l"> Large</label>
    <input id="volume" type="range" min="0" max="10" value="2" aria-label="Volume">
    <div id="editor" contenteditable="true" aria-label="Editor">draft</div>
    <input id="file" type="file" aria-label="Attachment">
    <input id="locked" type="text" disabled aria-label="Locked">
    <a id="dl" href="/download">Download report</a>
    <a id="popup" href="/other" target="_blank">Open popup</a>
    <div>
      <iframe id="same" src="/frame" title="Same frame" style="width:300px;height:60px;border:0"></iframe>
      <iframe id="cross" src="http://localhost:${port}/xframe" title="Cross frame" style="width:300px;height:60px;border:2px solid #000;padding:4px"></iframe>
    </div>
    <div style="height:3000px"></div>
    <button id="far">Far button</button>
    <script>console.log('fixture ready'); fetch('/api').then((r) => r.json());</script>
  `,
  '/other': `<title>Other</title><h1>Other heading</h1>`,
  '/frame': `<button id="inner" onclick="this.textContent='Inner clicked'">Inner</button>`,
  '/xframe': `
    <button id="cross-btn" onclick="this.textContent='Cross clicked'">Cross</button>
    <input id="cross-input" aria-label="Cross input">
  `,
  '/mouse': `
    <title>Mouse</title>
    <div id="pad" style="position:absolute;left:0;top:0;width:600px;height:400px;background:#eee"></div>
    <script>
      window.events = [];
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick']) {
        document.addEventListener(type, (event) => {
          window.events.push({ type, button: event.button, detail: event.detail, shift: event.shiftKey, x: event.clientX, y: event.clientY });
          if (type === 'contextmenu') event.preventDefault();
        });
      }
      document.addEventListener('mousemove', (event) => {
        if (event.buttons) window.events.push({ type: 'drag', x: event.clientX, y: event.clientY });
      });
      window.keys = [];
      document.addEventListener('keydown', (event) => window.keys.push('down:' + event.key));
      document.addEventListener('keyup', (event) => window.keys.push('up:' + event.key));
    </script>
  `,
});

const textOf = (result: ToolResultBlock) => {
  if (typeof result.content === 'string') return result.content;
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
};

const stateOf = (result: ToolResultBlock): BrowserStateBlock | undefined => {
  if (typeof result.content === 'string') return undefined;
  return (result.content ?? []).find(
    (block): block is BrowserStateBlock => block.type === 'browser_state'
  );
};

const refFor = (output: string, pattern: RegExp) => {
  const line = output.split('\n').find((candidate) => pattern.test(candidate));
  const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
  if (!ref) {
    throw new Error(`No ref matching ${pattern} in:\n${output}`);
  }
  return ref;
};

const pngDimensions = (base64: string) => {
  const buffer = Buffer.from(base64, 'base64');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

describe('BrowserUseToolset (Anthropic browser toolset)', () => {
  let server: http.Server;
  let baseUrl: string;
  let browser: Browser;
  let context: BrowserContext;
  let session: BrowserSession;
  let toolset: BrowserUseToolset;
  let workDir: string;
  let callId = 0;

  const call = (name: string, input: Record<string, unknown> = {}) =>
    toolset.execute({
      id: `toolu_${++callId}`,
      name,
      input,
      toolset_name: 'browser',
    });

  const block = (
    name: string,
    input: Record<string, unknown> = {}
  ): BrowserToolUse => ({
    id: `toolu_${++callId}`,
    name,
    input,
    toolset_name: 'browser',
  });

  const activePage = async () => {
    const entry = session.get_tab_pages().find((tab) => tab.active);
    return entry!.page!;
  };

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-toolset-'));
    fs.mkdirSync(path.join(workDir, 'uploads'));
    fs.writeFileSync(path.join(workDir, 'uploads', 'note.txt'), 'upload me');
    fs.writeFileSync(path.join(workDir, 'outside.txt'), 'nope');

    server = http.createServer((request, response) => {
      const { port } = server.address() as AddressInfo;
      if (request.url === '/api') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      if (request.url === '/download') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="report.txt"',
        });
        response.end('report body');
        return;
      }
      const body = fixturePages(port)[request.url ?? ''];
      response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
      response.end(
        body ? `<!doctype html><html><body>${body}</body></html>` : ''
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1000, height: 700 },
    });
    const page = await context.newPage();
    session = new BrowserSession({
      browser,
      browser_context: context,
      page,
      profile: { highlight_elements: false },
    });
    await session.start();
  }, 60_000);

  afterAll(async () => {
    await toolset?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await toolset?.close();
    toolset = new BrowserUseToolset({
      browser: session,
      configs: {
        javascript_exec: { enabled: true },
        read_console: { enabled: true },
        read_network: { enabled: true },
        file_upload: { enabled: true },
      },
      uploadRoots: [path.join(workDir, 'uploads')],
    });
    // Leave exactly one tab on the fixture page.
    const tabs = session.get_tab_pages();
    for (const tab of tabs.slice(1)) {
      await session.close_tab(tab.tab_id);
    }
    await session.navigate_to(`${baseUrl}/`);
    await toolset.start();
  }, 30_000);

  it('declares the toolset with uploads disabled unless enabled', () => {
    const defaults = new BrowserUseToolset({ browser: session });
    expect(defaults.toolParam()).toEqual({
      type: 'browser_toolset_20260801',
      configs: { file_upload: { enabled: false } },
    });
    expect(defaults.isEnabled('javascript_exec')).toBe(false);
    expect(defaults.isEnabled('navigate')).toBe(true);
    expect(toolset.toolParam().configs?.file_upload).toEqual({ enabled: true });
    expect(
      () => new BrowserUseToolset({ configs: { nope: {} } as any })
    ).toThrow(/Unknown browser toolset member/);
  });

  it('reads the page with refs, including same-origin and cross-origin frames', async () => {
    const result = await call('read_page');
    expect(result.is_error).toBeUndefined();
    expect(result.toolset_name).toBe('browser');
    const output = textOf(result);
    expect(output).toMatch(/\[ref_\d+\] heading "Fixture Heading" level=1/);
    expect(output).toMatch(/\[ref_\d+\] link "Other page" href=".*\/other"/);
    expect(output).toMatch(/\[ref_\d+\] textbox "Your name"/);
    expect(output).toMatch(/textbox "Password" type=password/);
    expect(output).not.toContain('secret');
    expect(output).toMatch(
      /combobox "Fruit" value="Apple" options=\["Apple", "Banana"\]/
    );
    expect(output).toMatch(/checkbox "I agree" checked=false/);
    expect(output).toMatch(/button "Inner"/);
    expect(output).toMatch(/button "Cross"/);
    // The iframe content is nested below its iframe element.
    const lines = output.split('\n');
    const frameLine = lines.findIndex((line) =>
      line.includes('iframe "Cross frame"')
    );
    const crossLine = lines.findIndex((line) =>
      line.includes('button "Cross"')
    );
    expect(crossLine).toBeGreaterThan(frameLine);
    expect(lines[crossLine]!.search(/\S/)).toBeGreaterThan(
      lines[frameLine]!.search(/\S/)
    );
    // Off-screen content is only listed with filter "all".
    expect(output).not.toContain('Far button');
    const all = textOf(await call('read_page', { filter: 'all' }));
    expect(all).toContain('button "Far button"');

    const interactive = textOf(
      await call('read_page', { filter: 'interactive' })
    );
    expect(interactive).not.toContain('heading');
    expect(interactive).toMatch(/button "Press me"/);
    expect(interactive).toMatch(/button "Cross"/);

    // Refs are stable for the same element within a document.
    const again = textOf(await call('read_page'));
    expect(refFor(again, /button "Press me"/)).toBe(
      refFor(output, /button "Press me"/)
    );

    const scoped = textOf(
      await call('read_page', { ref: refFor(output, /combobox "Fruit"/) })
    );
    expect(scoped.split('\n')[0]).toMatch(/^\[ref_\d+\] combobox "Fruit"/);
  });

  it('does not depend on a page-global __name helper', async () => {
    const page = await activePage();
    await page.evaluate(() => {
      Object.defineProperty(globalThis, '__name', {
        configurable: true,
        get() {
          throw new Error('page __name used');
        },
      });
    });
    const result = await call('read_page');
    expect(result.is_error).toBeUndefined();
    expect(textOf(result)).toContain('Fixture Heading');
  });

  it('clicks refs in the page, a same-origin frame, and a cross-origin frame', async () => {
    const output = textOf(await call('read_page'));
    const page = await activePage();

    const click = await call('left_click', {
      target: { type: 'ref', ref: refFor(output, /button "Press me"/) },
    });
    expect(click.is_error).toBeUndefined();
    expect(textOf(click)).toMatch(
      /^Clicked ref_\d+ at \(\d+(\.\d)?, \d+(\.\d)?\)\.$/
    );
    expect(await page.textContent('#btn')).toBe('Clicked!');

    await call('left_click', {
      target: { type: 'ref', ref: refFor(output, /button "Inner"/) },
    });
    const inner = page
      .frames()
      .find((frame) => frame.url().endsWith('/frame'))!;
    expect(await inner.textContent('#inner')).toBe('Inner clicked');

    const crossClick = await call('left_click', {
      target: { type: 'ref', ref: refFor(output, /button "Cross"/) },
    });
    expect(crossClick.is_error).toBeUndefined();
    const cross = page
      .frames()
      .find((frame) => frame.url().endsWith('/xframe'))!;
    expect(await cross.textContent('#cross-btn')).toBe('Cross clicked');

    const crossInput = await call('form_input', {
      target: { type: 'ref', ref: refFor(output, /textbox "Cross input"/) },
      value: 'typed across origins',
    });
    expect(crossInput.is_error).toBeUndefined();
    expect(await cross.inputValue('#cross-input')).toBe('typed across origins');
  });

  it('fills, selects, checks, and edits form elements by ref', async () => {
    const output = textOf(await call('read_page'));
    const page = await activePage();
    const set = (pattern: RegExp, value: unknown) =>
      call('form_input', {
        target: { type: 'ref', ref: refFor(output, pattern) },
        value,
      });

    expect((await set(/textbox "Your name"/, 'Ada')).is_error).toBeUndefined();
    expect(await page.inputValue('#name')).toBe('Ada');

    const select = await set(/combobox "Fruit"/, 'Banana');
    expect(textOf(select)).toBe(
      `Selected "Banana" in ${refFor(output, /combobox "Fruit"/)}.`
    );
    expect(await page.inputValue('#fruit')).toBe('b');
    const missing = await set(/combobox "Fruit"/, 'Cherry');
    expect(missing.is_error).toBe(true);
    expect(textOf(missing)).toContain('Options: ["Apple","Banana"]');

    await set(/checkbox "I agree"/, true);
    expect(await page.isChecked('#agree')).toBe(true);
    await set(/checkbox "I agree"/, false);
    expect(await page.isChecked('#agree')).toBe(false);
    const notBoolean = await set(/checkbox "I agree"/, 'yes');
    expect(textOf(notBoolean)).toContain('require a boolean');

    await set(/radio "Large"/, true);
    expect(await page.isChecked('#r2')).toBe(true);
    expect(textOf(await set(/radio "Large"/, false))).toContain(
      'Choose another radio option'
    );

    await set(/slider "Volume"/, 7);
    expect(await page.inputValue('#volume')).toBe('7');

    await set(/textbox "Editor"/, 'final text');
    expect(await page.textContent('#editor')).toBe('final text');

    const locked = await call('form_input', {
      target: {
        type: 'ref',
        ref: refFor(
          textOf(await call('read_page', { filter: 'all' })),
          /textbox "Locked"/
        ),
      },
      value: 'x',
    });
    expect(locked.is_error).toBe(true);
    expect(textOf(locked)).toBe('Form element is disabled or read-only.');
  });

  it('uploads only files inside the configured upload roots', async () => {
    const output = textOf(await call('read_page'));
    const ref = refFor(output, /button "Attachment" type=file/);
    const page = await activePage();

    const outside = await call('file_upload', {
      target: { type: 'ref', ref },
      paths: [path.join(workDir, 'outside.txt')],
    });
    expect(outside.is_error).toBe(true);
    expect(textOf(outside)).toContain('outside the allowed upload roots');

    const withoutResolver = await call('file_upload', {
      target: { type: 'ref', ref },
      document_ids: ['doc_1'],
    });
    expect(textOf(withoutResolver)).toContain('documentResolver');

    const upload = await call('file_upload', {
      target: { type: 'ref', ref },
      paths: [path.join(workDir, 'uploads', 'note.txt')],
    });
    expect(upload.is_error).toBeUndefined();
    expect(textOf(upload)).toBe(`Attached 1 file to ${ref}.`);
    expect(
      await page.evaluate(
        () =>
          (document.getElementById('file') as HTMLInputElement).files![0]!.name
      )
    ).toBe('note.txt');

    const disabled = new BrowserUseToolset({ browser: session });
    const refused = await disabled.execute(
      block('file_upload', { target: { type: 'ref', ref }, paths: ['x'] })
    );
    expect(textOf(refused)).toBe(
      "file_upload is disabled in this toolset's configs."
    );
  });

  it('navigates, reports status, and invalidates refs', async () => {
    const before = textOf(await call('read_page'));
    const ref = refFor(before, /button "Press me"/);

    const result = await call('navigate', { url: `${baseUrl}/other` });
    expect(result.is_error).toBeUndefined();
    expect(textOf(result)).toBe(
      `url: ${baseUrl}/other\ntitle: Other\nstatus: 200`
    );

    const stale = await call('left_click', { target: { type: 'ref', ref } });
    expect(stale.is_error).toBe(true);
    expect(textOf(stale)).toMatch(/is stale/);
    // A failed call never carries browser state.
    expect(stateOf(stale)).toBeUndefined();

    const back = await call('navigate', { url: 'back' });
    expect(textOf(back)).toContain(`url: ${baseUrl}/`);
  });

  it('captures viewport screenshots and zooms into regions', async () => {
    const screenshot = await call('screenshot');
    const image = (screenshot.content as any[])[0];
    expect(image.type).toBe('image');
    expect(image.source.media_type).toBe('image/png');
    expect(pngDimensions(image.source.data)).toEqual({
      width: 1000,
      height: 700,
    });

    const zoom = await call('zoom', { region: [0, 0, 200, 100] });
    expect(pngDimensions((zoom.content as any[])[0].source.data)).toEqual({
      width: 400,
      height: 200,
    });

    const invalid = await call('zoom', { region: [0, 0, 2000, 100] });
    expect(invalid.is_error).toBe(true);
    expect(textOf(invalid)).toBe(
      'Zoom region must lie inside the full viewport screenshot.'
    );
  });

  it('dispatches pointer actions with click counts, buttons, modifiers, and drags', async () => {
    await call('navigate', { url: `${baseUrl}/mouse` });
    const page = await activePage();
    const events = () => page.evaluate(() => (window as any).events.splice(0));

    await call('double_click', {
      target: { type: 'coordinate', x: 100, y: 100 },
    });
    const double = await events();
    expect(
      double
        .filter((event: any) => event.type === 'mousedown')
        .map((event: any) => event.detail)
    ).toEqual([1, 2]);
    expect(double.some((event: any) => event.type === 'dblclick')).toBe(true);

    await call('triple_click', {
      target: { type: 'coordinate', x: 100, y: 100 },
    });
    expect(
      (await events())
        .filter((event: any) => event.type === 'mousedown')
        .map((event: any) => event.detail)
    ).toEqual([1, 2, 3]);

    await call('right_click', { target: { type: 'coordinate', x: 50, y: 60 } });
    expect(
      (await events()).find((event: any) => event.type === 'contextmenu')
    ).toMatchObject({ button: 2, x: 50, y: 60 });

    await call('left_click', {
      target: { type: 'coordinate', x: 10, y: 10 },
      modifiers: 'shift',
    });
    expect(
      (await events()).find((event: any) => event.type === 'click')
    ).toMatchObject({ shift: true });

    const unsupported = await call('left_click', {
      target: { type: 'coordinate', x: 10, y: 10 },
      modifiers: 'hyper',
    });
    expect(textOf(unsupported)).toBe('Unsupported modifier hyper');

    await call('left_click_drag', {
      from: { type: 'coordinate', x: 20, y: 20 },
      target: { type: 'coordinate', x: 220, y: 120 },
    });
    const drag = await events();
    expect(drag[0]).toMatchObject({ type: 'mousedown', x: 20, y: 20 });
    expect(
      drag.filter((event: any) => event.type === 'drag').length
    ).toBeGreaterThanOrEqual(5);
    expect(drag.find((event: any) => event.type === 'mouseup')).toMatchObject({
      x: 220,
      y: 120,
    });

    await call('left_mouse_down', {
      target: { type: 'coordinate', x: 30, y: 30 },
    });
    const twice = await call('left_mouse_down', {
      target: { type: 'coordinate', x: 30, y: 30 },
    });
    expect(textOf(twice)).toBe('Left mouse button is already held.');
    const blocked = await call('left_click', {
      target: { type: 'coordinate', x: 30, y: 30 },
    });
    expect(textOf(blocked)).toBe(
      'Release held mouse buttons before starting a click.'
    );
    await call('mouse_move', { target: { type: 'coordinate', x: 60, y: 60 } });
    await call('left_mouse_up', {
      target: { type: 'coordinate', x: 90, y: 90 },
    });
    const manual = await events();
    expect(manual.find((event: any) => event.type === 'drag')).toMatchObject({
      x: 60,
      y: 60,
    });
    expect(manual.find((event: any) => event.type === 'mouseup')).toMatchObject(
      { x: 90, y: 90 }
    );

    const outside = await call('left_click', {
      target: { type: 'coordinate', x: 5000, y: 10 },
    });
    expect(textOf(outside)).toBe(
      'Target lies outside the current viewport. Use scroll_to or a fresh screenshot.'
    );
  });

  it('types text, presses chords and sequences, and holds keys', async () => {
    const output = textOf(await call('read_page'));
    const page = await activePage();
    await call('left_click', {
      target: { type: 'ref', ref: refFor(output, /textbox "Your name"/) },
    });
    expect(textOf(await call('type', { text: 'héllo wörld' }))).toBe(
      'Typed 11 characters.'
    );
    expect(await page.inputValue('#name')).toBe('héllo wörld');

    const selectAll = process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a';
    expect(
      (await call('key', { text: `${selectAll} BackSpace` })).is_error
    ).toBeUndefined();
    expect(await page.inputValue('#name')).toBe('');

    await call('type', { text: 'ab' });
    expect(textOf(await call('key', { text: 'Left', repeat: 2 }))).toBe(
      'Pressed Left 2 times.'
    );
    await call('type', { text: '>' });
    expect(await page.inputValue('#name')).toBe('>ab');
    await call('key', { text: 'shift+x' });
    expect(await page.inputValue('#name')).toBe('>Xab');

    const unknown = await call('key', { text: 'NotAKey' });
    expect(unknown.is_error).toBe(true);
    expect(textOf(unknown)).toMatch(/^Error: .*Unknown key/);

    await call('navigate', { url: `${baseUrl}/mouse` });
    const mousePage = await activePage();
    const held = await call('hold_key', { text: 'shift', duration: 0.2 });
    expect(textOf(held)).toBe('Held shift for 0.2s.');
    expect(await mousePage.evaluate(() => (window as any).keys)).toEqual([
      'down:Shift',
      'up:Shift',
    ]);
    const sequence = await call('hold_key', { text: 'a b', duration: 0 });
    expect(textOf(sequence)).toBe(
      'hold_key accepts one key or chord, not a sequence.'
    );
  });

  it('scrolls with the wheel and scrolls refs into view', async () => {
    const page = await activePage();
    const scroll = await call('scroll', {
      target: { type: 'coordinate', x: 500, y: 400 },
      scroll_direction: 'down',
      scroll_amount: 5,
    });
    expect(textOf(scroll)).toBe('Scrolled down by 500px at (500, 400).');
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);

    const all = textOf(await call('read_page', { filter: 'all' }));
    await call('scroll_to', {
      target: { type: 'ref', ref: refFor(all, /button "Far button"/) },
    });
    const visible = textOf(await call('read_page'));
    expect(visible).toContain('Far button');
  });

  it('finds elements by description and extracts page text', async () => {
    const found = textOf(await call('find', { query: 'name field' }));
    expect(found.split('\n')[0]).toMatch(/^\[ref_\d+\] textbox "Your name"/);
    const meaningless = await call('find', { query: 'the element' });
    expect(textOf(meaningless)).toBe('Use a meaningful element description.');
    const none = await call('find', { query: 'zebra unicorn' });
    expect(textOf(none)).toBe(
      'No matching elements. Try visible label text or read_page.'
    );

    const text = textOf(await call('get_page_text'));
    expect(text).toContain('Fixture Heading');
    expect(text).toContain('Press me');
  });

  it('reports console, network, and JavaScript results per tab', async () => {
    await call('navigate', { url: `${baseUrl}/` });
    const page = await activePage();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      console.warn('multi\nline');
      setTimeout(() => {
        throw new Error('boom');
      });
    });
    await page.waitForTimeout(100);

    const consoleText = textOf(await call('read_console'));
    expect(consoleText).toContain('log: fixture ready');
    expect(consoleText).toContain('warning: multi\\nline');
    expect(consoleText).toMatch(/error: Error: boom/);
    expect(textOf(await call('read_console'))).toBe('(No console entries.)');

    const network = textOf(await call('read_network'))
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(network).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        url: `${baseUrl}/api`,
        status: 200,
        mime: 'application/json',
      })
    );

    expect(
      textOf(await call('javascript_exec', { text: 'document.title' }))
    ).toBe('Toolset Fixture');
    expect(
      textOf(await call('javascript_exec', { text: '({ a: 1, b: [2] })' }))
    ).toBe('{"a":1,"b":[2]}');
    expect(textOf(await call('javascript_exec', { text: 'undefined' }))).toBe(
      'undefined'
    );
    const thrown = await call('javascript_exec', {
      text: 'throw new Error("bad script")',
    });
    expect(thrown.is_error).toBe(true);
    expect(textOf(thrown)).toContain('bad script');

    const disabled = new BrowserUseToolset({ browser: session });
    expect(
      textOf(await disabled.execute(block('javascript_exec', { text: '1' })))
    ).toBe("javascript_exec is disabled in this toolset's configs.");
  });

  it('manages tabs with browser_state-only results', async () => {
    const initial = session.get_tab_pages();
    expect(initial).toHaveLength(1);
    const firstTab = initial[0]!.tab_id;

    const opened = await call('new_tab');
    expect(opened.is_error).toBeUndefined();
    const openedContent = opened.content as any[];
    expect(openedContent).toHaveLength(1);
    const openedState = stateOf(opened)!;
    expect(openedState.tabs).toHaveLength(2);
    const newTab = openedState.tabs.find((tab) => tab.tab_id !== firstTab)!;
    expect(newTab).toMatchObject({
      url: 'about:blank',
      title: '',
      active: true,
    });
    expect(openedState.state_changes).toEqual([
      { type: 'tab_opened', tab_id: newTab.tab_id },
    ]);

    const listed = stateOf(await call('list_tabs'))!;
    expect(listed.tabs.map((tab) => tab.active)).toEqual([false, true]);
    expect(listed.state_changes).toBeUndefined();

    const switched = await call('switch_tab', { tab_id: firstTab });
    expect(stateOf(switched)!.tabs.find((tab) => tab.active)!.tab_id).toBe(
      firstTab
    );
    expect(
      (switched.content as any[]).every((item) => item.type === 'browser_state')
    ).toBe(true);

    const missing = await call('switch_tab', { tab_id: '9999' });
    expect(missing.is_error).toBe(true);
    expect(missing.content).toBe(
      'Tab 9999 is not open. Call list_tabs to see open tabs.'
    );

    // Acting on another tab focuses it and reports the change.
    const onNewTab = await call('navigate', {
      url: `${baseUrl}/other`,
      tab_id: newTab.tab_id,
    });
    const navState = stateOf(onNewTab)!;
    expect(navState.tabs.find((tab) => tab.active)).toMatchObject({
      tab_id: newTab.tab_id,
      url: `${baseUrl}/other`,
      title: 'Other',
    });

    const closed = await call('close_tab', { tab_id: newTab.tab_id });
    expect(stateOf(closed)!.tabs.map((tab) => tab.tab_id)).toEqual([firstTab]);
    expect(stateOf(closed)!.tabs[0]!.active).toBe(true);
  });

  it('reports popups and downloads as state changes', async () => {
    const output = textOf(await call('read_page'));
    await call('left_click', {
      target: { type: 'ref', ref: refFor(output, /link "Open popup"/) },
    });
    await expect.poll(() => context.pages().length).toBe(2);
    const afterPopup = await call('wait', { duration: 0.3 });
    const popupState = stateOf(afterPopup)!;
    expect(popupState.state_changes).toEqual([
      { type: 'tab_opened', tab_id: expect.any(String) },
    ]);
    expect(popupState.tabs).toHaveLength(2);
    // The opener keeps focus; Claude can switch to the popup explicitly.
    expect(popupState.tabs.find((tab) => tab.active)!.url).toBe(`${baseUrl}/`);

    await call('left_click', {
      target: { type: 'ref', ref: refFor(output, /link "Download report"/) },
    });
    let downloadState: BrowserStateBlock | undefined;
    for (
      let attempt = 0;
      attempt < 20 &&
      !downloadState?.state_changes?.some(
        (change) => change.type === 'download_completed'
      );
      attempt += 1
    ) {
      downloadState = stateOf(await call('wait', { duration: 0.1 }));
    }
    const completed = downloadState!.state_changes!.find(
      (change) => change.type === 'download_completed'
    ) as any;
    expect(completed).toMatchObject({
      download_id: expect.stringMatching(/^download_\d+$/),
      url: `${baseUrl}/download`,
      size_bytes: 11,
    });
    expect(fs.readFileSync(completed.path, 'utf8')).toBe('report body');
    expect(toolset.completedDownloadPaths).toContain(completed.path);
  });

  it('halts the rest of a batch after a failure and validates inputs', async () => {
    const results = await toolset.executeBatch([
      block('left_click', { target: { type: 'ref', ref: 'ref_999999' } }),
      block('screenshot'),
      block('list_tabs'),
    ]);
    expect(results[0]!.is_error).toBe(true);
    expect(results.slice(1)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: expect.any(String),
        toolset_name: 'browser',
        is_error: true,
        content: BATCH_HALT_TEXT,
      },
      {
        type: 'tool_result',
        tool_use_id: expect.any(String),
        toolset_name: 'browser',
        is_error: true,
        content: BATCH_HALT_TEXT,
      },
    ]);

    const invalid = await call('scroll', {
      target: { type: 'coordinate', x: 1, y: 1 },
      scroll_direction: 'sideways',
    });
    expect(invalid.is_error).toBe(true);
    expect(textOf(invalid)).toMatch(/^Invalid scroll input: scroll_direction:/);
    expect(textOf(await call('teleport'))).toBe(
      'Unknown browser action: teleport'
    );

    const declined = new BrowserUseToolset({
      browser: session,
      confirm: () => false,
    });
    const result = await declined.execute(block('screenshot'));
    expect(result).toMatchObject({
      is_error: true,
      content: 'This browser action was not approved.',
    });
    const approvals: string[] = [];
    const approving = new BrowserUseToolset({
      browser: session,
      confirm: (request) => {
        approvals.push(request.name);
        return true;
      },
    });
    expect(
      (await approving.execute(block('wait', { duration: 0 }))).is_error
    ).toBeUndefined();
    expect(approvals).toEqual(['wait']);
  });

  it('refuses to start with an unstarted borrowed session', async () => {
    const unstarted = new BrowserUseToolset({ browser: new BrowserSession() });
    const result = await unstarted.execute(block('screenshot'));
    expect(result.is_error).toBe(true);
    expect(textOf(result)).toContain('Start the borrowed BrowserSession');
    expect(
      () => new BrowserUseToolset({ browser: session, useCloud: true })
    ).toThrow('Pass either a BrowserSession or useCloud, not both.');
  });
});
