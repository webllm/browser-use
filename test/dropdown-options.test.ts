import { describe, expect, it } from 'vitest';
import {
  formatDropdownOptions,
  MAX_DROPDOWN_MESSAGE_CHARS,
  MAX_DROPDOWN_OPTIONS,
  MAX_DROPDOWN_PAYLOAD_CHARS,
  normalizeDropdownOptions,
  serializeDropdownOptions,
} from '../src/browser/dropdown-options.js';

describe('dropdown option safety limits', () => {
  it('bounds option counts, field content, and rendered output', () => {
    const raw = Array.from({ length: 1_000 }, (_, index) => ({
      index,
      text: `text-${index}-${'x'.repeat(10_000)}`,
      value: `value-${index}-${'\u0000'.repeat(10_000)}`,
    }));

    const normalized = normalizeDropdownOptions(raw);
    const contentChars = normalized.options.reduce(
      (total, option) => total + option.text.length + option.value.length,
      0
    );
    const formatted = formatDropdownOptions(
      normalized.options,
      normalized.truncated
    );
    const serialized = serializeDropdownOptions(normalized.options);

    expect(normalized.options.length).toBeLessThanOrEqual(MAX_DROPDOWN_OPTIONS);
    expect(contentChars).toBeLessThanOrEqual(MAX_DROPDOWN_PAYLOAD_CHARS);
    expect(normalized.truncated).toBe(true);
    expect(formatted.text.length).toBeLessThanOrEqual(
      MAX_DROPDOWN_MESSAGE_CHARS
    );
    expect(formatted.text).toContain('truncated for safety');
    expect(serialized.json.length).toBeLessThanOrEqual(
      MAX_DROPDOWN_MESSAGE_CHARS
    );
    expect(() => JSON.parse(serialized.json)).not.toThrow();
  });
});
