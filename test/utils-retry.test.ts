import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RETRY_ASYNC_ATTEMPTS,
  MAX_RETRY_ASYNC_DELAY_MS,
  retryAsync,
} from '../src/utils.js';

describe('bounded retryAsync scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['zero attempts', { maxAttempts: 0 }],
    ['fractional attempts', { maxAttempts: 1.5 }],
    ['excessive attempts', { maxAttempts: MAX_RETRY_ASYNC_ATTEMPTS + 1 }],
    ['negative delay', { delayMs: -1 }],
    ['non-finite delay', { delayMs: Number.POSITIVE_INFINITY }],
    ['excessive delay', { delayMs: MAX_RETRY_ASYNC_DELAY_MS + 1 }],
    ['non-finite multiplier', { backoffMultiplier: Number.NaN }],
    ['negative maximum delay', { maxDelayMs: -1 }],
  ])('rejects %s before invoking the operation', async (_label, options) => {
    const operation = vi.fn(async () => 'unused');

    await expect(retryAsync(operation, options)).rejects.toBeInstanceOf(
      RangeError
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('caps exponential overflow before scheduling the next retry', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('ok');
    const delays: number[] = [];

    const result = retryAsync(operation, {
      maxAttempts: 3,
      delayMs: MAX_RETRY_ASYNC_DELAY_MS,
      backoffMultiplier: Number.MAX_VALUE,
      maxDelayMs: 5,
      onRetry: (_error, _attempt, delay) => delays.push(delay),
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(delays).toEqual([5, 5]);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
