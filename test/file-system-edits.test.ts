import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystem } from '../src/filesystem/file-system.js';

const tempDirs: string[] = [];

const createFileSystem = () => {
  const baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-use-fs-edit-')
  );
  tempDirs.push(baseDir);
  return new FileSystem(baseDir);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileSystem.replace_file_str', () => {
  it('replaces every occurrence of existing text', async () => {
    const fileSystem = createFileSystem();
    await fileSystem.write_file('todo.md', '- [ ] a\n- [ ] b');

    const result = await fileSystem.replace_file_str('todo.md', '[ ]', '[x]');

    expect(result).toContain('Successfully replaced');
    expect(fileSystem.get_file('todo.md')?.read()).toBe('- [x] a\n- [x] b');
  });

  it('reports text that is not present instead of claiming success', async () => {
    const fileSystem = createFileSystem();
    await fileSystem.write_file('notes.md', 'hello world');

    const result = await fileSystem.replace_file_str(
      'notes.md',
      'missing text',
      'x'
    );

    expect(result).toBe(
      'Error: Could not find the specified text in file notes.md.'
    );
    expect(fileSystem.get_file('notes.md')?.read()).toBe('hello world');
  });
});

// A valid 1x1 transparent PNG.
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('FileSystem binary image writes', () => {
  it('writes a small base64 PNG as real bytes', async () => {
    const fileSystem = createFileSystem();

    const result = await fileSystem.write_file(
      'pixel.png',
      `${ONE_PIXEL_PNG}\n`
    );

    expect(result).toBe('Data written to file pixel.png successfully.');
    const written = fs.readFileSync(
      path.join(fileSystem.get_dir(), 'pixel.png')
    );
    expect(written.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(fileSystem.get_file('pixel.png')?.read()).toBe(
      `[binary png file, ${written.length} bytes]`
    );
    expect(fileSystem.describe()).not.toContain(ONE_PIXEL_PNG);
  });

  it('rejects base64 that is not an image of the requested type', async () => {
    const fileSystem = createFileSystem();

    const wrongType = await fileSystem.write_file('photo.jpg', ONE_PIXEL_PNG);
    const notBase64 = await fileSystem.write_file('icon.gif', 'not base64!');
    const notImage = await fileSystem.write_file(
      'text.webp',
      Buffer.from('hello world').toString('base64')
    );

    expect(wrongType).toContain('not a jpg image');
    expect(notBase64).toContain('is not valid base64');
    expect(notImage).toContain('not a webp image');
    // Failed writes do not leave ghost entries behind.
    expect(fileSystem.list_files()).not.toContain('photo.jpg');
    expect(fileSystem.list_files()).not.toContain('icon.gif');
    expect(fs.existsSync(path.join(fileSystem.get_dir(), 'photo.jpg'))).toBe(
      false
    );
  });

  it('refuses to append to binary files', async () => {
    const fileSystem = createFileSystem();
    await fileSystem.write_file('pixel.png', ONE_PIXEL_PNG);

    const result = await fileSystem.append_file('pixel.png', 'more');

    expect(result).toContain("cannot append to binary file 'pixel.png'");
  });

  it('still rejects other binary formats', async () => {
    const fileSystem = createFileSystem();

    const result = await fileSystem.write_file('clip.mp4', 'AAAA');

    expect(result).toContain("Cannot write binary/image file 'clip.mp4'");
  });
});
