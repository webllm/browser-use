import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { run_direct_command } from '../src/skill-cli/direct.js';
import {
  DIRECT_SCRIPT_HELPERS,
  createDirectScriptHelpers,
  readDirectScriptSource,
  runDirectScript,
} from '../src/skill-cli/script.js';

const createWritable = () => {
  let buffer = '';
  return {
    stream: {
      write(chunk: string) {
        buffer += chunk;
      },
    },
    read: () => buffer,
  };
};

const createFakeEnvironment = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-direct-script-'));
  let currentUrl = 'about:blank';
  const page = {
    url: () => currentUrl,
    title: async () => 'Fake title',
  };
  const session = {
    start: vi.fn(async () => {}),
    navigate_to: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    get_current_page: vi.fn(async () => page),
    get_page_info: vi.fn(async () => ({ viewport_width: 800 })),
    event_bus: { stop: vi.fn(async () => {}) },
    detach_all_watchdogs: vi.fn(),
  };
  const stdout = createWritable();
  const stderr = createWritable();
  const sessionFactory = vi.fn(() => session as any);
  return {
    tempDir,
    session,
    stdout,
    stderr,
    sessionFactory,
    options: {
      state_file: path.join(tempDir, 'state.json'),
      stdout: stdout.stream,
      stderr: stderr.stream,
      session_factory: sessionFactory,
      local_launcher: vi.fn(async () => ({
        cdp_url: 'http://127.0.0.1:9222',
      })),
    },
  };
};

describe('browser-use-direct script mode', () => {
  it('runs inline scripts with browser helpers and prints results', async () => {
    const env = createFakeEnvironment();
    try {
      const exitCode = await run_direct_command(
        [
          'script',
          '-e',
          'await goto_url("example.com"); print("info", await page_info()); return { done: true };',
        ],
        { ...env.options, allow_scripts: true }
      );

      expect(env.stderr.read()).toBe('');
      expect(exitCode).toBe(0);
      expect(env.session.navigate_to).toHaveBeenCalledWith(
        'https://example.com'
      );
      const output = env.stdout.read();
      expect(output).toContain('info {');
      expect(output).toContain('"url": "https://example.com"');
      expect(output).toContain('"title": "Fake title"');
      expect(output).toContain('"viewport_width": 800');
      expect(output.trim().endsWith('{\n  "done": true\n}')).toBe(true);
      // Direct-mode state is persisted like any other command.
      expect(
        JSON.parse(fs.readFileSync(env.options.state_file, 'utf8')).cdp_url
      ).toBe('http://127.0.0.1:9222');
    } finally {
      fs.rmSync(env.tempDir, { recursive: true, force: true });
    }
  });

  it('is refused unless the CLI enables scripts', async () => {
    const env = createFakeEnvironment();
    try {
      const exitCode = await run_direct_command(
        ['script', '-e', 'print(1)'],
        env.options
      );
      expect(exitCode).toBe(1);
      expect(env.stderr.read()).toContain(
        'script is only available from the browser-use-direct CLI'
      );
      expect(env.sessionFactory).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(env.tempDir, { recursive: true, force: true });
    }
  });

  it('reads scripts from stdin and files and reports script errors', async () => {
    const env = createFakeEnvironment();
    try {
      const fromStdin = await run_direct_command(['script', '-'], {
        ...env.options,
        allow_scripts: true,
        read_stdin: async () => 'print("from stdin")',
      });
      expect(fromStdin).toBe(0);
      expect(env.stdout.read()).toContain('from stdin');

      const file = path.join(env.tempDir, 'steps.js');
      fs.writeFileSync(file, 'throw new Error("boom in file")');
      const failed = await run_direct_command(['script', file], {
        ...env.options,
        allow_scripts: true,
      });
      expect(failed).toBe(1);
      expect(env.stderr.read()).toContain('Error: boom in file');

      const syntax = await run_direct_command(['script', '-e', 'print('], {
        ...env.options,
        allow_scripts: true,
      });
      expect(syntax).toBe(1);
      expect(env.stderr.read()).toContain('Script syntax error in <eval>');

      await expect(
        readDirectScriptSource([], async () => '   ')
      ).rejects.toThrow('The script on stdin is empty');
      await expect(
        readDirectScriptSource(['a.js', 'b.js'], async () => '')
      ).rejects.toThrow('Usage: script');
    } finally {
      fs.rmSync(env.tempDir, { recursive: true, force: true });
    }
  });
});

describe('browser-use-direct script helpers on a real browser', () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;
  let session: BrowserSession;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        request.url === '/next'
          ? '<title>Next</title><h1>Next page</h1>'
          : '<title>Start</title><input id="q" aria-label="Query"><button onclick="document.title=\'clicked\'">Go</button>'
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('binds every documented helper to the BrowserSession API', async () => {
    const stdout = createWritable();
    const helpers = createDirectScriptHelpers(session, stdout.stream);
    expect(Object.keys(helpers).sort()).toEqual(
      [...DIRECT_SCRIPT_HELPERS].sort()
    );

    const screenshotPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bu-script-shot-')),
      'page.png'
    );
    await runDirectScript(
      {
        filename: '<test>',
        code: `
          await goto_url(${JSON.stringify(`${baseUrl}/`)});
          await fill_input('#q', 'hello');
          print('value', await js(() => document.querySelector('#q').value));
          const tree = await state();
          const index = tree.match(/\\[(\\d+)\\]<button/)[1];
          await click(Number(index));
          print('title', await js('document.title'));
          await new_tab(${JSON.stringify(`${baseUrl}/next`)});
          const tabs = await list_tabs();
          print('tabs', tabs.length);
          await switch_tab(tabs[0].tab_id);
          print('back on', (await page_info()).url);
          await close_tab(tabs[1].tab_id);
          print('shot', await capture_screenshot(${JSON.stringify(screenshotPath)}));
          return (await list_tabs()).length;
        `,
      },
      helpers,
      stdout.stream
    );

    const output = stdout.read();
    expect(output).toContain('value hello');
    expect(output).toContain('title clicked');
    expect(output).toContain('tabs 2');
    expect(output).toContain(`back on ${baseUrl}/`);
    expect(output).toContain(`shot ${screenshotPath}`);
    expect(output.trim().endsWith('1')).toBe(true);
    expect(fs.readFileSync(screenshotPath).subarray(1, 4).toString()).toBe(
      'PNG'
    );
  }, 60_000);
});
