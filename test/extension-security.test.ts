import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  ExtensionArchiveBudget,
  MAX_EXTENSION_DOWNLOAD_BYTES,
  MAX_EXTENSION_ENTRY_BYTES,
  MAX_EXTENSION_MANIFEST_BYTES,
  MAX_EXTENSION_UNCOMPRESSED_BYTES,
  assertExtensionContentLength,
  extractExtensionArchive,
  readExtensionManifest,
  writeLimitedExtensionStream,
} from '../src/browser/extension-security.js';

describe('extension download and extraction safety', () => {
  it('rejects declared and streamed downloads above the byte limit', async () => {
    expect(() =>
      assertExtensionContentLength(String(MAX_EXTENSION_DOWNLOAD_BYTES + 1))
    ).toThrow(/exceeds/);

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-limit-')
    );
    const outputPath = path.join(tempDir, 'extension.crx');
    try {
      await expect(
        writeLimitedExtensionStream(
          Readable.from([Buffer.alloc(9)]),
          outputPath,
          8
        )
      ).rejects.toThrow(/exceeds 8 bytes/);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(fs.readdirSync(tempDir)).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe paths, symlinks, and oversized expanded archives', () => {
    expect(() =>
      new ExtensionArchiveBudget().addEntry({
        fileName: '../escape',
        compressedSize: 1,
        uncompressedSize: 1,
      })
    ).toThrow(/Unsafe extension archive path/);

    expect(() =>
      new ExtensionArchiveBudget().addEntry({
        fileName: 'link',
        compressedSize: 1,
        uncompressedSize: 1,
        externalFileAttributes: 0o120777 << 16,
      })
    ).toThrow(/symlinks/);

    const budget = new ExtensionArchiveBudget();
    budget.addEntry({
      fileName: 'first.bin',
      compressedSize: 1,
      uncompressedSize: MAX_EXTENSION_ENTRY_BYTES,
    });
    budget.addEntry({
      fileName: 'second.bin',
      compressedSize: 1,
      uncompressedSize: MAX_EXTENSION_ENTRY_BYTES,
    });
    expect(() =>
      budget.addEntry({
        fileName: 'third.bin',
        compressedSize: 1,
        uncompressedSize:
          MAX_EXTENSION_UNCOMPRESSED_BYTES - 2 * MAX_EXTENSION_ENTRY_BYTES + 1,
      })
    ).toThrow(/expands beyond/);
  });

  it('rejects oversized and non-object extension manifests', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-manifest-')
    );
    const manifestPath = path.join(tempDir, 'manifest.json');
    try {
      fs.writeFileSync(manifestPath, '{}');
      fs.truncateSync(manifestPath, MAX_EXTENSION_MANIFEST_BYTES + 1);
      expect(() => readExtensionManifest(manifestPath)).toThrow(/too large/);

      fs.writeFileSync(manifestPath, '[]');
      expect(() => readExtensionManifest(manifestPath)).toThrow(/JSON object/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts a bounded CRX3 payload after validating its header', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-crx3-')
    );
    const archivePath = path.join(tempDir, 'extension.crx');
    const extractDir = path.join(tempDir, 'unpacked');
    const existingDir = path.join(tempDir, 'existing-destination');
    try {
      const zip = new AdmZip();
      zip.addFile(
        'manifest.json',
        Buffer.from(
          JSON.stringify({
            manifest_version: 3,
            name: 'Bounded extension',
            version: '1.0.0',
          })
        )
      );
      const crxHeader = Buffer.alloc(12);
      crxHeader.write('Cr24', 0, 'ascii');
      crxHeader.writeUInt32LE(3, 4);
      crxHeader.writeUInt32LE(0, 8);
      fs.writeFileSync(archivePath, Buffer.concat([crxHeader, zip.toBuffer()]));

      fs.mkdirSync(existingDir);
      fs.writeFileSync(path.join(existingDir, 'keep.txt'), 'preserve me');
      await expect(
        extractExtensionArchive(archivePath, existingDir)
      ).rejects.toThrow(/destination already exists/);
      expect(fs.readFileSync(path.join(existingDir, 'keep.txt'), 'utf-8')).toBe(
        'preserve me'
      );

      await extractExtensionArchive(archivePath, extractDir);

      expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(true);
      expect(
        fs.readdirSync(tempDir).some((name) => name.endsWith('.zip'))
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
