import fs from 'node:fs';

export const MAX_SCREENSHOT_FILE_BYTES = 8 * 1024 * 1024;
const SCREENSHOT_READ_CHUNK_BYTES = 64 * 1024;

export type ScreenshotMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export type BoundedScreenshotFile = {
  data: Buffer;
  mediaType: ScreenshotMediaType;
};

const detectScreenshotMediaType = (
  data: Buffer
): ScreenshotMediaType | null => {
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      data.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
};

const normalizeScreenshotLimit = (maxBytes: number) =>
  Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MAX_SCREENSHOT_FILE_BYTES)
    : MAX_SCREENSHOT_FILE_BYTES;

export const decodeBoundedScreenshotBase64 = (
  value: string,
  maxBytes = MAX_SCREENSHOT_FILE_BYTES
): BoundedScreenshotFile => {
  const limit = normalizeScreenshotLimit(maxBytes);
  const normalized = value.trim();
  const maxEncodedChars = Math.ceil(limit / 3) * 4;
  if (
    !normalized ||
    normalized.length > maxEncodedChars ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error(`Screenshot exceeds or violates the ${limit}-byte limit`);
  }
  const data = Buffer.from(normalized, 'base64');
  const mediaType = detectScreenshotMediaType(data);
  if (data.length === 0 || data.length > limit || mediaType === null) {
    throw new Error(`Screenshot exceeds or violates the ${limit}-byte limit`);
  }
  return { data, mediaType };
};

export const readBoundedScreenshotFileSync = (
  filePath: string,
  maxBytes = MAX_SCREENSHOT_FILE_BYTES
): BoundedScreenshotFile | null => {
  const limit = normalizeScreenshotLimit(maxBytes);
  let descriptor: number | null = null;
  try {
    const pathStats = fs.lstatSync(filePath);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      return null;
    }
    const noFollow =
      process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    const nonBlocking =
      process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | noFollow | nonBlocking
    );
    const stats = fs.fstatSync(descriptor);
    const currentPathStats = fs.lstatSync(filePath);
    if (
      !stats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      pathStats.dev !== stats.dev ||
      pathStats.ino !== stats.ino ||
      currentPathStats.dev !== stats.dev ||
      currentPathStats.ino !== stats.ino ||
      stats.size > limit
    ) {
      return null;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= limit) {
      const remaining = limit + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(SCREENSHOT_READ_CHUNK_BYTES, remaining)
      );
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > limit) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const data = Buffer.concat(chunks, totalBytes);
    const mediaType = detectScreenshotMediaType(data);
    return mediaType ? { data, mediaType } : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The read result is already bounded; closing errors are non-actionable.
      }
    }
  }
};
