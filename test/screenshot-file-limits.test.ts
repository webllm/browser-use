import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserStateHistory } from '../src/browser/views.js';
import {
  MAX_SCREENSHOT_FILE_BYTES,
  readBoundedScreenshotFileSync,
} from '../src/screenshots/file.js';

describe('bounded screenshot file reads', () => {
  it('rejects non-images and oversized sparse files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-shot-limit-'));
    try {
      const textPath = path.join(tempDir, 'secret.txt');
      const oversizedPath = path.join(tempDir, 'oversized.png');
      fs.writeFileSync(textPath, 'private text');
      fs.writeFileSync(
        oversizedPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      fs.truncateSync(oversizedPath, MAX_SCREENSHOT_FILE_BYTES + 1);

      expect(readBoundedScreenshotFileSync(textPath)).toBeNull();
      expect(readBoundedScreenshotFileSync(oversizedPath)).toBeNull();
      expect(
        new BrowserStateHistory('', '', [], [], textPath).get_screenshot()
      ).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'does not follow screenshot symlinks',
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-shot-link-'));
      try {
        const imagePath = path.join(tempDir, 'image.png');
        const linkPath = path.join(tempDir, 'link.png');
        fs.writeFileSync(
          imagePath,
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );
        fs.symlinkSync(imagePath, linkPath);

        expect(readBoundedScreenshotFileSync(imagePath)).not.toBeNull();
        expect(readBoundedScreenshotFileSync(linkPath)).toBeNull();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );
});
