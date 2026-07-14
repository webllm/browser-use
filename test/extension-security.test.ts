import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import {
  ExtensionArchiveBudget,
  MAX_EXTENSION_DOWNLOAD_BYTES,
  MAX_EXTENSION_ENTRY_BYTES,
  MAX_EXTENSION_MANIFEST_BYTES,
  MAX_EXTENSION_UNCOMPRESSED_BYTES,
  assertExtensionContentLength,
  extractExtensionArchive,
  fetchExtensionResponse,
  readExtensionManifest,
  writeLimitedExtensionStream,
} from '../src/browser/extension-security.js';

describe('extension download and extraction safety', () => {
  it('follows only bounded HTTPS extension redirects', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/extension.crx' },
        })
      )
      .mockResolvedValueOnce(new Response('archive', { status: 200 }));

    await expect(
      fetchExtensionResponse('https://store.example/download', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      new URL('https://store.example/download'),
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      new URL('https://cdn.example/extension.crx'),
      expect.objectContaining({ redirect: 'manual' })
    );

    await expect(
      fetchExtensionResponse('http://store.example/download', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toThrow('must use HTTPS');

    const downgradeFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://cdn.example/extension.crx' },
        })
    );
    await expect(
      fetchExtensionResponse('https://store.example/download', {
        fetchImpl: downgradeFetch as typeof fetch,
      })
    ).rejects.toThrow('must use HTTPS');
  });

  it('limits extension download redirect chains', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: '/next' },
        })
    );

    await expect(
      fetchExtensionResponse('https://store.example/download', {
        fetchImpl: fetchImpl as typeof fetch,
        maxRedirects: 0,
      })
    ).rejects.toThrow('Too many extension download redirects');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([Number.POSITIVE_INFINITY, -1, 1.5, 6, Number.MAX_SAFE_INTEGER])(
    'rejects unsafe extension redirect limit %s',
    async (maxRedirects) => {
      const fetchImpl = vi.fn();

      await expect(
        fetchExtensionResponse('https://store.example/download', {
          fetchImpl: fetchImpl as typeof fetch,
          maxRedirects,
        })
      ).rejects.toThrow('maxRedirects must be an integer between 0 and 5');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

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

  it.each([
    Number.POSITIVE_INFINITY,
    0,
    -1,
    1.5,
    MAX_EXTENSION_DOWNLOAD_BYTES + 1,
  ])('rejects unsafe extension stream limit %s', async (maxBytes) => {
    const source = Readable.from([Buffer.alloc(1)]);

    await expect(
      writeLimitedExtensionStream(source, '/unused/extension.crx', maxBytes)
    ).rejects.toThrow(
      `maxBytes must be an integer between 1 and ${MAX_EXTENSION_DOWNLOAD_BYTES}`
    );
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

  it('rejects a manifest replaced while it is being opened', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-manifest-')
    );
    const manifestPath = path.join(tempDir, 'manifest.json');
    const replacementPath = path.join(tempDir, 'replacement.json');
    fs.writeFileSync(manifestPath, '{"version":"1"}');
    fs.writeFileSync(replacementPath, '{"version":"2"}');
    const originalOpen = fs.openSync.bind(fs);
    const openSpy = vi
      .spyOn(fs, 'openSync')
      .mockImplementationOnce((...args) => {
        fs.rmSync(manifestPath);
        fs.renameSync(replacementPath, manifestPath);
        return originalOpen(...args);
      });

    try {
      expect(() => readExtensionManifest(manifestPath)).toThrow(
        /invalid or too large/
      );
    } finally {
      openSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an archive replaced while it is being opened', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-archive-')
    );
    const archivePath = path.join(tempDir, 'extension.zip');
    const replacementPath = path.join(tempDir, 'replacement.zip');
    const extractDir = path.join(tempDir, 'unpacked');
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    zip.writeZip(archivePath);
    fs.writeFileSync(replacementPath, '{}');
    fs.truncateSync(replacementPath, MAX_EXTENSION_DOWNLOAD_BYTES + 1);
    const originalOpen = fsp.open.bind(fsp);
    const openSpy = vi
      .spyOn(fsp, 'open')
      .mockImplementation(async (...args) => {
        if (args[0] === archivePath) {
          fs.rmSync(archivePath);
          fs.renameSync(replacementPath, archivePath);
        }
        return originalOpen(...args);
      });

    try {
      await expect(
        extractExtensionArchive(archivePath, extractDir)
      ).rejects.toThrow(/changed while opening/);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow extension archive symlinks',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-extension-archive-link-')
      );
      const targetPath = path.join(tempDir, 'target.zip');
      const archivePath = path.join(tempDir, 'extension.zip');
      const extractDir = path.join(tempDir, 'unpacked');
      const zip = new AdmZip();
      zip.addFile('manifest.json', Buffer.from('{}'));
      zip.writeZip(targetPath);
      fs.symlinkSync(targetPath, archivePath);

      try {
        await expect(
          extractExtensionArchive(archivePath, extractDir)
        ).rejects.toThrow(/not a regular file/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

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
      expect(
        fs.readdirSync(tempDir).some((name) => name.endsWith('.archive'))
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
