import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import {
  FileSystem,
  MAX_EXTERNAL_IMAGE_BYTES,
} from '../src/filesystem/file-system.js';

describe('FileSystem external file safety limits', () => {
  it('reads only a bounded prefix of large text files', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-external-text-')
    );
    const filePath = path.join(tempDir, 'large.txt');
    fs.writeFileSync(filePath, 'x'.repeat(100_000));

    try {
      const result = await new FileSystem(tempDir, false).read_file_structured(
        filePath,
        true
      );

      expect(result.message).toContain('Truncated after 60000 characters');
      expect(result.message).toContain('safe read limit');
      expect(result.message.length).toBeLessThan(61_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized images before base64 encoding them', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-external-image-')
    );
    const filePath = path.join(tempDir, 'large.png');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, MAX_EXTERNAL_IMAGE_BYTES + 1);

    try {
      const result = await new FileSystem(tempDir, false).read_file_structured(
        filePath,
        true
      );

      expect(result.message).toContain('too large to attach safely');
      expect(result.images).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects DOCX archives with oversized expanded entries', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-external-docx-')
    );
    const filePath = path.join(tempDir, 'bomb.docx');
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.alloc(20 * 1024 * 1024 + 1, 65));
    zip.writeZip(filePath);

    try {
      const result = await new FileSystem(tempDir, false).read_file_structured(
        filePath,
        true
      );

      expect(result.message).toContain(
        'DOCX archive exceeds safe extraction limits'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow external-file symlinks',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-external-link-')
      );
      const targetPath = path.join(tempDir, 'target.txt');
      const linkPath = path.join(tempDir, 'link.txt');
      fs.writeFileSync(targetPath, 'secret');
      fs.symlinkSync(targetPath, linkPath);

      try {
        const result = await new FileSystem(
          tempDir,
          false
        ).read_file_structured(linkPath, true);
        expect(result.message).toContain('is not a regular file');
        expect(result.message).not.toContain('secret');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects external files replaced between validation and open',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-external-race-')
      );
      const filePath = path.join(tempDir, 'input.txt');
      const replacementPath = path.join(tempDir, 'replacement.txt');
      fs.writeFileSync(filePath, 'expected');
      fs.writeFileSync(replacementPath, 'replacement-secret');

      const originalOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args) => {
          if (args[0] === filePath) {
            fs.renameSync(replacementPath, filePath);
          }
          return originalOpen(...args);
        });

      try {
        const result = await new FileSystem(
          tempDir,
          false
        ).read_file_structured(filePath, true);
        expect(result.message).toContain('changed while opening');
        expect(result.message).not.toContain('replacement-secret');
      } finally {
        openSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );
});
