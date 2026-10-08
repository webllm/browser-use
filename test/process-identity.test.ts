import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProcessArguments,
  isProcessRunning,
  isZombieProcess,
  MAX_PROCESS_INSPECTION_OUTPUT_BYTES,
  PROCESS_INSPECTION_TIMEOUT_MS,
} from '../src/process-identity.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const originalPlatform = process.platform;

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
});

describe('process identity', () => {
  it('does not trust a Windows command line without an observed executable', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        executablePath: null,
        commandLine:
          '"C:\\Program Files\\cloudflared.exe" tunnel --url http://localhost:3000',
      }),
    } as any);

    expect(getProcessArguments(1234)).toBeNull();
  });

  it('uses the observed Windows executable as the argv boundary', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        executablePath: 'C:\\Program Files\\cloudflared.exe',
        commandLine:
          '"C:\\Program Files\\cloudflared.exe" tunnel --url http://localhost:3000',
      }),
    } as any);

    expect(getProcessArguments(1234)).toEqual([
      'C:\\Program Files\\cloudflared.exe',
      'tunnel',
      '--url',
      'http://localhost:3000',
    ]);
    expect(spawnSync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({
        timeout: PROCESS_INSPECTION_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_INSPECTION_OUTPUT_BYTES,
      })
    );
  });
});

describe('process liveness', () => {
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  it('reports an unreaped Linux process as not running', () => {
    setPlatform('linux');
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(`${process.pid} (cloud (flare)) Z 1 1 1 0 -1`);

    try {
      expect(isZombieProcess(process.pid)).toBe(true);
      expect(isProcessRunning(process.pid)).toBe(false);
      expect(readSpy).toHaveBeenCalledWith(`/proc/${process.pid}/stat`, 'utf8');
    } finally {
      readSpy.mockRestore();
    }
  });

  it('reports a sleeping Linux process as running', () => {
    setPlatform('linux');
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(`${process.pid} (node) S 1 1 1 0 -1`);

    try {
      expect(isProcessRunning(process.pid)).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('relies on signal delivery alone outside Linux', () => {
    setPlatform('darwin');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    try {
      expect(isProcessRunning(process.pid)).toBe(true);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('reports a missing process as not running', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    try {
      expect(isProcessRunning(4321)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });
});
