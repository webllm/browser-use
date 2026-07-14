import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBoundedCookieImportFile,
  MAX_CLI_COOKIE_IMPORT_BYTES,
  MAX_CLI_COOKIE_IMPORT_ENTRIES,
  parseBoundedCookieImport,
} from '../src/skill-cli/cookie-import.js';

describe('skill CLI cookie imports', () => {
  it('rejects oversized files before reading their contents', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-cookies-')
    );
    const filePath = path.join(tempDir, 'oversized.json');
    try {
      fs.writeFileSync(filePath, '[]');
      fs.truncateSync(filePath, MAX_CLI_COOKIE_IMPORT_BYTES + 1);

      expect(() =>
        assertBoundedCookieImportFile(fs.statSync(filePath), filePath)
      ).toThrow(`exceeds ${MAX_CLI_COOKIE_IMPORT_BYTES} bytes`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects non-files and excessive cookie counts', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-cookies-')
    );
    try {
      expect(() =>
        assertBoundedCookieImportFile(fs.statSync(tempDir), tempDir)
      ).toThrow('not a regular file');
      expect(() =>
        parseBoundedCookieImport(
          JSON.stringify(Array(MAX_CLI_COOKIE_IMPORT_ENTRIES + 1).fill(null))
        )
      ).toThrow(`exceeds ${MAX_CLI_COOKIE_IMPORT_ENTRIES} entries`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
