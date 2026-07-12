import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileSystem,
  FileSystemError,
  type FileSystemState,
} from '../src/filesystem/file-system.js';

describe('FileSystem state restoration', () => {
  it('rejects state names that escape the managed data directory before mutating disk', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-fs-state-')
    );
    const baseDir = path.join(tempDir, 'agent');
    const dataDir = path.join(baseDir, 'browseruse_agent_data');
    const sentinelPath = path.join(dataDir, 'sentinel.txt');
    const escapedPath = path.join(tempDir, 'escaped.md');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(sentinelPath, 'keep me');

    const state: FileSystemState = {
      base_dir: baseDir,
      extracted_content_count: 0,
      files: {
        'safe.md': {
          type: 'MarkdownFile',
          data: {
            name: '../../escaped',
            content: 'must stay contained',
          },
        },
      },
    };

    try {
      expect(() => FileSystem.from_state_sync(state)).toThrow(FileSystemError);
      expect(fs.readFileSync(sentinelPath, 'utf8')).toBe('keep me');
      expect(fs.existsSync(escapedPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('restores valid state using the validated filename', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-fs-state-')
    );
    const state: FileSystemState = {
      base_dir: tempDir,
      extracted_content_count: 2,
      files: {
        'notes.md': {
          type: 'MarkdownFile',
          data: { name: 'notes', content: 'restored content' },
        },
      },
    };

    try {
      const fileSystem = FileSystem.from_state_sync(state);
      expect(fileSystem.display_file('notes.md')).toBe('restored content');
      expect(
        fs.readFileSync(path.join(fileSystem.get_dir(), 'notes.md'), 'utf8')
      ).toBe('restored content');
      expect(fileSystem.extractedContentCount).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
