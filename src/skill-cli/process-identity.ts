import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export type ProcessCommandLineReader = (
  pid: number
) => string | null | Promise<string | null>;

export const getProcessCommandLine = (pid: number): string | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const commandLine = fs
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim();
      return commandLine || null;
    } catch {
      return null;
    }
  }

  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  }

  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
};
