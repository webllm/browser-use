import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  decodeBoundedScreenshotBase64,
  readBoundedScreenshotFileSync,
} from './file.js';

const chmodPrivatePath = (targetPath: string, mode: number) => {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    /* best effort */
  }
};

const createPrivateDirectory = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  chmodPrivatePath(dirPath, 0o700);
};

const chmodPrivateFile = async (filePath: string) => {
  if (process.platform !== 'win32') {
    await fs.promises.chmod(filePath, 0o600);
  }
};

export class ScreenshotService {
  private screenshotsDir: string;

  constructor(agentDirectory: string) {
    this.screenshotsDir = path.join(agentDirectory, 'screenshots');
    createPrivateDirectory(this.screenshotsDir);
  }

  async store_screenshot(screenshot_b64: string, step_number: number) {
    if (!Number.isSafeInteger(step_number) || step_number < 0) {
      throw new RangeError(
        'Screenshot step number must be a non-negative integer'
      );
    }
    const screenshot = decodeBoundedScreenshotBase64(screenshot_b64);
    const filename = `step_${step_number}.png`;
    const filepath = path.join(this.screenshotsDir, filename);
    const temporaryPath = path.join(
      this.screenshotsDir,
      `.${filename}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      await fs.promises.writeFile(temporaryPath, screenshot.data, {
        flag: 'wx',
        mode: 0o600,
      });
      await chmodPrivateFile(temporaryPath);
      await fs.promises.rename(temporaryPath, filepath);
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
    return filepath;
  }

  async get_screenshot(screenshot_path: string) {
    if (!screenshot_path) {
      return null;
    }
    return (
      readBoundedScreenshotFileSync(screenshot_path)?.data.toString('base64') ??
      null
    );
  }
}
