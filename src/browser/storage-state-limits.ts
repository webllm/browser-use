import fs from 'node:fs';

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
