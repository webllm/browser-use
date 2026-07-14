import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extract from 'extract-zip';

export const MAX_EXTENSION_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_EXTENSION_ARCHIVE_ENTRIES = 10_000;
export const MAX_EXTENSION_ENTRY_BYTES = 100 * 1024 * 1024;
export const MAX_EXTENSION_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
export const MAX_EXTENSION_MANIFEST_BYTES = 1024 * 1024;
export const MAX_EXTENSION_DOWNLOAD_REDIRECTS = 5;
export const EXTENSION_DOWNLOAD_TIMEOUT_MS = 30_000;
const EXTENSION_MANIFEST_READ_CHUNK_BYTES = 64 * 1024;

const chmodPrivate = async (targetPath: string, mode: number) => {
  if (process.platform !== 'win32') {
    await fsp.chmod(targetPath, mode);
  }
};

const assertSafeArchivePath = (entryName: string) => {
  if (
    !entryName ||
    entryName.includes('\0') ||
    entryName.startsWith('/') ||
    entryName.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(entryName)
  ) {
    throw new Error(`Unsafe extension archive path: ${entryName}`);
  }

  const parts = entryName.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..')) {
    throw new Error(`Unsafe extension archive path: ${entryName}`);
  }
};

export const readExtensionManifest = (
  manifestPath: string
): Record<string, unknown> => {
  const pathStats = fs.lstatSync(manifestPath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error('Extension manifest.json is invalid or too large');
  }
  const nonBlockingFlag =
    process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
  const noFollowFlag =
    process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | nonBlockingFlag | noFollowFlag
  );
  let raw: string;
  try {
    const stats = fs.fstatSync(descriptor);
    const currentPathStats = fs.lstatSync(manifestPath);
    if (
      !stats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      pathStats.dev !== stats.dev ||
      pathStats.ino !== stats.ino ||
      currentPathStats.dev !== stats.dev ||
      currentPathStats.ino !== stats.ino ||
      stats.size > MAX_EXTENSION_MANIFEST_BYTES
    ) {
      throw new Error('Extension manifest.json is invalid or too large');
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_EXTENSION_MANIFEST_BYTES) {
      const remaining = MAX_EXTENSION_MANIFEST_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(EXTENSION_MANIFEST_READ_CHUNK_BYTES, remaining)
      );
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_EXTENSION_MANIFEST_BYTES) {
        throw new Error('Extension manifest.json is too large');
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    raw = Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve a manifest read or validation error.
    }
  }
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Extension manifest.json must contain a JSON object');
  }
  return manifest as Record<string, unknown>;
};

