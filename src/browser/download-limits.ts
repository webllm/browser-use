export const MAX_AUTO_DOWNLOAD_SIZE_ENV =
  'BROWSER_USE_MAX_AUTO_DOWNLOAD_SIZE_MB';
export const DEFAULT_MAX_AUTO_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export const getMaxAutoDownloadBytes = (): number => {
  const raw = process.env[MAX_AUTO_DOWNLOAD_SIZE_ENV];
  if (raw == null || raw.trim() === '') {
    return DEFAULT_MAX_AUTO_DOWNLOAD_BYTES;
  }

  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    return DEFAULT_MAX_AUTO_DOWNLOAD_BYTES;
  }

  return Math.max(1, Math.floor(megabytes * 1024 * 1024));
};
