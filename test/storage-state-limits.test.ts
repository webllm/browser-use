import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertStorageStatePayloadLimits,
  MAX_STORAGE_STATE_FILE_BYTES,
  MAX_STORAGE_STATE_COOKIES,
  MAX_STORAGE_STATE_ENTRIES,
  MAX_STORAGE_STATE_ORIGINS,
  serializeBoundedStorageState,
  writeBoundedStorageStateFile,
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

  it('keeps the current state readable when the atomic replacement fails', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-storage-state-')
    );
    const statePath = path.join(tempDir, 'state.json');
    const originalState = JSON.stringify({ cookies: [], origins: [] });
    const nextState = JSON.stringify({
      cookies: [{ name: 'sid', value: 'next' }],
      origins: [],
    });
    fs.writeFileSync(statePath, originalState);
    const originalRename = fs.renameSync.bind(fs);
    const renameSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        if (destination === statePath) {
          throw new Error('simulated replacement failure');
        }
        return originalRename(source, destination);
      });

    try {
      expect(() => writeBoundedStorageStateFile(statePath, nextState)).toThrow(
        'simulated replacement failure'
      );
      expect(fs.readFileSync(statePath, 'utf8')).toBe(originalState);
      expect(fs.readFileSync(`${statePath}.bak`, 'utf8')).toBe(originalState);
      expect(fs.readdirSync(tempDir).sort()).toEqual([
        'state.json',
        'state.json.bak',
      ]);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
