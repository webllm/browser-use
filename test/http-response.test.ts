import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  HttpResponseTooLargeError,
  readBoundedResponseJson,
  readBoundedResponseText,
  runWithHttpTimeout,
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'uses the safe default for invalid byte limit %s',
    async (invalidLimit) => {
      const text = vi.fn(async () => 'never read');
      await expect(
        readBoundedResponseText(
          {
            headers: {
              get: () => String(DEFAULT_MAX_HTTP_RESPONSE_BYTES + 1),
            },
            text,
          },
          invalidLimit
        )
      ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
      expect(text).not.toHaveBeenCalled();
    }
  );

  it('keeps the timeout active for the full response consumer', async () => {
    await expect(
      runWithHttpTimeout(
        async (signal) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
        5
      )
    ).rejects.toThrow('HTTP request timed out');
  });
});
