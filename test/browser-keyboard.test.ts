import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseKeyChord, pressKeySequence } from '../src/browser/keyboard.js';

describe('parseKeyChord', () => {
  it.each([
    ['Control+a', 'Control+a'],
    ['ctrl+a', 'Control+a'],
    ['cmd+shift+t', 'Meta+Shift+t'],
    ['Control++', 'Control++'],
    ['ctrl+enter', 'Control+Enter'],
  ])('parses %s as a chord', (keys, chord) => {
    expect(parseKeyChord(keys)).toBe(chord);
  });

  it.each(['+', '1+1', 'C++', 'a+b', 'Enter', 'hello', 'Control+', '+a'])(
    'treats %s as a non-chord',
    (keys) => {
      expect(parseKeyChord(keys)).toBeNull();
    }
  );
});

describe('pressKeySequence', () => {
  it('presses literal plus text one character at a time', async () => {
    const keyboard = { press: vi.fn(async (_key: string) => {}) };

    await pressKeySequence(keyboard, '1+1');

    expect(keyboard.press.mock.calls.map(([key]) => key)).toEqual([
      '1',
      '+',
      '1',
    ]);
  });

  it('normalizes single key aliases', async () => {
    const keyboard = { press: vi.fn(async (_key: string) => {}) };

    await pressKeySequence(keyboard, 'esc');

    expect(keyboard.press).toHaveBeenCalledWith('Escape');
  });

  describe('in a real browser', () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
    });

    afterAll(async () => {
      await browser?.close();
    });

    it('types literal plus signs and applies lowercase modifier chords', async () => {
      await page.setContent('<input id="field" />');
      await page.focus('#field');

      await pressKeySequence(page.keyboard, '1+1');
      await pressKeySequence(page.keyboard, 'C++');
      expect(await page.inputValue('#field')).toBe('1+1C++');

      // A lowercase modifier alias is pressed as a chord, not typed out.
      await pressKeySequence(page.keyboard, 'shift+a');
      expect(await page.inputValue('#field')).toBe('1+1C++a');
    });
  });
});
