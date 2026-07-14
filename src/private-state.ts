import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PRIVATE_DEVICE_ID_BYTES = 255;
const PRIVATE_FILE_READ_CHUNK_BYTES = 64 * 1024;

export const ensurePrivateDirectory = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dirPath, 0o700);
    } catch {
      /* best effort */
    }
  }
};

export const readBoundedPrivateFile = (filePath: string, maxBytes: number) => {
  const pathStats = fs.lstatSync(filePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`Private state path is not a regular file: ${filePath}`);
  }
  const nonBlockingFlag =
    process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
  const noFollowFlag =
    process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | nonBlockingFlag | noFollowFlag
  );
  try {
    const stats = fs.fstatSync(descriptor);
    const currentPathStats = fs.lstatSync(filePath);
    if (
      !stats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile()
    ) {
      throw new Error(`Private state path is not a regular file: ${filePath}`);
    }
    if (
      pathStats.dev !== stats.dev ||
      pathStats.ino !== stats.ino ||
      currentPathStats.dev !== stats.dev ||
      currentPathStats.ino !== stats.ino
    ) {
      throw new Error(`Private state path changed while opening: ${filePath}`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `Private state file exceeds ${maxBytes} bytes: ${filePath}`
      );
    }
    if (process.platform !== 'win32') {
      fs.fchmodSync(descriptor, 0o600);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const remaining = maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(PRIVATE_FILE_READ_CHUNK_BYTES, remaining)
      );
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Private state file exceeds ${maxBytes} bytes: ${filePath}`
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
};

const writeCompletedPrivateTemp = (filePath: string, contents: string) => {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  let completed = false;
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    if (process.platform !== 'win32') {
      fs.fchmodSync(descriptor, 0o600);
    }
    fs.fsyncSync(descriptor);
    completed = true;
    return tempPath;
  } finally {
    fs.closeSync(descriptor);
    if (!completed) {
      fs.rmSync(tempPath, { force: true });
    }
  }
};

export const writePrivateFileAtomic = (filePath: string, contents: string) => {
  const tempPath = writeCompletedPrivateTemp(filePath, contents);
  try {
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

const writePrivateFileExclusive = (filePath: string, contents: string) => {
  const tempPath = writeCompletedPrivateTemp(filePath, contents);
  try {
    fs.linkSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

const isValidDeviceId = (value: string) =>
  Boolean(value) &&
  Buffer.byteLength(value, 'utf8') <= MAX_PRIVATE_DEVICE_ID_BYTES &&
  /^[\x21-\x7e]+$/.test(value);

export const getOrCreatePrivateDeviceId = (
  filePath: string,
  createId: () => string
) => {
  ensurePrivateDirectory(path.dirname(filePath));
  try {
    const existing = readBoundedPrivateFile(
      filePath,
      MAX_PRIVATE_DEVICE_ID_BYTES
    ).trim();
    if (isValidDeviceId(existing)) {
      return existing;
    }
  } catch {
    /* create or repair below */
  }

  const deviceId = createId();
  if (!isValidDeviceId(deviceId)) {
    throw new Error('Generated device ID is invalid');
  }
  try {
    writePrivateFileExclusive(filePath, deviceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    try {
      const concurrentId = readBoundedPrivateFile(
        filePath,
        MAX_PRIVATE_DEVICE_ID_BYTES
      ).trim();
      if (isValidDeviceId(concurrentId)) {
        return concurrentId;
      }
    } catch {
      /* replace invalid state below */
    }
    writePrivateFileAtomic(filePath, deviceId);
  }
  return deviceId;
};
