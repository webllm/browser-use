import type { BrowserSession } from '../browser/session.js';
import type { MouseButton } from '../browser/events.js';

export type KeyboardModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

const KEYBOARD_MODIFIERS: ReadonlySet<string> = new Set([
  'Alt',
  'Control',
  'Meta',
  'Shift',
]);

/** Validate and de-duplicate modifier keys, preserving their order. */
export const normalizeKeyboardModifiers = (
  modifiers: readonly string[] | null | undefined
): KeyboardModifier[] => {
  const keys: KeyboardModifier[] = [];
  for (const modifier of modifiers ?? []) {
    if (!KEYBOARD_MODIFIERS.has(modifier)) {
      throw new Error(`Unsupported modifier: ${modifier}`);
    }
    if (!keys.includes(modifier as KeyboardModifier)) {
      keys.push(modifier as KeyboardModifier);
    }
  }
  return keys;
};

/**
 * Resolve the point a scroll is dispatched at. An explicit 0 means the
 * left/top edge; only a missing coordinate falls back to the viewport center.
 */
export const resolveScrollAnchor = (
  x: number | null | undefined,
  y: number | null | undefined,
  viewportWidth: number,
  viewportHeight: number
): [number, number] => [x ?? viewportWidth / 2, y ?? viewportHeight / 2];

const requirePositiveInteger = (value: number, name: string) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export interface MouseButtonOptions {
  button?: MouseButton;
  click_count?: number;
  modifiers?: KeyboardModifier[] | null;
}

export class Mouse {
  constructor(
    private readonly browser_session: BrowserSession,
    private readonly pageRef: any | null = null
  ) {}

  private async _page() {
    if (this.pageRef) {
      return this.pageRef;
    }
    return this.browser_session.get_current_page();
  }

  /** Hold modifier keys for the duration of an action. */
  private async _withModifiers<T>(
    page: any,
    modifiers: KeyboardModifier[] | null | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    const keys = normalizeKeyboardModifiers(modifiers);
    const pressed: KeyboardModifier[] = [];
    try {
      for (const key of keys) {
        await page.keyboard.down(key);
        pressed.push(key);
      }
      return await action();
    } finally {
      for (const key of pressed.reverse()) {
        await page.keyboard.up(key).catch(() => undefined);
      }
    }
  }

  /**
   * Click at viewport coordinates. `click_count` emits complete press/release
   * sequences (2 for a double click), and `modifiers` are held throughout.
   */
  async click(x: number, y: number, options: MouseButtonOptions = {}) {
    const clickCount = requirePositiveInteger(
      options.click_count ?? 1,
      'click_count'
    );
    const modifiers = normalizeKeyboardModifiers(options.modifiers);
    await this.browser_session.click_coordinates(x, y, {
      button: options.button ?? 'left',
      ...(clickCount !== 1 ? { click_count: clickCount } : {}),
      ...(modifiers.length ? { modifiers } : {}),
    });
  }

  /** Move in linear steps; held buttons stay pressed, so this drags. */
  async move(
    x: number,
    y: number,
    options: { steps?: number; modifiers?: KeyboardModifier[] | null } = {}
  ) {
    const steps = requirePositiveInteger(options.steps ?? 1, 'steps');
    const page = await this._page();
    if (!page?.mouse?.move) {
      return;
    }
    await this.browser_session.validate_page_after_action(page);
    try {
      await this._withModifiers(page, options.modifiers, () =>
        steps > 1 ? page.mouse.move(x, y, { steps }) : page.mouse.move(x, y)
      );
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async down(options: MouseButtonOptions = {}) {
    const clickCount = requirePositiveInteger(
      options.click_count ?? 1,
      'click_count'
    );
    const page = await this._page();
    if (!page?.mouse?.down) {
      return;
    }
    await this.browser_session.validate_page_after_action(page);
    try {
      await this._withModifiers(page, options.modifiers, () =>
        page.mouse.down({
          button: options.button ?? 'left',
          ...(clickCount !== 1 ? { clickCount } : {}),
        })
      );
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async up(options: MouseButtonOptions = {}) {
    const clickCount = requirePositiveInteger(
      options.click_count ?? 1,
      'click_count'
    );
    const page = await this._page();
    if (!page?.mouse?.up) {
      return;
    }
    await this.browser_session.validate_page_after_action(page);
    try {
      await this._withModifiers(page, options.modifiers, () =>
        page.mouse.up({
          button: options.button ?? 'left',
          ...(clickCount !== 1 ? { clickCount } : {}),
        })
      );
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  /**
   * Scroll with the mouse wheel at (x, y), defaulting to the viewport center.
   * Positive deltas scroll down/right. Falls back to `window.scrollBy`.
   */
  async scroll(
    x: number | null = null,
    y: number | null = null,
    delta_x: number | null = null,
    delta_y: number | null = null
  ) {
    const page = await this._page();
    if (!page) {
      throw new Error('No active page available');
    }
    await this.browser_session.validate_page_after_action(page);
    try {
      let viewport: { width: number; height: number } | null =
        page.viewportSize?.() ?? null;
      if (!viewport && page.evaluate) {
        viewport = await page
          .evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          }))
          .catch(() => null);
      }
      const [anchorX, anchorY] = resolveScrollAnchor(
        x,
        y,
        viewport?.width ?? 0,
        viewport?.height ?? 0
      );
      const deltaX = delta_x ?? 0;
      const deltaY = delta_y ?? 0;
      try {
        await page.mouse.move(anchorX, anchorY);
        await page.mouse.wheel(deltaX, deltaY);
      } catch {
        await page.evaluate(
          ([dx, dy]: [number, number]) => window.scrollBy(dx, dy),
          [deltaX, deltaY]
        );
      }
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }
}
