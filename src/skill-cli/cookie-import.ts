export const MAX_CLI_COOKIE_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_COOKIE_IMPORT_ENTRIES = 10_000;

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
