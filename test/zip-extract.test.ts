import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import { extractZipArchive } from '../src/filesystem/zip-extract.js';

const tempDirs: string[] = [];

const makeTempDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-zip-'));
  tempDirs.push(directory);
  return directory;
};

const writeZip = (entries: Array<[string, string]>) => {
  const zip = new AdmZip();
  for (const [name, content] of entries) {
    zip.addFile(name, Buffer.from(content));
  }
  const zipPath = path.join(makeTempDir(), 'archive.zip');
  zip.writeZip(zipPath);
  return zipPath;
};

/** Set an entry's external attributes in the central directory. */
const setExternalAttributes = (
  zipPath: string,
  fileName: string,
  attributes: number
) => {
  const raw = fs.readFileSync(zipPath);
  for (let offset = 0; offset < raw.length - 46; offset += 1) {
    if (raw.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = raw.readUInt16LE(offset + 28);
    const name = raw.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === fileName) {
      raw.writeUInt32LE(attributes >>> 0, offset + 38);
      fs.writeFileSync(zipPath, raw);
      return;
    }
  }
  throw new Error(`No central directory entry for ${fileName}`);
};

describe('extractZipArchive', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('extracts nested files and reports every entry first', async () => {
    const zipPath = writeZip([
      ['manifest.json', '{"name":"x"}'],
      ['icons/16.png', 'png-bytes'],
      ['_locales/en/messages.json', '{}'],
    ]);
    const destination = makeTempDir();
    const seen: string[] = [];

    await extractZipArchive(zipPath, {
      dir: destination,
      onEntry: (entry) => {
        seen.push(entry.fileName);
        expect(entry.uncompressedSize).toBeGreaterThan(0);
      },
    });

    expect(seen.sort()).toEqual([
      '_locales/en/messages.json',
      'icons/16.png',
      'manifest.json',
    ]);
    expect(
      fs.readFileSync(path.join(destination, 'icons', '16.png'), 'utf8')
    ).toBe('png-bytes');
    expect(
      fs.readFileSync(
        path.join(destination, '_locales', 'en', 'messages.json'),
        'utf8'
      )
    ).toBe('{}');
  });

  it('never creates symlinks from archive entries', async () => {
    const zipPath = writeZip([['link', '/etc/passwd']]);
    setExternalAttributes(zipPath, 'link', 0o120777 << 16);
    const destination = makeTempDir();

    await expect(
      extractZipArchive(zipPath, { dir: destination })
    ).rejects.toThrow('Archive entry is a symlink: link');
    expect(fs.existsSync(path.join(destination, 'link'))).toBe(false);
  });

  it('rejects entries that escape the destination', async () => {
    const zip = new AdmZip();
    zip.addFile('safe.txt', Buffer.from('ok'));
    const zipPath = path.join(makeTempDir(), 'traversal.zip');
    zip.writeZip(zipPath);
    // Rewrite the stored name to a traversal path of the same length.
    const raw = fs.readFileSync(zipPath);
    const patched = Buffer.from(
      raw.toString('latin1').replaceAll('safe.txt', '../x.txt'),
      'latin1'
    );
    fs.writeFileSync(zipPath, patched);
    const destination = makeTempDir();

    await expect(
      extractZipArchive(zipPath, { dir: destination })
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(path.dirname(destination), 'x.txt'))).toBe(
      false
    );
  });

  it('stops before writing when onEntry rejects an entry', async () => {
    const zipPath = writeZip([
      ['first.txt', 'one'],
      ['second.txt', 'two'],
    ]);
    const destination = makeTempDir();

    await expect(
      extractZipArchive(zipPath, {
        dir: destination,
        onEntry: (entry) => {
          if (entry.fileName === 'second.txt') {
            throw new Error('too many entries');
          }
        },
      })
    ).rejects.toThrow('too many entries');
    expect(fs.existsSync(path.join(destination, 'first.txt'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'second.txt'))).toBe(false);
  });
});
