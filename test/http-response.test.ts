import { describe, expect, it, vi } from 'vitest';
import {
  HttpResponseTooLargeError,
  readBoundedResponseJson,
  readBoundedResponseText,
} from '../src/http-response.js';

describe('bounded HTTP responses', () => {
  it('stops a streamed response once it exceeds the byte budget', async () => {
    await expect(
      readBoundedResponseText(new Response('x'.repeat(100)), 10)
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  it('rejects an oversized declared body before reading it', async () => {
    const text = vi.fn(async () => 'never read');
    await expect(
      readBoundedResponseText(
        {
          headers: { get: () => '1000' },
          text,
        },
        10
      )
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
    expect(text).not.toHaveBeenCalled();
  });

  it('bounds JSON-only compatibility adapters', async () => {
    await expect(
      readBoundedResponseJson(
        { json: async () => ({ value: 'x'.repeat(100) }) },
        10
      )
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });
});
