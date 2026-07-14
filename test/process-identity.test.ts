import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProcessArguments } from '../src/process-identity.js';

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
  });
});
