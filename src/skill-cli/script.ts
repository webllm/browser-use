/**
 * JavaScript script mode for browser-use-direct.
 *
 * `browser-use-direct script <file|->` runs JavaScript in the CLI process with
 * helpers bound to the persistent browser, so a coding agent can batch several
 * steps (and its own logic) into one call. It mirrors the helper names of the
 * Python CLI 3.0 stdin mode. Scripts run with the invoking user's Node.js
 * privileges, so the fixed direct commands stay the default interface and the
 * MCP server never runs scripts.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const DIRECT_SCRIPT_USAGE =
  'Usage: script <file.js> | script - (read stdin) | script -e <code>';

/** Helper names available to scripts, in documentation order. */
export const DIRECT_SCRIPT_HELPERS = [
  'browser',
  'current_page',
  'new_tab',
  'goto_url',
  'page_info',
  'state',
  'capture_screenshot',
  'click',
  'click_at_xy',
  'input',
  'type_text',
  'fill_input',
  'press_key',
  'scroll',
  'js',
  'wait_for_load',
  'wait_for_element',
  'list_tabs',
  'switch_tab',
  'close_tab',
  'sleep',
  'print',
] as const;

interface StreamLike {
  write(chunk: string): void;
}

export interface DirectScriptSource {
  code: string;
  filename: string;
}

/** Read a script from a file, stdin (`-` or no argument), or `-e <code>`. */
export const readDirectScriptSource = async (
  args: string[],
  readStdin: () => Promise<string>
): Promise<DirectScriptSource> => {
  const [first, ...rest] = args;
  if (first === '-e' || first === '--eval') {
    const code = rest.join(' ');
    if (!code.trim()) {
      throw new Error(`Missing script code. ${DIRECT_SCRIPT_USAGE}`);
    }
    return { code, filename: '<eval>' };
  }
  if (rest.length > 0) {
    throw new Error(DIRECT_SCRIPT_USAGE);
  }
  if (!first || first === '-') {
    const code = await readStdin();
    if (!code.trim()) {
      throw new Error(`The script on stdin is empty. ${DIRECT_SCRIPT_USAGE}`);
    }
    return { code, filename: '<stdin>' };
  }
  const filename = path.resolve(first);
  return { code: await fs.readFile(filename, 'utf8'), filename };
};

