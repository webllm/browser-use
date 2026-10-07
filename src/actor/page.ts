import { setTimeout as sleep } from 'node:timers/promises';
import type { WaitUntilState } from '../browser/events.js';
import type { BrowserSession } from '../browser/session.js';
import { Element } from './element.js';
import { Mouse } from './mouse.js';

const HOLD_KEY_ALIASES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  cmd: 'Meta',
  meta: 'Meta',
  shift: 'Shift',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  space: ' ',
};

const HOLD_KEY_MODIFIERS: ReadonlySet<string> = new Set([
  'Alt',
  'Control',
  'Meta',
  'Shift',
]);

export interface ScreenshotClip {
  /** Document-pixel region. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Output scale for the region (default 1); values above 1 zoom in. */
  scale?: number;
}

const buildExpression = (source: string, args: unknown[]) =>
  `(${source})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;

export class Page {
  private _mouse: Mouse | null = null;

  constructor(private readonly browser_session: BrowserSession) {}

  get mouse() {
    if (!this._mouse) {
      this._mouse = new Mouse(this.browser_session);
    }
    return this._mouse;
  }

  async _currentPage() {
    const page = await this.browser_session.get_current_page();
    if (!page) {
      throw new Error('No active page available');
    }
    return page;
  }

  async get_url() {
    const page = await this._currentPage();
    await this.browser_session.validate_page_after_action(page);
    try {
      return typeof page.url === 'function' ? page.url() : '';
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async get_title() {
    const page = await this._currentPage();
    await this.browser_session.validate_page_after_action(page);
    try {
      return typeof page.title === 'function' ? page.title() : '';
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async goto(
    url: string,
    options: {
      wait_until?: WaitUntilState;
      timeout_ms?: number | null;
    } = {}
  ) {
    await this.browser_session.navigate_to(url, {
      wait_until: options.wait_until,
      timeout_ms: options.timeout_ms,
    });
  }

  async navigate(url: string, options: Parameters<Page['goto']>[1] = {}) {
    await this.goto(url, options);
  }

  async reload() {
    await this.browser_session.refresh();
  }

  async go_back() {
    await this.browser_session.go_back();
  }

  async go_forward() {
    await this.browser_session.go_forward();
  }

  async evaluate(
    page_function: string | ((...args: unknown[]) => unknown),
    ...args: unknown[]
  ) {
    const page = await this._currentPage();
    await this.browser_session.validate_page_after_action(page);
    try {
      if (typeof page_function === 'function') {
        return await page.evaluate(page_function as any, ...args);
      }
      if (args.length === 0) {
        return await page.evaluate(page_function);
      }
      return await page.evaluate(buildExpression(page_function, args));
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  /** Capture the page as a base64 image, optionally clipped and scaled. */
  async screenshot(
    options: {
      full_page?: boolean;
      clip?: ScreenshotClip | null;
      format?: 'png' | 'jpeg' | 'webp';
      quality?: number | null;
    } = {}
  ) {
    if (!options.clip && !options.format && options.quality == null) {
      return this.browser_session.take_screenshot(options.full_page ?? false);
    }
    return this.browser_session.take_screenshot(
      options.full_page ?? false,
      options.clip ?? null,
      { format: options.format, quality: options.quality }
    );
  }

  async press(key: string) {
    await this.browser_session.send_keys(key);
  }

  /**
   * Hold a key or modifier chord (such as `Shift` or `Control+a`) for
   * `duration` seconds, releasing every pressed key afterwards. One key-down
   * is sent per key; auto-repeat is not synthesized.
   */
  async hold_key(key: string, duration: number) {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error('duration must be finite and non-negative');
    }
    const keys =
      key === '+'
        ? ['+']
        : key
            .split('+')
            .map((part) => HOLD_KEY_ALIASES[part.toLowerCase()] ?? part);
    if (
      !keys.length ||
      keys.some((part) => !part) ||
      keys.slice(0, -1).some((part) => !HOLD_KEY_MODIFIERS.has(part))
    ) {
      throw new Error('Use one key or a modifier chord, such as Control+a');
    }
    const page = await this._currentPage();
    await this.browser_session.validate_page_after_action(page);
    const held: string[] = [];
    let actionError: unknown = null;
    try {
      for (const part of keys) {
        await page.keyboard.down(part);
        held.push(part);
      }
      await sleep(duration * 1000);
    } catch (error) {
      actionError = error;
    }
    // Release every pressed key even when pressing or waiting failed.
    let releaseError: unknown = null;
    for (const part of held.reverse()) {
      try {
        await page.keyboard.up(part);
      } catch (error) {
        releaseError ??= error;
      }
    }
    await this.browser_session.validate_page_after_action(page);
    if (actionError || releaseError) {
      throw actionError ?? releaseError;
    }
  }

  async set_viewport_size(width: number, height: number) {
    const page = await this._currentPage();
    if (!page.setViewportSize) {
      return;
    }
    await this.browser_session.validate_page_after_action(page);
    try {
      await page.setViewportSize({ width, height });
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async get_element_by_index(index: number) {
    const node = await this.browser_session.get_dom_element_by_index(index);
    if (!node) {
      return null;
    }
    return new Element(this.browser_session, node);
  }

  async must_get_element_by_index(index: number) {
    const element = await this.get_element_by_index(index);
    if (!element) {
      throw new Error(`Element not found for index ${index}`);
    }
    return element;
  }
}
