import { constants, promises as fs } from 'node:fs';

export const MAX_CLI_COOKIE_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_COOKIE_IMPORT_ENTRIES = 10_000;
const COOKIE_IMPORT_READ_CHUNK_BYTES = 64 * 1024;

type FileStatsLike = {
  size: number;
  isFile: () => boolean;
};

export const assertBoundedCookieImportFile = (
  stats: FileStatsLike,
  filePath: string
) => {
  if (!stats.isFile()) {
    throw new Error(`Cookie import path is not a regular file: ${filePath}`);
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new Error(`Cookie import file has an invalid size: ${filePath}`);
  }
  if (stats.size > MAX_CLI_COOKIE_IMPORT_BYTES) {
    throw new Error(
      `Cookie import file exceeds ${MAX_CLI_COOKIE_IMPORT_BYTES} bytes`
    );
  }
};

export const readBoundedCookieImportFile = async (filePath: string) => {
  const pathStats = await fs.lstat(filePath);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Cookie import path is not a regular file: ${filePath}`);
  }

  const nonBlockingFlag =
    process.platform === 'win32' ? 0 : constants.O_NONBLOCK;
  const noFollowFlag =
    process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | nonBlockingFlag | noFollowFlag
  );
  try {
    const stats = await handle.stat();
    const currentPathStats = await fs.lstat(filePath);
    assertBoundedCookieImportFile(stats, filePath);
    if (
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      stats.dev !== currentPathStats.dev ||
      stats.ino !== currentPathStats.ino
    ) {
      throw new Error(`Cookie import path changed while opening: ${filePath}`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_CLI_COOKIE_IMPORT_BYTES) {
      const remaining = MAX_CLI_COOKIE_IMPORT_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(COOKIE_IMPORT_READ_CHUNK_BYTES, remaining)
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_CLI_COOKIE_IMPORT_BYTES) {
        throw new Error(
          `Cookie import file exceeds ${MAX_CLI_COOKIE_IMPORT_BYTES} bytes`
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const parseBoundedCookieImport = (raw: string): unknown[] => {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CLI_COOKIE_IMPORT_BYTES) {
    throw new Error(
      `Cookie import file exceeds ${MAX_CLI_COOKIE_IMPORT_BYTES} bytes`
    );
  }

  let cookies: unknown;
  try {
    cookies = JSON.parse(raw);
  } catch {
    throw new Error('Cookie import file contains invalid JSON');
  }
  if (!Array.isArray(cookies)) {
    throw new Error('Cookie import file must contain a JSON array');
  }
  if (cookies.length > MAX_CLI_COOKIE_IMPORT_ENTRIES) {
    throw new Error(
      `Cookie import file exceeds ${MAX_CLI_COOKIE_IMPORT_ENTRIES} entries`
    );
  }
  return cookies;
};