export const readProcessStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error(`No script was piped on stdin. ${DIRECT_SCRIPT_USAGE}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const formatValue = (value: unknown) => {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const normalizeUrl = (input: string) => {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) {
    throw new Error('A URL is required');
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
};

/**
 * Build the helpers a script sees. `session` is the connected BrowserSession
 * (typed loosely so tests can pass a fake).
 */
export const createDirectScriptHelpers = (
  session: any,
  stdout: StreamLike
): Record<(typeof DIRECT_SCRIPT_HELPERS)[number], unknown> => {
  const currentPage = async () => {
    const page = await session.get_current_page?.();
    if (!page) {
      throw new Error('No active page');
    }
    return page;
  };
  const requireMethod = (name: string) => {
    if (typeof session[name] !== 'function') {
      throw new Error(`The browser session does not support ${name}`);
    }
    return session[name].bind(session);
  };
  const nodeByIndex = async (index: number) => {
    const node = await requireMethod('get_dom_element_by_index')(Number(index));
    if (!node) {
      throw new Error(
        `Element index ${index} not found; call state() for fresh indexes`
      );
    }
    return node;
  };
  // Re-check the domain policy around raw page operations, like direct commands.
  const withPage = async <T>(action: (page: any) => Promise<T>) => {
    const page = await currentPage();
    await session.validate_page_after_action?.(page);
    try {
      return await action(page);
    } finally {
      await session.validate_page_after_action?.(page);
    }
  };

  return {
    browser: session,
    current_page: currentPage,
    new_tab: async (url = 'about:blank') => {
      await requireMethod('create_new_tab')(
        url === 'about:blank' ? url : normalizeUrl(url)
      );
      return (await currentPage()).url();
    },
    goto_url: async (url: string) => {
      await requireMethod('navigate_to')(normalizeUrl(url));
      return (await currentPage()).url();
    },
    page_info: async () => {
      const page = await currentPage();
      const info = (await session.get_page_info?.(page)) ?? {};
      return { url: page.url(), title: await page.title(), ...info };
    },
    state: async () => {
      const summary = await requireMethod('get_browser_state_with_recovery')({
        include_screenshot: false,
      });
      return summary.llm_representation();
    },
    capture_screenshot: async (
      file?: string,
      options: { full_page?: boolean } = {}
    ) => {
      const data = await requireMethod('take_screenshot')(
        options.full_page ?? false
      );
      if (!data) {
        throw new Error('Screenshot returned no data');
      }
      const target = path.resolve(
        file ??
          path.join(os.tmpdir(), `browser-use-screenshot-${Date.now()}.png`)
      );
      await fs.writeFile(target, Buffer.from(data, 'base64'));
      return target;
    },
    click: async (index: number) => {
      await requireMethod('_click_element_node')(await nodeByIndex(index));
    },
    click_at_xy: async (
      x: number,
      y: number,
      options: {
        button?: 'left' | 'right' | 'middle';
        click_count?: number;
      } = {}
    ) => {
      await requireMethod('click_coordinates')(x, y, options);
    },
    input: async (index: number, text: string) => {
      await requireMethod('_input_text_element_node')(
        await nodeByIndex(index),
        String(text),
        { clear: true }
      );
    },
    type_text: (text: string) =>
      withPage((page) => page.keyboard.type(String(text))),
    fill_input: (selector: string, text: string) =>
      withPage((page) => page.fill(selector, String(text))),
    press_key: async (keys: string) => {
      await requireMethod('send_keys')(String(keys));
    },
    scroll: async (
      direction: 'up' | 'down' | 'left' | 'right' = 'down',
      amount = 500
    ) => {
      await requireMethod('scroll')(direction, amount);
    },
    js: (code: string | ((...args: any[]) => unknown), ...args: unknown[]) =>
      withPage((page) =>
        typeof code === 'function'
          ? page.evaluate(code, ...args)
          : page.evaluate(code)
      ),
    wait_for_load: (
      loadState: 'load' | 'domcontentloaded' | 'networkidle' = 'load'
    ) => withPage((page) => page.waitForLoadState(loadState)),
    wait_for_element: async (selector: string, timeout_ms = 10_000) => {
      await requireMethod('wait_for_element')(selector, timeout_ms);
    },
    list_tabs: async () => requireMethod('get_tabs_info')(),
    switch_tab: async (tab: number | string) => {
      await requireMethod('switch_to_tab')(tab);
      return (await currentPage()).url();
    },
    close_tab: async (tab?: number | string) => {
      const target = tab ?? session.active_tab?.tab_id;
      if (target === undefined || target === null) {
        throw new Error('No tab to close');
      }
      await requireMethod('close_tab')(target);
    },
    sleep: (seconds: number) => sleep(Math.max(0, Number(seconds) || 0) * 1000),
    print: (...values: unknown[]) => {
      stdout.write(`${values.map(formatValue).join(' ')}\n`);
    },
  };
};

const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/**
 * Run script source as an async function body with the helpers in scope.
 * A returned value other than undefined is printed.
 */
export const runDirectScript = async (
  source: DirectScriptSource,
  helpers: Record<string, unknown>,
  stdout: StreamLike
) => {
  const names = Object.keys(helpers);
  let script: (...values: unknown[]) => Promise<unknown>;
  try {
    script = new AsyncFunction(
      ...names,
      `${source.code}\n//# sourceURL=${source.filename.replace(/\s/g, '_')}`
    );
  } catch (error) {
    throw new Error(
      `Script syntax error in ${source.filename}: ${(error as Error).message}`
    );
  }
  const result = await script(...names.map((name) => helpers[name]));
  if (result !== undefined) {
    stdout.write(`${formatValue(result)}\n`);
  }
};
