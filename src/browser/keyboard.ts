/**
 * Normalize send_keys input before it reaches Playwright's keyboard.
 *
 * Playwright treats every `+` as a chord separator, so literal text such as
 * `1+1` would otherwise press `1` twice, and lowercase aliases such as
 * `ctrl+a` would be rejected as unknown keys and typed out character by
 * character.
 */

const KEY_ALIASES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  shift: 'Shift',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  delete: 'Delete',
  backspace: 'Backspace',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

const MODIFIER_KEYS = new Set([
  'Alt',
  'Control',
  'ControlOrMeta',
  'Meta',
  'Shift',
]);

const normalizeKeyName = (key: string) =>
  KEY_ALIASES[key.trim().toLowerCase()] ?? key.trim();

const normalizeModifiers = (prefix: string): string[] | null => {
  const parts = prefix.split('+');
  if (parts.some((part) => !part.trim())) {
    return null;
  }
  const modifiers = parts.map(normalizeKeyName);
  return modifiers.every((modifier) => MODIFIER_KEYS.has(modifier))
    ? modifiers
    : null;
};

/**
 * Return a Playwright chord such as `Control+a` or `Control++`, or null when
 * the input is not a modifier chord.
 */
export const parseKeyChord = (keys: string): string | null => {
  if (!keys.includes('+') || keys === '+') {
    return null;
  }
  if (keys.endsWith('++')) {
    const modifiers = normalizeModifiers(keys.slice(0, -2));
    return modifiers ? [...modifiers, '+'].join('+') : null;
  }
  const separator = keys.lastIndexOf('+');
  const suffix = keys.slice(separator + 1);
  if (!suffix.trim()) {
    return null;
  }
  const modifiers = normalizeModifiers(keys.slice(0, separator));
  return modifiers ? [...modifiers, normalizeKeyName(suffix)].join('+') : null;
};

export interface KeyboardLike {
  press(key: string): Promise<unknown>;
}

/**
 * Press a key, a modifier chord, or type literal text one character at a time.
 */
export const pressKeySequence = async (
  keyboard: KeyboardLike,
  keys: string
): Promise<void> => {
  const chord = parseKeyChord(keys);
  if (chord) {
    await keyboard.press(chord);
    return;
  }
  if (keys.includes('+') && keys !== '+') {
    // Not a modifier chord, so the plus signs are literal text.
    for (const char of keys) {
      await keyboard.press(char);
    }
    return;
  }
  const key = normalizeKeyName(keys) || keys;
  try {
    await keyboard.press(key);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown key')) {
      for (const char of keys) {
        await keyboard.press(char);
      }
      return;
    }
    throw error;
  }
};
