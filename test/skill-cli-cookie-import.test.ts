import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertBoundedCookieImportFile,
  MAX_CLI_COOKIE_IMPORT_BYTES,
  MAX_CLI_COOKIE_IMPORT_ENTRIES,
  parseBoundedCookieImport,
  readBoundedCookieImportFile,
} from '../src/skill-cli/cookie-import.js';

describe('skill CLI cookie imports', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('reads a bounded regular cookie file', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-cookies-')
    );
    const filePath = path.join(tempDir, 'cookies.json');
    try {
      fs.writeFileSync(filePath, '[{"name":"session","value":"ok"}]');

      await expect(readBoundedCookieImportFile(filePath)).resolves.toContain(
        'session'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not follow a replacement symlink while opening the file', async () => {
    if (process.platform === 'win32') return;
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-cookies-')
    );
    const filePath = path.join(tempDir, 'cookies.json');
    const replacementPath = path.join(tempDir, 'replacement.json');
    try {
      fs.writeFileSync(filePath, '[]');
      fs.writeFileSync(replacementPath, '[{"name":"secret","value":"x"}]');
      const originalOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
        fs.rmSync(filePath);
        fs.symlinkSync(replacementPath, filePath);
        return originalOpen(...args);
      });

      await expect(readBoundedCookieImportFile(filePath)).rejects.toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
