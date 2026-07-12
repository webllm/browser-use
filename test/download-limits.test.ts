import { afterEach, describe, expect, it } from 'vitest';
import {
  getMaxAutoDownloadBytes,
  MAX_AUTO_DOWNLOAD_SIZE_ENV,
  MAX_CONFIGURED_AUTO_DOWNLOAD_BYTES,
} from '../src/browser/download-limits.js';

describe('automatic download size limits', () => {
  const previous = process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV];
    else process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV] = previous;
  });

  it('caps unsafe or excessive configured limits', () => {
    process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV] = '1e300';
    expect(getMaxAutoDownloadBytes()).toBe(MAX_CONFIGURED_AUTO_DOWNLOAD_BYTES);

    process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV] = '4096';
    expect(getMaxAutoDownloadBytes()).toBe(MAX_CONFIGURED_AUTO_DOWNLOAD_BYTES);
  });
});
