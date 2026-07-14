import { describe, expect, it } from 'vitest';
import {
  assertStorageStatePayloadLimits,
  MAX_STORAGE_STATE_FILE_BYTES,
  MAX_STORAGE_STATE_COOKIES,
  MAX_STORAGE_STATE_ENTRIES,
  MAX_STORAGE_STATE_ORIGINS,
  serializeBoundedStorageState,
} from '../src/browser/storage-state-limits.js';

describe('storage state limits', () => {
  it('rejects non-object storage state payloads', () => {
    expect(() => assertStorageStatePayloadLimits([])).toThrow(
      'must contain a JSON object'
    );
  });

  it('rejects excessive cookies, origins, and storage entries', () => {
    expect(() =>
      assertStorageStatePayloadLimits({
        cookies: Array(MAX_STORAGE_STATE_COOKIES + 1).fill({}),
      })
    ).toThrow(`exceeds ${MAX_STORAGE_STATE_COOKIES} cookies`);

    expect(() =>
      assertStorageStatePayloadLimits({
        origins: Array(MAX_STORAGE_STATE_ORIGINS + 1).fill({}),
      })
    ).toThrow(`exceeds ${MAX_STORAGE_STATE_ORIGINS} origins`);

    expect(() =>
      assertStorageStatePayloadLimits({
        origins: [
          {
            localStorage: Array(MAX_STORAGE_STATE_ENTRIES + 1).fill({}),
          },
        ],
      })
    ).toThrow(`exceeds ${MAX_STORAGE_STATE_ENTRIES} storage entries`);
  });

  it('rejects serialized state that exceeds the file byte limit', () => {
    expect(() =>
      serializeBoundedStorageState({
        cookies: [
          {
            name: 'large',
            value: 'x'.repeat(MAX_STORAGE_STATE_FILE_BYTES),
          },
        ],
        origins: [],
      })
    ).toThrow(`exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`);
  });
});
