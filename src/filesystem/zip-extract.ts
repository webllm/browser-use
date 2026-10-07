/**
 * Extract ZIP archives without trusting their metadata.
 *
 * Every entry is offered to `onEntry` before anything is written, so callers
 * can enforce entry counts, sizes, and names. Entries are written only as
 * plain directories and files: symlinks are never created, archive-supplied
 * permissions are ignored, and existing paths are never overwritten. Entry
 * sizes are verified while streaming, so a header cannot understate how much
 * data an entry expands to.
 */

import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export interface ZipEntryInfo {
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  externalFileAttributes: number;
}

export interface ExtractZipOptions {
  /** Destination directory; it must already exist. */
  dir: string;
  /** Inspect each entry before it is written; throw to abort extraction. */
  onEntry?: (entry: ZipEntryInfo) => void;
}

const SYMLINK_MODE = 0o120000;
const DIRECTORY_MODE = 0o040000;
const FILE_TYPE_MASK = 0o170000;

const openZip = (zipPath: string) =>
  new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(error ?? new Error(`Unable to open archive: ${zipPath}`));
        } else {
          resolve(zipfile);
        }
      }
    );
  });

const openEntryStream = (zipfile: yauzl.ZipFile, entry: yauzl.Entry) =>
  new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ${entry.fileName}`));
      } else {
        resolve(stream);
      }
    });
  });

const resolveInside = (root: string, fileName: string) => {
  const target = path.resolve(root, fileName);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Archive entry escapes the destination: ${fileName}`);
  }
  return target;
};

const writeEntry = async (
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  root: string
) => {
  const target = resolveInside(root, entry.fileName);
  const mode = (entry.externalFileAttributes >>> 16) & FILE_TYPE_MASK;
  if (entry.fileName.endsWith('/') || mode === DIRECTORY_MODE) {
    await fsp.mkdir(target, { recursive: true, mode: 0o755 });
    return;
  }
  if (mode === SYMLINK_MODE) {
    throw new Error(`Archive entry is a symlink: ${entry.fileName}`);
  }
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const stream = await openEntryStream(zipfile, entry);
  // "wx" refuses to follow or replace anything already at the path.
  await pipeline(
    stream,
    fs.createWriteStream(target, { flags: 'wx', mode: 0o644 })
  );
};

export const extractZipArchive = async (
  zipPath: string,
  options: ExtractZipOptions
): Promise<void> => {
  const root = path.resolve(options.dir);
  const zipfile = await openZip(zipPath);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      zipfile.close();
      reject(error);
    };
    zipfile.on('error', fail);
    zipfile.on('end', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zipfile.on('entry', (entry: yauzl.Entry) => {
      Promise.resolve()
        .then(() => {
          options.onEntry?.({
            fileName: entry.fileName,
            uncompressedSize: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            externalFileAttributes: entry.externalFileAttributes,
          });
          return writeEntry(zipfile, entry, root);
        })
        .then(() => {
          if (!settled) {
            zipfile.readEntry();
          }
        })
        .catch(fail);
    });
    zipfile.readEntry();
  });
};
