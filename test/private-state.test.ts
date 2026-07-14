import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_PRIVATE_STATE_FILE_BYTES,
  readBoundedPrivateFile,
} from '../src/private-state.js';

describe('private state file limits', () => {
  it('reads regular files within the requested byte budget', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-private-state-'));
    const filePath = path.join(tempDir, 'state.json');
    try {
      fs.writeFileSync(filePath, '{"ok":true}', { mode: 0o600 });

      expect(readBoundedPrivateFile(filePath, 64)).toBe('{"ok":true}');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_PRIVATE_STATE_FILE_BYTES + 1,
  ])('rejects unsafe byte budget %s', (maxBytes) => {
    expect(() => readBoundedPrivateFile('/not-read', maxBytes)).toThrow(
      `maxBytes must be an integer between 1 and ${MAX_PRIVATE_STATE_FILE_BYTES}`
    );
  });
});
