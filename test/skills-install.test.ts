import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_USE_SKILL_NAME,
  runSkillCommand,
  SKILL_TARGETS,
} from '../src/skills/install.js';

const TEMP_DIRS: string[] = [];
const BUNDLED_SKILL_DIR = path.resolve('skills', BROWSER_USE_SKILL_NAME);

const makeTempDir = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'browser-use-skill-test-')
  );
  TEMP_DIRS.push(directory);
  return directory;
};

const createOutput = () => {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += String(chunk);
        return true;
      },
    },
    read: () => value,
  };
};

describe('coding-agent skill installer', () => {
  afterEach(async () => {
    await Promise.all(
      TEMP_DIRS.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
      )
    );
  });

  it('prints the bundled skill without installing it', async () => {
    const stdout = createOutput();
    const stderr = createOutput();

    const exitCode = await runSkillCommand(['show'], {
      bundledSkillDir: BUNDLED_SKILL_DIR,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain('name: browser-use');
    expect(stdout.read()).toContain('browser_exec');
    expect(stderr.read()).toBe('');
  });

  it('installs the complete skill at a custom path', async () => {
    const tempDir = await makeTempDir();
    const destination = path.join(tempDir, 'custom', BROWSER_USE_SKILL_NAME);
    const stdout = createOutput();

    const exitCode = await runSkillCommand(['install', '--path', destination], {
      bundledSkillDir: BUNDLED_SKILL_DIR,
      stdout: stdout.stream,
      stderr: createOutput().stream,
    });

    expect(exitCode).toBe(0);
    await expect(
      fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')
    ).resolves.toContain('name: browser-use');
    await expect(
      fs.readFile(path.join(destination, 'agents', 'openai.yaml'), 'utf8')
    ).resolves.toContain('Browser Use Direct');
    expect(stdout.read()).toContain(destination);
  });

  it('installs one selected target beneath the supplied home directory', async () => {
    const homeDir = await makeTempDir();
    const destination = path.join(
      homeDir,
      '.codex',
      'skills',
      BROWSER_USE_SKILL_NAME
    );

    const exitCode = await runSkillCommand(['install', '--target', 'codex'], {
      bundledSkillDir: BUNDLED_SKILL_DIR,
      homeDir,
      stdout: createOutput().stream,
      stderr: createOutput().stream,
    });

    expect(exitCode).toBe(0);
    await expect(
      fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')
    ).resolves.toContain('# Browser Use');
    await expect(
      fs.access(path.join(homeDir, '.claude'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs every supported target by default', async () => {
    const homeDir = await makeTempDir();
    const xdgConfigHome = path.join(homeDir, 'xdg');

    const exitCode = await runSkillCommand(['install'], {
      bundledSkillDir: BUNDLED_SKILL_DIR,
      homeDir,
      xdgConfigHome,
      stdout: createOutput().stream,
      stderr: createOutput().stream,
    });

    expect(exitCode).toBe(0);
    for (const target of SKILL_TARGETS) {
      const destination =
        target === 'opencode'
          ? path.join(
              xdgConfigHome,
              'opencode',
              'skills',
              BROWSER_USE_SKILL_NAME,
              'SKILL.md'
            )
          : path.join(
              homeDir,
              `.${target}`,
              'skills',
              BROWSER_USE_SKILL_NAME,
              'SKILL.md'
            );
      await expect(fs.access(destination)).resolves.toBeUndefined();
    }
  });

  it('ignores a relative XDG_CONFIG_HOME for the opencode target', async () => {
    const homeDir = await makeTempDir();
    const relativeXdgHome = `browser-use-relative-xdg-${process.pid}`;
    const unintendedDestination = path.resolve(relativeXdgHome);
    const originalXdgHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = relativeXdgHome;
    try {
      const exitCode = await runSkillCommand(
        ['install', '--target', 'opencode'],
        {
          bundledSkillDir: BUNDLED_SKILL_DIR,
          homeDir,
          stdout: createOutput().stream,
          stderr: createOutput().stream,
        }
      );

      expect(exitCode).toBe(0);
      await expect(
        fs.access(
          path.join(
            homeDir,
            '.config',
            'opencode',
            'skills',
            BROWSER_USE_SKILL_NAME,
            'SKILL.md'
          )
        )
      ).resolves.toBeUndefined();
      await expect(fs.access(unintendedDestination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (originalXdgHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgHome;
      }
      await fs.rm(unintendedDestination, { recursive: true, force: true });
    }
  });

  it('copies only SKILL.md when the custom destination is a file', async () => {
    const tempDir = await makeTempDir();
    const destination = path.join(tempDir, 'portable', 'SKILL.md');

    const exitCode = await runSkillCommand(
      ['install', `--path=${destination}`],
      {
        bundledSkillDir: BUNDLED_SKILL_DIR,
        stdout: createOutput().stream,
        stderr: createOutput().stream,
      }
    );

    expect(exitCode).toBe(0);
    await expect(fs.readFile(destination, 'utf8')).resolves.toContain(
      'name: browser-use'
    );
    await expect(
      fs.access(path.join(tempDir, 'portable', 'agents'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('updates managed files without deleting unrelated files when forced', async () => {
    const tempDir = await makeTempDir();
    const destination = path.join(tempDir, BROWSER_USE_SKILL_NAME);
    const stderr = createOutput();
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'sentinel.txt'), 'keep');

    const refusedCode = await runSkillCommand(
      ['install', '--path', destination],
      {
        bundledSkillDir: BUNDLED_SKILL_DIR,
        stdout: createOutput().stream,
        stderr: stderr.stream,
      }
    );

    expect(refusedCode).toBe(1);
    expect(stderr.read()).toContain('Use --force to update it');
    await expect(
      fs.readFile(path.join(destination, 'sentinel.txt'), 'utf8')
    ).resolves.toBe('keep');

    const forcedCode = await runSkillCommand(
      ['install', '--path', destination, '--force'],
      {
        bundledSkillDir: BUNDLED_SKILL_DIR,
        stdout: createOutput().stream,
        stderr: createOutput().stream,
      }
    );

    expect(forcedCode).toBe(0);
    await expect(
      fs.readFile(path.join(destination, 'sentinel.txt'), 'utf8')
    ).resolves.toBe('keep');
    await expect(
      fs.readFile(path.join(destination, 'SKILL.md'), 'utf8')
    ).resolves.toContain('name: browser-use');
  });

  it('rejects incompatible existing destinations even when forced', async () => {
    const tempDir = await makeTempDir();
    const directoryAsFile = path.join(tempDir, 'portable', 'SKILL.md');
    const fileAsDirectory = path.join(tempDir, 'browser-use');
    await fs.mkdir(directoryAsFile, { recursive: true });
    await fs.writeFile(fileAsDirectory, 'do not replace');

    const fileStderr = createOutput();
    const fileCode = await runSkillCommand(
      ['install', '--path', directoryAsFile, '--force'],
      {
        bundledSkillDir: BUNDLED_SKILL_DIR,
        stdout: createOutput().stream,
        stderr: fileStderr.stream,
      }
    );
    expect(fileCode).toBe(1);
    expect(fileStderr.read()).toContain('not a regular file');

    const directoryStderr = createOutput();
    const directoryCode = await runSkillCommand(
      ['install', '--path', fileAsDirectory, '--force'],
      {
        bundledSkillDir: BUNDLED_SKILL_DIR,
        stdout: createOutput().stream,
        stderr: directoryStderr.stream,
      }
    );
    expect(directoryCode).toBe(1);
    expect(directoryStderr.read()).toContain('not a directory');
    await expect(fs.readFile(fileAsDirectory, 'utf8')).resolves.toBe(
      'do not replace'
    );
  });

  it('reports invalid targets without writing any install', async () => {
    const homeDir = await makeTempDir();
    const stderr = createOutput();

    const exitCode = await runSkillCommand(['install', '--target', 'unknown'], {
      bundledSkillDir: BUNDLED_SKILL_DIR,
      homeDir,
      stdout: createOutput().stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain('Unsupported skill target');
    await expect(fs.readdir(homeDir)).resolves.toEqual([]);
  });
});
