import { describe, expect, it } from 'vitest';
import {
  has_url_negation,
  is_placeholder_url,
  sanitize_url_candidate,
} from '../src/utils.js';

describe('URL candidate helpers', () => {
  it('keeps closing brackets the URL opened itself', () => {
    expect(
      sanitize_url_candidate(
        'https://en.wikipedia.org/wiki/Python_(programming_language).'
      )
    ).toBe('https://en.wikipedia.org/wiki/Python_(programming_language)');
    expect(sanitize_url_candidate('https://example.com/a[1]')).toBe(
      'https://example.com/a[1]'
    );
  });

  it('strips prose punctuation and unmatched closing brackets', () => {
    expect(sanitize_url_candidate('https://x.com/a)')).toBe('https://x.com/a');
    expect(sanitize_url_candidate('https://x.com/a),')).toBe('https://x.com/a');
    expect(sanitize_url_candidate('https://x.com/a?!.')).toBe(
      'https://x.com/a'
    );
    expect(sanitize_url_candidate('https://x.com/(a')).toBe('https://x.com/(a');
  });

  it('cuts escaped newlines that belong to the surrounding prose', () => {
    expect(
      sanitize_url_candidate('https://example.com/search.\\n2. Next')
    ).toBe('https://example.com/search');
    expect(sanitize_url_candidate('https://example.com\\tmore')).toBe(
      'https://example.com'
    );
  });

  it('stays linear for long runs of closing brackets', () => {
    const candidate = `https://example.com/${')'.repeat(100_000)}`;
    expect(sanitize_url_candidate(candidate)).toBe('https://example.com/');
  });

  it('recognizes placeholder hosts', () => {
    expect(is_placeholder_url('https://XXX.XX')).toBe(true);
    expect(is_placeholder_url('www.xxxx.xxx/path')).toBe(true);
    expect(is_placeholder_url('https://xx')).toBe(false);
    expect(is_placeholder_url('https://example.com')).toBe(false);
    expect(is_placeholder_url('not a url')).toBe(false);
  });

  it('matches negation words only as whole words', () => {
    expect(has_url_negation('Never go to ')).toBe(true);
    expect(has_url_negation('please do not open ')).toBe(true);
    expect(has_url_negation("Don't visit ")).toBe(true);
    expect(has_url_negation('Don\u2019t visit ')).toBe(true);
    expect(has_url_negation('dont visit ')).toBe(true);
    expect(has_url_negation('Find another page on ')).toBe(false);
    expect(has_url_negation('Open notion and ')).toBe(false);
  });
});
