import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_STORAGE_STATE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_STORAGE_STATE_COOKIES = 10_000;
export const MAX_STORAGE_STATE_ORIGINS = 1_000;
export const MAX_STORAGE_STATE_ENTRIES = 50_000;
const STORAGE_STATE_READ_CHUNK_BYTES = 64 * 1024;

const assertArrayLength = (
  value: unknown,
  maxEntries: number,
  label: string
) => {
  if (Array.isArray(value) && value.length > maxEntries) {
    throw new Error(`Storage state exceeds ${maxEntries} ${label}`);
  }
};

export const assertStorageStatePayloadLimits = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Storage state must contain a JSON object');
  }
  const payload = value as Record<string, unknown>;
  assertArrayLength(payload.cookies, MAX_STORAGE_STATE_COOKIES, 'cookies');
  assertArrayLength(payload.origins, MAX_STORAGE_STATE_ORIGINS, 'origins');

  let storageEntries = 0;
  if (Array.isArray(payload.origins)) {
    for (const origin of payload.origins) {
      if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
        continue;
      }
      const originState = origin as Record<string, unknown>;
      for (const entries of [
        originState.localStorage,
        originState.sessionStorage,
      ]) {
        if (!Array.isArray(entries)) {
          continue;
        }
        storageEntries += entries.length;
        if (storageEntries > MAX_STORAGE_STATE_ENTRIES) {
          throw new Error(
            `Storage state exceeds ${MAX_STORAGE_STATE_ENTRIES} storage entries`
          );
        }
      }
    }
  }
};

export const serializeBoundedStorageState = (
  value: unknown,
  space?: number
): string => {
  assertStorageStatePayloadLimits(value);
  const serialized = JSON.stringify(value, null, space);
  if (typeof serialized !== 'string') {
    throw new Error('Storage state must contain a JSON value');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_STATE_FILE_BYTES) {
    throw new Error(
      `Storage state exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`
    );
  }
  return serialized;
};

const readBoundedStorageStateBuffer = (
  filePath: string,
  rejectSymlinks = false
) => {
  const pathStats = rejectSymlinks ? fs.lstatSync(filePath) : null;
  if (pathStats && (pathStats.isSymbolicLink() || !pathStats.isFile())) {
    throw new Error(`Storage state path is not a regular file: ${filePath}`);
  }

  const nonBlockingFlag =
    process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
  const noFollowFlag =
    rejectSymlinks && process.platform !== 'win32'
      ? (fs.constants.O_NOFOLLOW ?? 0)
      : 0;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | nonBlockingFlag | noFollowFlag
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`Storage state path is not a regular file: ${filePath}`);
    }
    if (
      !Number.isSafeInteger(stats.size) ||
      stats.size < 0 ||
      stats.size > MAX_STORAGE_STATE_FILE_BYTES
    ) {
      throw new Error(
        `Storage state file exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`
      );
    }
    if (pathStats) {
      const currentPathStats = fs.lstatSync(filePath);
      if (
        currentPathStats.isSymbolicLink() ||
        !currentPathStats.isFile() ||
        pathStats.dev !== stats.dev ||
        pathStats.ino !== stats.ino ||
        stats.dev !== currentPathStats.dev ||
        stats.ino !== currentPathStats.ino
      ) {
        throw new Error(
          `Storage state path changed while opening: ${filePath}`
        );
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_STORAGE_STATE_FILE_BYTES) {
      const remaining = MAX_STORAGE_STATE_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(STORAGE_STATE_READ_CHUNK_BYTES, remaining)
      );
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_STORAGE_STATE_FILE_BYTES) {
        throw new Error(
          `Storage state file exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve a read or validation error.
    }
  }
};

export const writeBoundedStorageStateFile = (
  filePath: string,
  serializedState: string,
  options: { backup?: boolean } = {}
) => {
  if (
    Buffer.byteLength(serializedState, 'utf8') > MAX_STORAGE_STATE_FILE_BYTES
  ) {
    throw new Error(
      `Storage state exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`
    );
  }

  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: number | null = null;
  let renamed = false;
  try {
    handle = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(handle, serializedState, { encoding: 'utf8' });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;

    if (options.backup !== false) {
      try {
        const currentState = readBoundedStorageStateBuffer(filePath, true);
        const backupPath = `${filePath}.bak`;
        const backupTemporaryPath = `${temporaryPath}.bak`;
        let backupHandle: number | null = null;
        let backupRenamed = false;
        try {
          backupHandle = fs.openSync(backupTemporaryPath, 'wx', 0o600);
          fs.writeFileSync(backupHandle, currentState);
          fs.fsyncSync(backupHandle);
          fs.closeSync(backupHandle);
          backupHandle = null;
          fs.renameSync(backupTemporaryPath, backupPath);
          backupRenamed = true;
        } finally {
          if (backupHandle !== null) {
            try {
              fs.closeSync(backupHandle);
            } catch {
              // Preserve the backup error.
            }
          }
          if (!backupRenamed) {
            fs.rmSync(backupTemporaryPath, { force: true });
          }
        }
      } catch {
        // A backup is best effort; the primary remains in place until swap.
      }
    }

    fs.renameSync(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Preserve the original write error.
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original write error.
      }
    }
  }
};

export const readBoundedStorageStateFile = (
  filePath: string
): Record<string, unknown> => {
  const raw = readBoundedStorageStateBuffer(filePath, true).toString('utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Storage state file contains invalid JSON: ${filePath}`);
  }
  assertStorageStatePayloadLimits(payload);
  return payload as Record<string, unknown>;
};
