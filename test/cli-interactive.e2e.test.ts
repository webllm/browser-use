import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TEMP_DIRS: string[] = [];

const makeTempDir = async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'browser-use-cli-interactive-test-')
  );
  TEMP_DIRS.push(dir);
  return dir;
};

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs = 20000) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for CLI process to exit'));
      }, timeoutMs);

      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }
  );

describe('CLI interactive mode e2e', () => {
  afterEach(async () => {
    await Promise.all(
      TEMP_DIRS.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true })
      )
    );
  });

  it('enters interactive mode and exits via help/exit commands', async () => {
    const configDir = await makeTempDir();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--model', 'ollama:qwen2.5:latest'],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BROWSER_USE_CLI_FORCE_INTERACTIVE: '1',
          BROWSER_USE_CONFIG_DIR: configDir,
          BROWSER_USE_LOGGING_LEVEL: 'result',
        },
      }
    );

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.stdin.write('help\n');
    child.stdin.write('exit\n');
    child.stdin.end();

    const { code, signal } = await waitForExit(child);
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(output).toContain('Interactive mode started.');
    expect(output).toContain('Type any task to run it. Use "exit" to quit.');
  }, 30000);
});
