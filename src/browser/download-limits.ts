export const MAX_AUTO_DOWNLOAD_SIZE_ENV =
  'BROWSER_USE_MAX_AUTO_DOWNLOAD_SIZE_MB';
export const DEFAULT_MAX_AUTO_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_CONFIGURED_AUTO_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export const getMaxAutoDownloadBytes = (): number => {
  const raw = process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV];
  if (raw == null || raw.trim() === '') {
    return DEFAULT_MAX_AUTO_DOWNLOAD_BYTES;
  }

  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    return DEFAULT_MAX_AUTO_DOWNLOAD_BYTES;
  }

  const bytes = megabytes * 1024 * 1024;
  if (!Number.isSafeInteger(Math.floor(bytes))) {
    return MAX_CONFIGURED_AUTO_DOWNLOAD_BYTES;
  }
  return Math.min(
    MAX_CONFIGURED_AUTO_DOWNLOAD_BYTES,
    Math.max(1, Math.floor(bytes))
  );
};
