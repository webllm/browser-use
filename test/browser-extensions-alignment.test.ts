import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { loadOrInstallExtension } from '../src/browser/extensions.js';
import { MAX_EXTENSION_MANIFEST_BYTES } from '../src/browser/extension-security.js';

const modeOf = (targetPath: string) => fs.statSync(targetPath).mode & 0o777;

describe('Browser extension cache alignment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads CRX files into private extension cache paths', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-cache-')
    );
    const extensionsDir = path.join(tempDir, 'extensions');
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const extensionName = 'Test Extension';
    const crxPath = path.join(
      extensionsDir,
      `${extensionId}__${extensionName}.crx`
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-a-zip', { status: 200 }))
    );

    try {
      await loadOrInstallExtension(
        { name: extensionName, webstore_id: extensionId },
        extensionsDir
      );

      expect(fs.existsSync(crxPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(modeOf(extensionsDir)).toBe(0o700);
        expect(modeOf(crxPath)).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('unpacks existing CRX files into private extension directories', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-unpack-')
    );
    const extensionsDir = path.join(tempDir, 'extensions');
    const crxPath = path.join(tempDir, 'extension.crx');
    const unpackedPath = path.join(extensionsDir, 'unpacked-extension');

    try {
      const zip = new AdmZip();
      zip.addFile(
        'manifest.json',
        Buffer.from(
          JSON.stringify({
            manifest_version: 3,
            name: 'Existing Extension',
            version: '1.0.0',
          })
        )
      );
      zip.writeZip(crxPath);

      const extension = await loadOrInstallExtension(
        {
          name: 'Existing Extension',
          webstore_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          crx_path: crxPath,
          unpacked_path: unpackedPath,
        },
        extensionsDir
      );

      expect(extension.version).toBe('1.0.0');
      expect(fs.existsSync(path.join(unpackedPath, 'manifest.json'))).toBe(
        true
      );
      if (process.platform !== 'win32') {
        expect(modeOf(unpackedPath)).toBe(0o700);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized manifests in user-provided unpacked extensions', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-unpacked-')
    );
    const unpackedPath = path.join(tempDir, 'unpacked');
    fs.mkdirSync(unpackedPath);
    const manifestPath = path.join(unpackedPath, 'manifest.json');
    fs.writeFileSync(manifestPath, '{}');
    fs.truncateSync(manifestPath, MAX_EXTENSION_MANIFEST_BYTES + 1);

    try {
      await expect(
        loadOrInstallExtension({
          name: 'Oversized Extension',
          unpacked_path: unpackedPath,
        })
      ).rejects.toThrow(/too large/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
