import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScreenshotService } from '../src/screenshots/service.js';

describe('ScreenshotService file permissions', () => {
  it('stores screenshots in a private directory as private files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-ssvc-'));
    try {
      const service = new ScreenshotService(tempDir);
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('test-payload'),
      ]);
      const screenshotPath = await service.store_screenshot(
        png.toString('base64'),
        3
      );

      expect(fs.existsSync(screenshotPath)).toBe(true);
      expect(await service.get_screenshot(screenshotPath)).toBe(
        png.toString('base64')
      );
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.dirname(screenshotPath)).mode & 0o777).toBe(
          0o700
        );
        expect(fs.statSync(screenshotPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid screenshot payloads and step numbers', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-ssvc-'));
    try {
      const service = new ScreenshotService(tempDir);

      await expect(service.store_screenshot('bm90LWEtcG5n', 1)).rejects.toThrow(
        'Screenshot exceeds or violates'
      );
      await expect(
        service.store_screenshot(
          Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]).toString('base64'),
          '../../outside' as any
        )
      ).rejects.toThrow('Screenshot step number must be');
      expect(fs.existsSync(path.join(tempDir, 'outside.png'))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'replaces screenshot symlinks without writing through them',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-ssvc-')
      );
      try {
        const service = new ScreenshotService(tempDir);
        const outsidePath = path.join(tempDir, 'outside.txt');
        fs.writeFileSync(outsidePath, 'keep-me');
        const screenshotPath = path.join(tempDir, 'screenshots', 'step_3.png');
        fs.symlinkSync(outsidePath, screenshotPath);
        const png = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);

        await service.store_screenshot(png.toString('base64'), 3);

        expect(fs.readFileSync(outsidePath, 'utf8')).toBe('keep-me');
        expect(fs.lstatSync(screenshotPath).isSymbolicLink()).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );
});
