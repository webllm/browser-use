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