const snapshotExtensionArchive = async (
  archivePath: string,
  snapshotPath: string
) => {
  const pathStats = await fsp.lstat(archivePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error('Extension archive is not a regular file');
  }
  const nonBlockingFlag =
    process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
  const noFollowFlag =
    process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(
    archivePath,
    fs.constants.O_RDONLY | nonBlockingFlag | noFollowFlag
  );
  try {
    const stats = await handle.stat();
    const currentPathStats = await fsp.lstat(archivePath);
    if (
      !stats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile() ||
      pathStats.dev !== stats.dev ||
      pathStats.ino !== stats.ino ||
      currentPathStats.dev !== stats.dev ||
      currentPathStats.ino !== stats.ino
    ) {
      throw new Error('Extension archive changed while opening');
    }
    if (stats.size > MAX_EXTENSION_DOWNLOAD_BYTES) {
      throw new Error(
        `Extension archive exceeds ${MAX_EXTENSION_DOWNLOAD_BYTES} bytes`
      );
    }
    await writeLimitedExtensionStream(
      handle.createReadStream({ autoClose: false }),
      snapshotPath
    );
    const finalStats = await handle.stat();
    const finalPathStats = await fsp.lstat(archivePath);
    const snapshotStats = await fsp.stat(snapshotPath);
    if (
      finalPathStats.isSymbolicLink() ||
      !finalPathStats.isFile() ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino ||
      finalPathStats.dev !== stats.dev ||
      finalPathStats.ino !== stats.ino ||
      finalStats.size !== stats.size ||
      finalStats.mtimeMs !== stats.mtimeMs ||
      finalStats.ctimeMs !== stats.ctimeMs ||
      snapshotStats.size !== stats.size
    ) {
      throw new Error('Extension archive changed while being copied');
    }
    return snapshotStats.size;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export class ExtensionArchiveBudget {
  private entryCount = 0;
  private uncompressedBytes = 0;

  addEntry(entry: {
    fileName: string;
    uncompressedSize: number;
    compressedSize: number;
    externalFileAttributes?: number;
  }) {
    assertSafeArchivePath(entry.fileName);

    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      !Number.isSafeInteger(entry.compressedSize) ||
      entry.compressedSize < 0
    ) {
      throw new Error(`Invalid extension archive sizes for ${entry.fileName}`);
    }

    const unixMode = ((entry.externalFileAttributes ?? 0) >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(
        `Extension archives may not contain symlinks: ${entry.fileName}`
      );
    }

    this.entryCount += 1;
    if (this.entryCount > MAX_EXTENSION_ARCHIVE_ENTRIES) {
      throw new Error(
        `Extension archive exceeds ${MAX_EXTENSION_ARCHIVE_ENTRIES} entries`
      );
    }

    if (entry.uncompressedSize > MAX_EXTENSION_ENTRY_BYTES) {
      throw new Error(
        `Extension archive entry exceeds ${MAX_EXTENSION_ENTRY_BYTES} bytes: ${entry.fileName}`
      );
    }

    this.uncompressedBytes += entry.uncompressedSize;
    if (this.uncompressedBytes > MAX_EXTENSION_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Extension archive expands beyond ${MAX_EXTENSION_UNCOMPRESSED_BYTES} bytes`
      );
    }
  }
}

export const assertExtensionContentLength = (
  value: string | string[] | null | undefined
) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return;
  const size = Number(raw);
  if (Number.isFinite(size) && size > MAX_EXTENSION_DOWNLOAD_BYTES) {
    throw new Error(
      `Extension download exceeds ${MAX_EXTENSION_DOWNLOAD_BYTES} bytes`
    );
  }
};

export const fetchExtensionResponse = async (
  crxUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    maxRedirects?: number;
  } = {}
): Promise<Response> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects =
    Number.isSafeInteger(options.maxRedirects) &&
    Number(options.maxRedirects) >= 0
      ? Number(options.maxRedirects)
      : MAX_EXTENSION_DOWNLOAD_REDIRECTS;
  let currentUrl = new URL(crxUrl);
  let redirectCount = 0;

  while (true) {
    if (currentUrl.protocol !== 'https:') {
      throw new Error('Extension downloads and redirects must use HTTPS');
    }

    const response = await fetchImpl(currentUrl, {
      signal: options.signal,
      redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      // The redirect response is already being discarded.
    }
    if (redirectCount >= maxRedirects) {
      throw new Error('Too many extension download redirects');
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Extension download redirect is missing a location');
    }
    currentUrl = new URL(location, currentUrl);
    redirectCount += 1;
  }
};

export const writeLimitedExtensionStream = async (
  source: Readable,
  outputPath: string,
  maxBytes = MAX_EXTENSION_DOWNLOAD_BYTES,
  signal?: AbortSignal
) => {
  const temporaryPath = `${outputPath}.${randomUUID()}.part`;
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxBytes) {
        callback(new Error(`Extension download exceeds ${maxBytes} bytes`));
        return;
      }
      callback(null, buffer);
    },
  });

  try {
    await pipeline(
      source,
      limiter,
      fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
      { signal }
    );
    await chmodPrivate(temporaryPath, 0o600);
    await fsp.rename(temporaryPath, outputPath);
    await chmodPrivate(outputPath, 0o600);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const getZipOffset = async (archivePath: string, archiveSize: number) => {
  const handle = await fsp.open(archivePath, 'r');
  try {
    const header = Buffer.alloc(Math.min(16, archiveSize));
    await handle.read(header, 0, header.length, 0);
    if (header.subarray(0, 4).toString('ascii') !== 'Cr24') {
      return 0;
    }
    if (header.length < 12) {
      throw new Error('Invalid CRX header');
    }

    const version = header.readUInt32LE(4);
    let offset: number;
    if (version === 2) {
      if (header.length < 16) throw new Error('Invalid CRX2 header');
      offset = 16 + header.readUInt32LE(8) + header.readUInt32LE(12);
    } else if (version === 3) {
      offset = 12 + header.readUInt32LE(8);
    } else {
      throw new Error(`Unsupported CRX version: ${version}`);
    }

    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + 4 > archiveSize
    ) {
      throw new Error('Invalid CRX header length');
    }
    return offset;
  } finally {
    await handle.close();
  }
};

export const extractExtensionArchive = async (
  archivePath: string,
  extractDir: string,
  options: { replaceExisting?: boolean } = {}
) => {
  const stagingDir = path.join(
    path.dirname(extractDir),
    `.${path.basename(extractDir)}.${randomUUID()}.tmp`
  );
  const archiveSnapshotPath = path.join(
    path.dirname(extractDir),
    `.${path.basename(extractDir)}.${randomUUID()}.archive`
  );
  let zipPath: string | null = null;

  await fsp.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  await chmodPrivate(stagingDir, 0o700);

  try {
    const archiveSize = await snapshotExtensionArchive(
      archivePath,
      archiveSnapshotPath
    );
    const offset = await getZipOffset(archiveSnapshotPath, archiveSize);
    zipPath =
      offset === 0
        ? archiveSnapshotPath
        : path.join(
            path.dirname(extractDir),
            `.${path.basename(extractDir)}.${randomUUID()}.zip`
          );
    if (offset > 0) {
      await writeLimitedExtensionStream(
        fs.createReadStream(archiveSnapshotPath, { start: offset }),
        zipPath
      );
    }

    const budget = new ExtensionArchiveBudget();
    await extract(zipPath, {
      dir: path.resolve(stagingDir),
      onEntry(entry) {
        budget.addEntry({
          fileName: entry.fileName,
          uncompressedSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          externalFileAttributes: entry.externalFileAttributes,
        });
      },
    });

    const manifestPath = path.join(stagingDir, 'manifest.json');
    const manifestStat = await fsp.lstat(manifestPath);
    if (
      !manifestStat.isFile() ||
      manifestStat.size > MAX_EXTENSION_MANIFEST_BYTES
    ) {
      throw new Error(
        'Extension manifest.json is missing, invalid, or too large'
      );
    }

    try {
      await fsp.lstat(extractDir);
      if (!options.replaceExisting) {
        throw new Error(
          `Extension destination already exists without a usable manifest: ${extractDir}`
        );
      }
      await fsp.rm(extractDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    await fsp.rename(stagingDir, extractDir);
    await chmodPrivate(extractDir, 0o700);
  } catch (error) {
    await fsp
      .rm(stagingDir, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  } finally {
    if (zipPath && zipPath !== archiveSnapshotPath) {
      await fsp.rm(zipPath, { force: true }).catch(() => undefined);
    }
    await fsp.rm(archiveSnapshotPath, { force: true }).catch(() => undefined);
  }
};

export const redactExtensionUrl = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid URL>';
  }
};
