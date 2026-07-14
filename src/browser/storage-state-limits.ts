import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_STORAGE_STATE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_STORAGE_STATE_COOKIES = 10_000;
export const MAX_STORAGE_STATE_ORIGINS = 1_000;
export const MAX_STORAGE_STATE_ENTRIES = 50_000;

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

const chmodPrivateFile = (filePath: string) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
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
    chmodPrivateFile(temporaryPath);

    if (options.backup !== false) {
      try {
        const currentStats = fs.lstatSync(filePath);
        if (
          currentStats.isFile() &&
          currentStats.size <= MAX_STORAGE_STATE_FILE_BYTES
        ) {
          const backupPath = `${filePath}.bak`;
          const backupTemporaryPath = `${temporaryPath}.bak`;
          let backupRenamed = false;
          try {
            fs.copyFileSync(
              filePath,
              backupTemporaryPath,
              fs.constants.COPYFILE_EXCL
            );
            chmodPrivateFile(backupTemporaryPath);
            fs.renameSync(backupTemporaryPath, backupPath);
            backupRenamed = true;
            chmodPrivateFile(backupPath);
          } finally {
            if (!backupRenamed) {
              fs.rmSync(backupTemporaryPath, { force: true });
            }
          }
        }
      } catch {
        // A backup is best effort; the primary remains in place until swap.
      }
    }

    fs.renameSync(temporaryPath, filePath);
    renamed = true;
    chmodPrivateFile(filePath);
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
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`Storage state path is not a regular file: ${filePath}`);
  }
  if (stats.size > MAX_STORAGE_STATE_FILE_BYTES) {
    throw new Error(
      `Storage state file exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_STORAGE_STATE_FILE_BYTES) {
    throw new Error(
      `Storage state file exceeds ${MAX_STORAGE_STATE_FILE_BYTES} bytes`
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Storage state file contains invalid JSON: ${filePath}`);
  }
  assertStorageStatePayloadLimits(payload);
  return payload as Record<string, unknown>;
};
