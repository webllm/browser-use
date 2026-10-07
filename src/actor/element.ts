import type { Locator } from 'playwright';
import type { BrowserSession } from '../browser/session.js';
import type { DOMElementNode } from '../dom/views.js';

export interface Position {
  x: number;
  y: number;
}

const isPosition = (value: unknown): value is Position =>
  Boolean(value) &&
  typeof (value as Position).x === 'number' &&
  typeof (value as Position).y === 'number';

export class Element {
  constructor(
    private readonly browser_session: BrowserSession,
    readonly node: DOMElementNode
  ) {}

  /** Run an action against this element's locator between page checks. */
  private async _withLocator<T>(
    action: (locator: Locator) => Promise<T>
  ): Promise<T> {
    const locator = await this.browser_session.get_locate_element(this.node);
    if (!locator) {
      throw new Error('Element is not available on the current page');
    }
    const page = await this.browser_session.get_current_page();
    await this.browser_session.validate_page_after_action(page);
    try {
      return await action(locator);
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  private async _center(): Promise<Position> {
    const box = await this.get_bounding_box();
    if (!box) {
      throw new Error('Element is not visible or has no bounding box');
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async click() {
    return this.browser_session._click_element_node(this.node);
  }

  async fill(value: string, clear = true) {
    return this.browser_session._input_text_element_node(this.node, value, {
      clear,
    });
  }

  async hover() {
    const locator = await this.browser_session.get_locate_element(this.node);
    if (!locator?.hover) {
      return;
    }
    const page = await this.browser_session.get_current_page();
    await this.browser_session.validate_page_after_action(page);
    try {
      await locator.hover({ timeout: 5000 });
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async get_attribute(name: string) {
    return this.node.attributes?.[name] ?? null;
  }

  async get_bounding_box() {
    const locator = await this.browser_session.get_locate_element(this.node);
    if (!locator?.boundingBox) {
      return null;
    }
    const page = await this.browser_session.get_current_page();
    await this.browser_session.validate_page_after_action(page);
    try {
      return await locator.boundingBox();
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  /** Scroll the element into the viewport if it is not already visible. */
  async scroll_into_view() {
    await this._withLocator((locator) =>
      locator.scrollIntoViewIfNeeded({ timeout: 5000 })
    );
  }

  /**
   * Set a file input to paths on the browser host; an empty list clears it.
   * Remote browsers receive the files from this host.
   */
  async set_input_files(paths: string[]) {
    await this._withLocator((locator) =>
      locator.setInputFiles(paths, { timeout: 10_000 })
    );
  }

  async focus() {
    await this._withLocator((locator) => locator.focus({ timeout: 5000 }));
  }

  /** Ensure a checkbox or radio button is checked without toggling it off. */
  async check() {
    const isChecked = () =>
      this._withLocator((locator) =>
        locator.evaluate((element) => {
          const input = element as HTMLInputElement;
          if (
            input.tagName !== 'INPUT' ||
            !['checkbox', 'radio'].includes(input.type)
          ) {
            throw new Error('Element is not a checkbox or radio button');
          }
          return input.checked;
        })
      );
    if (await isChecked()) {
      return;
    }
    await this.click();
    if (!(await isChecked())) {
      throw new Error('Checkbox or radio button did not become checked');
    }
  }

  /**
   * Select options by visible label or value (case-insensitive), including
   * options inside optgroups. Native multi-selects take every value at once;
   * an empty list clears them.
   */
  async select_option(values: string | string[]) {
    const list = Array.isArray(values) ? values : [values];
    const isSelect = this.node.tag_name?.toLowerCase() === 'select';
    const isMultiple = Object.prototype.hasOwnProperty.call(
      this.node.attributes ?? {},
      'multiple'
    );
    if (isSelect && (isMultiple || list.length === 0)) {
      // The dropdown action selects one option; a native multi-select needs
      // every selected flag updated before the page is notified.
      await this._withLocator((locator) =>
        locator.evaluate((element, wanted) => {
          const select = element as HTMLSelectElement;
          if (select.disabled) throw new Error('Select element is disabled');
          const options = Array.from(select.options);
          const selected = wanted.map((value) => {
            const match = options.find(
              (option) =>
                option.value.toLowerCase() === value.toLowerCase() ||
                option.text.trim().toLowerCase() === value.toLowerCase()
            );
            if (!match) throw new Error(`Option not found: ${value}`);
            if (
              match.disabled ||
              (match.parentElement as HTMLOptGroupElement | null)?.disabled
            ) {
              throw new Error(`Option is disabled: ${value}`);
            }
            return match;
          });
          select.focus();
          for (const option of options) {
            option.selected = selected.includes(option);
          }
          if (!selected.length) select.selectedIndex = -1;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.blur();
          if (
            options.some(
              (option) => option.selected !== selected.includes(option)
            )
          ) {
            throw new Error('Selection was reverted by the page');
          }
        }, list)
      );
      return;
    }
    if (list.length !== 1) {
      throw new Error('This dropdown requires exactly one option');
    }
    let expectedValue: string | null = null;
    if (isSelect) {
      expectedValue = await this._withLocator((locator) =>
        locator.evaluate((element, value) => {
          const select = element as HTMLSelectElement;
          if (select.disabled) throw new Error('Select element is disabled');
          const match = Array.from(select.options).find(
            (option) =>
              option.value.toLowerCase() === value.toLowerCase() ||
              option.text.trim().toLowerCase() === value.toLowerCase()
          );
          if (!match) throw new Error(`Option not found: ${value}`);
          if (
            match.disabled ||
            (match.parentElement as HTMLOptGroupElement | null)?.disabled
          ) {
            throw new Error(`Option is disabled: ${value}`);
          }
          return match.value;
        }, list[0]!)
      );
    }
    await this.browser_session.select_dropdown_option(this.node, list[0]!);
    if (expectedValue !== null) {
      const actual = await this._withLocator((locator) =>
        locator.evaluate((element) => (element as HTMLSelectElement).value)
      );
      if (actual !== expectedValue) {
        throw new Error('Selection was reverted by the page');
      }
    }
  }

  /**
   * Drag this element (or `source_position`) to another element's center, a
   * point inside it (`target_position`, relative to its box), or a viewport
   * position.
   */
  async drag_to(
    target: Element | Position,
    options: {
      source_position?: Position | null;
      target_position?: Position | null;
    } = {}
  ) {
    const source = options.source_position ?? (await this._center());
    let destination: Position;
    if (isPosition(target)) {
      destination = target;
    } else if (options.target_position) {
      const box = await target.get_bounding_box();
      if (!box) {
        throw new Error('Target element is not visible');
      }
      destination = {
        x: box.x + options.target_position.x,
        y: box.y + options.target_position.y,
      };
    } else {
      destination = await target._center();
    }
    const page = await this.browser_session.get_current_page();
    if (!page?.mouse) {
      throw new Error('No active page available');
    }
    await this.browser_session.validate_page_after_action(page);
    try {
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      try {
        await page.mouse.move(destination.x, destination.y, { steps: 10 });
      } finally {
        await page.mouse.up();
      }
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }

  async evaluate(page_function: string, ...args: unknown[]) {
    const locator = await this.browser_session.get_locate_element(this.node);
    if (!locator?.evaluate) {
      throw new Error('Element evaluate is unavailable for this node');
    }
    const page = await this.browser_session.get_current_page();
    await this.browser_session.validate_page_after_action(page);
    try {
      return await (locator as any).evaluate(page_function, ...args);
    } finally {
      await this.browser_session.validate_page_after_action(page);
    }
  }
}
