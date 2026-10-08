import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TEMP_DIRS: string[] = [];

const makeTempDir = async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'browser-use-cli-entrypoint-')
  );
  TEMP_DIRS.push(dir);
  return dir;
};

const makeBinStyleEntryPath = async (
  sourcePath: string,
  tempDir: string,
  linkName: string
) => {
  const resolvedSourcePath = path.resolve(sourcePath);
  if (process.platform === 'win32') {
    return resolvedSourcePath;
  }

  const linkPath = path.join(tempDir, linkName);
  await fs.symlink(resolvedSourcePath, linkPath);
  return linkPath;
};

const runNode = (args: string[], timeoutMs = 20000) =>
  new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BROWSER_USE_LOGGING_LEVEL: 'result',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out running node ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

describe('CLI entrypoint alignment', () => {
  afterEach(async () => {
    await Promise.all(
      TEMP_DIRS.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true })
      )
    );
  });

  it('runs browser-use when invoked through a bin-style entry path', async () => {
    const tempDir = await makeTempDir();
    const entryPath = await makeBinStyleEntryPath(
      'src/cli.ts',
      tempDir,
      'browser-use #cli.ts'
    );

    const result = await runNode(['--import', 'tsx', entryPath, '--version']);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30000);

  it('preserves browser-use-direct exit codes from a bin-style entry path', async () => {
    const tempDir = await makeTempDir();
    const entryPath = await makeBinStyleEntryPath(
      'src/skill-cli/direct.ts',
      tempDir,
      'browser-use-direct #cli.ts'
    );

    const result = await runNode(['--import', 'tsx', entryPath]);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'Usage: browser-use-direct <command> [args]'
    );
  }, 30000);
});
