import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  clear_direct_state,
  DIRECT_STATE_FILE,
  defaultLocalLauncher,
  load_direct_state,
  resolveDirectBrowserExecutable,
  run_direct_command,
  save_direct_state,
} from '../src/skill-cli/direct.js';
import { systemChrome } from '../src/browser/session.js';

const createWritable = () => {
  let buffer = '';
  return {
    stream: {
      write(chunk: string) {
        buffer += chunk;
      },
    },
    read() {
      return buffer;
    },
  };
};

describe('skill-cli direct alignment', () => {
  it('uses a user-private default state file instead of a shared tmp file', () => {
    expect(DIRECT_STATE_FILE).not.toBe(
      path.join(os.tmpdir(), 'browser-use-direct.json')
    );
    expect(path.basename(DIRECT_STATE_FILE)).toBe('direct-state.json');
    expect(path.dirname(DIRECT_STATE_FILE)).toContain('browser-use');
  });

  it('saves direct-mode state with private file permissions', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');

    try {
      save_direct_state(
        {
          mode: 'local',
          cdp_url: 'http://127.0.0.1:9222',
        },
        stateFile
      );
      if (process.platform !== 'win32') {
        expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
        fs.chmodSync(stateFile, 0o644);
      }

      save_direct_state(
        {
          mode: 'local',
          cdp_url: 'http://127.0.0.1:9333',
        },
        stateFile
      );

      expect(load_direct_state(stateFile)).toMatchObject({
        cdp_url: 'http://127.0.0.1:9333',
      });
      if (process.platform !== 'win32') {
        expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unregistered commands before launching or connecting', async () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const localLauncher = vi.fn();
    const sessionFactory = vi.fn();

    const exitCode = await run_direct_command(['not-a-command'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      local_launcher: localLauncher,
      session_factory: sessionFactory,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('Unknown command: not-a-command');
    expect(localLauncher).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it('launches a local browser on first open and persists direct-mode state', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const navigateSpy = vi.fn(async () => {});
    const session = {
      start: vi.fn(async () => {}),
      navigate_to: navigateSpy,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };
    const localLauncher = vi.fn(async () => ({
      cdp_url: 'http://127.0.0.1:9222',
      browser_pid: 321,
      browser_launch_token: 'owned-321',
      user_data_dir: '/tmp/browser-use-direct-profile',
    }));

    try {
      const exitCode = await run_direct_command(['open', 'example.com'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        local_launcher: localLauncher,
        session_factory: () => session as any,
      });

      expect(exitCode).toBe(0);
      expect(localLauncher).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenCalledWith('https://example.com');
      expect(stdout.read()).toContain('Navigated to: https://example.com');
      expect(stderr.read()).toBe('');
      expect(load_direct_state(stateFile)).toMatchObject({
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        active_url: 'https://example.com',
      });
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('treats non-leading --remote as command text instead of a mode switch', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const sendKeysSpy = vi.fn(async () => {});
    const createBrowserSpy = vi.fn(async () => ({
      id: 'remote-browser',
      cdpUrl: 'wss://cloud.example/devtools/browser/1',
    }));
    const localLauncher = vi.fn(async () => ({
      cdp_url: 'http://127.0.0.1:9222',
      browser_pid: 321,
      user_data_dir: '/tmp/browser-use-direct-profile',
    }));
    const session = {
      start: vi.fn(async () => {}),
      send_keys: sendKeysSpy,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    try {
      const exitCode = await run_direct_command(['type', '--remote'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        local_launcher: localLauncher,
        cloud_client_factory: () =>
          ({
            create_browser: createBrowserSpy,
            stop_browser: vi.fn(async () => {}),
          }) as any,
        session_factory: () => session as any,
      });

      expect(exitCode).toBe(0);
      expect(sendKeysSpy).toHaveBeenCalledWith('--remote');
      expect(localLauncher).toHaveBeenCalledTimes(1);
      expect(createBrowserSpy).not.toHaveBeenCalled();
      expect(stdout.read()).toContain('Typed 8 characters');
      expect(stdout.read()).not.toContain('--remote');
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('switches an existing local session when remote mode is explicit', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});
    const createBrowserSpy = vi.fn(async () => ({
      id: 'remote-browser',
      cdpUrl: 'wss://cloud.example/devtools/browser/1',
    }));
    const navigateSpy = vi.fn(async () => {});
    const sessionFactory = vi.fn(() => ({
      start: vi.fn(async () => {}),
      navigate_to: navigateSpy,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    }));

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(
        ['--remote', 'open', 'example.com'],
        {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          kill_process: killProcessSpy,
          get_process_command_line: () =>
            'chrome --browser-use-direct-token=owned-321',
          cloud_client_factory: () =>
            ({
              create_browser: createBrowserSpy,
              stop_browser: vi.fn(async () => {}),
            }) as any,
          session_factory: sessionFactory as any,
        }
      );

      expect(exitCode).toBe(0);
      expect(killProcessSpy).toHaveBeenCalledWith(321);
      expect(createBrowserSpy).toHaveBeenCalledTimes(1);
      expect(sessionFactory).toHaveBeenCalledTimes(1);
      expect(sessionFactory).toHaveBeenCalledWith({
        cdp_url: 'wss://cloud.example/devtools/browser/1',
      });
      expect(navigateSpy).toHaveBeenCalledWith('https://example.com');
      expect(load_direct_state(stateFile)).toMatchObject({
        mode: 'remote',
        cdp_url: 'wss://cloud.example/devtools/browser/1',
        session_id: 'remote-browser',
      });
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers system Chrome before the Playwright Chromium fallback', () => {
    const findExecutableSpy = vi
      .spyOn(systemChrome, 'findExecutable')
      .mockReturnValue('/system/google-chrome');
    const playwrightExecutableSpy = vi.spyOn(chromium, 'executablePath');

    try {
      expect(resolveDirectBrowserExecutable()).toEqual({
        executable_path: '/system/google-chrome',
        source: 'system_chrome',
      });
      expect(playwrightExecutableSpy).not.toHaveBeenCalled();
    } finally {
      findExecutableSpy.mockRestore();
      playwrightExecutableSpy.mockRestore();
    }
  });

  it('uses Playwright Chromium and removes its profile when direct launch fails', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const fakeChrome = path.join(tempDir, 'fake-chrome.sh');
    const ownedProfileDir = path.join(tempDir, 'owned-profile');
    fs.writeFileSync(fakeChrome, '#!/bin/sh\nsleep 5\n');
    fs.chmodSync(fakeChrome, 0o755);

    const findExecutableSpy = vi
      .spyOn(systemChrome, 'findExecutable')
      .mockReturnValue(null);
    const playwrightExecutableSpy = vi
      .spyOn(chromium, 'executablePath')
      .mockReturnValue(fakeChrome);
    const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((
      prefix: string
    ) => {
      expect(prefix).toContain('browser-use-direct-');
      fs.mkdirSync(ownedProfileDir, { recursive: true });
      return ownedProfileDir;
    }) as any);

    try {
      await expect(
        defaultLocalLauncher({
          state: {},
          timeout_ms: 10,
        })
      ).rejects.toThrow(
        /Timed out waiting for local Chrome debugging endpoint/
      );
      expect(fs.existsSync(ownedProfileDir)).toBe(false);
      expect(playwrightExecutableSpy).toHaveBeenCalledTimes(1);
    } finally {
      findExecutableSpy.mockRestore();
      playwrightExecutableSpy.mockRestore();
      mkdtempSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('explains how to install Chromium when neither executable exists', async () => {
    const findExecutableSpy = vi
      .spyOn(systemChrome, 'findExecutable')
      .mockReturnValue(null);
    const playwrightExecutableSpy = vi
      .spyOn(chromium, 'executablePath')
      .mockReturnValue('/missing/playwright/chromium');

    try {
      await expect(defaultLocalLauncher({ state: {} })).rejects.toThrow(
        'run "browser-use install"'
      );
    } finally {
      findExecutableSpy.mockRestore();
      playwrightExecutableSpy.mockRestore();
    }
  });

  it('does not reuse a saved Chrome profile with Playwright Chromium', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-fallback-')
    );
    const fakeChromium = path.join(tempDir, 'chromium');
    fs.writeFileSync(fakeChromium, '', { mode: 0o755 });
    const findExecutableSpy = vi
      .spyOn(systemChrome, 'findExecutable')
      .mockReturnValue(null);
    const playwrightExecutableSpy = vi
      .spyOn(chromium, 'executablePath')
      .mockReturnValue(fakeChromium);

    try {
      await expect(
        defaultLocalLauncher({
          state: {
            user_data_dir: path.join(tempDir, 'saved-chrome-profile'),
            owns_user_data_dir: false,
          },
        })
      ).rejects.toThrow('cannot reuse a saved Chrome profile');
    } finally {
      findExecutableSpy.mockRestore();
      playwrightExecutableSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'returns local browser spawn errors instead of crashing the process',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-direct-')
      );
      const fakeChrome = path.join(tempDir, 'not-executable-chrome');
      const ownedProfileDir = path.join(tempDir, 'owned-profile');
      fs.writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n', { mode: 0o600 });

      const findExecutableSpy = vi
        .spyOn(systemChrome, 'findExecutable')
        .mockReturnValue(fakeChrome);
      const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((
        prefix: string
      ) => {
        expect(prefix).toContain('browser-use-direct-');
        fs.mkdirSync(ownedProfileDir, { recursive: true });
        return ownedProfileDir;
      }) as any);

      try {
        await expect(
          defaultLocalLauncher({ state: {}, timeout_ms: 5_000 })
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(fs.existsSync(ownedProfileDir)).toBe(false);
      } finally {
        findExecutableSpy.mockRestore();
        mkdtempSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'force-stops an owned browser launch that ignores SIGTERM before deleting its profile',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-direct-')
      );
      const fakeChrome = path.join(tempDir, 'ignores-term');
      const pidFile = path.join(tempDir, 'pid');
      const ownedProfileDir = path.join(tempDir, 'owned-profile');
      fs.writeFileSync(
        fakeChrome,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o755 }
      );

      const findExecutableSpy = vi
        .spyOn(systemChrome, 'findExecutable')
        .mockReturnValue(fakeChrome);
      const mkdtempSpy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((
        prefix: string
      ) => {
        expect(prefix).toContain('browser-use-direct-');
        fs.mkdirSync(ownedProfileDir, { recursive: true });
        return ownedProfileDir;
      }) as any);

      let launchedPid: number | null = null;
      try {
        await expect(
          // Parallel Vitest workers can delay a fresh Node process well past
          // 500ms before it writes the PID marker. Keep this comfortably
          // below the production timeout while allowing the child to start.
          defaultLocalLauncher({ state: {}, timeout_ms: 3_000 })
        ).rejects.toThrow(
          /Timed out waiting for local Chrome debugging endpoint/
        );
        launchedPid = Number(fs.readFileSync(pidFile, 'utf8'));
        expect(Number.isSafeInteger(launchedPid)).toBe(true);
        expect(() => process.kill(launchedPid!, 0)).toThrow();
        expect(fs.existsSync(ownedProfileDir)).toBe(false);
      } finally {
        findExecutableSpy.mockRestore();
        mkdtempSpy.mockRestore();
        if (launchedPid) {
          try {
            process.kill(-launchedPid, 'SIGKILL');
          } catch {
            // The failed launch should already be gone.
          }
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    15_000
  );

  it('reuses saved direct-mode state for click-by-index commands', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const clickSpy = vi.fn(async () => {});
    const localLauncher = vi.fn(async () => ({
      cdp_url: 'http://127.0.0.1:9222',
    }));

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    const session = {
      start: vi.fn(async () => {}),
      tabs: [{ target_id: 'target-1', url: 'https://example.com' }],
      switch_to_tab: vi.fn(async () => {}),
      get_dom_element_by_index: vi.fn(async () => ({ index: 7 })),
      _click_element_node: clickSpy,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    try {
      const exitCode = await run_direct_command(['click', '7'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        local_launcher: localLauncher,
        session_factory: () => session as any,
      });

      expect(exitCode).toBe(0);
      expect(localLauncher).not.toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalledWith({ index: 7 });
      expect(stdout.read()).toContain('Clicked element [7]');
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cleans up stale local direct-mode state before relaunching', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const staleUserDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});
    const localLauncher = vi.fn(async () => ({
      cdp_url: 'http://127.0.0.1:9333',
      browser_pid: 456,
      user_data_dir: '/tmp/browser-use-direct-next',
    }));
    const staleSession = {
      start: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const freshSession = {
      start: vi.fn(async () => {}),
      navigate_to: vi.fn(async () => {}),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        user_data_dir: staleUserDataDir,
        owns_user_data_dir: true,
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['open', 'example.com'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: killProcessSpy,
        get_process_command_line: () =>
          'chrome --browser-use-direct-token=owned-321',
        local_launcher: localLauncher,
        session_factory: ({ cdp_url }) =>
          (cdp_url === 'http://127.0.0.1:9222'
            ? staleSession
            : freshSession) as any,
      });

      expect(exitCode).toBe(0);
      expect(killProcessSpy).toHaveBeenCalledWith(321);
      expect(fs.existsSync(staleUserDataDir)).toBe(false);
      expect(localLauncher).toHaveBeenCalledTimes(1);
      expect(load_direct_state(stateFile)).toMatchObject({
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9333',
        browser_pid: 456,
        active_url: 'https://example.com',
      });
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(staleUserDataDir, { recursive: true, force: true });
    }
  });

  it('removes owned local direct-mode profiles on close', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        user_data_dir: userDataDir,
        owns_user_data_dir: true,
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: killProcessSpy,
        get_process_command_line: () =>
          'chrome --browser-use-direct-token=owned-321',
      });

      expect(exitCode).toBe(0);
      expect(killProcessSpy).toHaveBeenCalledWith(321);
      expect(fs.existsSync(userDataDir)).toBe(false);
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('retains local state and profile when process termination fails', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stdout = createWritable();
    const stderr = createWritable();

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        user_data_dir: userDataDir,
        owns_user_data_dir: true,
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: vi.fn(async () => {
          throw new Error('permission denied');
        }),
        get_process_command_line: () =>
          'chrome --browser-use-direct-token=owned-321',
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).not.toContain('Browser closed');
      expect(stderr.read()).toContain('state was retained for retry');
      expect(fs.existsSync(stateFile)).toBe(true);
      expect(fs.existsSync(userDataDir)).toBe(true);
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'retains local state when the default termination signal is ignored',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-direct-')
      );
      const stateFile = path.join(tempDir, 'state.json');
      const userDataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-direct-')
      );
      const stdout = createWritable();
      const stderr = createWritable();
      const launchToken = `owned-${Date.now()}`;
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
          '--',
          `--browser-use-direct-token=${launchToken}`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );

      if (child.pid == null) {
        throw new Error('Failed to spawn termination test process');
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Termination test process did not start')),
          2_000
        );
        child.stdout.once('data', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      save_direct_state(
        {
          mode: 'local',
          cdp_url: 'http://127.0.0.1:9222',
          browser_pid: child.pid,
          browser_launch_token: launchToken,
          user_data_dir: userDataDir,
          owns_user_data_dir: true,
        },
        stateFile
      );

      try {
        const exitCode = await run_direct_command(['close'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
        });

        expect(exitCode).toBe(1);
        expect(stdout.read()).not.toContain('Browser closed');
        expect(stderr.read()).toContain('state was retained for retry');
        expect(fs.existsSync(stateFile)).toBe(true);
        expect(fs.existsSync(userDataDir)).toBe(true);
      } finally {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // The child may already have exited during cleanup.
        }
        clear_direct_state(stateFile);
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    },
    10_000
  );

  it('does not terminate a reused PID whose launch marker does not match', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});
    const getProcessCommandLineSpy = vi.fn(
      () => '/usr/bin/sleep --browser-use-direct-token=someone-else'
    );

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: killProcessSpy,
        get_process_command_line: getProcessCommandLineSpy,
      });

      expect(exitCode).toBe(0);
      expect(getProcessCommandLineSpy).toHaveBeenCalledWith(321);
      expect(killProcessSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retains state when a live browser PID cannot be ownership-verified', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        user_data_dir: userDataDir,
        owns_user_data_dir: true,
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: killProcessSpy,
        get_process_command_line: () => null,
      });

      expect(exitCode).toBe(1);
      expect(processKillSpy).toHaveBeenCalledWith(321, 0);
      expect(killProcessSpy).not.toHaveBeenCalled();
      expect(stderr.read()).toContain('state was retained for retry');
      expect(fs.existsSync(stateFile)).toBe(true);
      expect(fs.existsSync(userDataDir)).toBe(true);
    } finally {
      processKillSpy.mockRestore();
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('does not remove unsafe owned profile paths from direct state', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const userDataDir = path.join(tempDir, 'not-a-direct-owned-profile');
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});
    fs.mkdirSync(userDataDir, { recursive: true });

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        user_data_dir: userDataDir,
        owns_user_data_dir: true,
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: killProcessSpy,
        get_process_command_line: () =>
          'chrome --browser-use-direct-token=owned-321',
      });

      expect(exitCode).toBe(0);
      expect(killProcessSpy).toHaveBeenCalledWith(321);
      expect(fs.existsSync(userDataDir)).toBe(true);
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps user-managed local profiles on close', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const userDataDir = path.join(tempDir, 'user-profile');
    const stdout = createWritable();
    const stderr = createWritable();
    const killProcessSpy = vi.fn(async () => {});
    fs.mkdirSync(userDataDir, { recursive: true });

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        browser_pid: 321,
        browser_launch_token: 'owned-321',
        user_data_dir: userDataDir,
        owns_user_data_dir: false,
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        kill_process: killProcessSpy,
        get_process_command_line: () =>
          'chrome --browser-use-direct-token=owned-321',
      });

      expect(exitCode).toBe(0);
      expect(killProcessSpy).toHaveBeenCalledWith(321);
      expect(fs.existsSync(userDataDir)).toBe(true);
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(stderr.read()).toBe('');
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops stale remote direct-mode sessions before opening a new remote browser', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const stopBrowserSpy = vi.fn(async () => {});
    const createBrowserSpy = vi.fn(async () => ({
      id: 'session-new',
      cdpUrl: 'wss://cloud.example/devtools/browser/new',
    }));
    const staleSession = {
      start: vi.fn(async () => {
        throw new Error('socket closed');
      }),
    };
    const freshSession = {
      start: vi.fn(async () => {}),
      navigate_to: vi.fn(async () => {}),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'remote',
        cdp_url: 'wss://cloud.example/devtools/browser/old',
        session_id: 'session-old',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(
        ['--remote', 'open', 'example.com'],
        {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          cloud_client_factory: () =>
            ({
              create_browser: createBrowserSpy,
              stop_browser: stopBrowserSpy,
            }) as any,
          session_factory: ({ cdp_url }) =>
            (cdp_url === 'wss://cloud.example/devtools/browser/old'
              ? staleSession
              : freshSession) as any,
        }
      );

      expect(exitCode).toBe(0);
      expect(stopBrowserSpy).toHaveBeenCalledWith('session-old');
      expect(createBrowserSpy).toHaveBeenCalledTimes(1);
      expect(load_direct_state(stateFile)).toMatchObject({
        mode: 'remote',
        cdp_url: 'wss://cloud.example/devtools/browser/new',
        session_id: 'session-new',
        active_url: 'https://example.com',
      });
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops cloud sessions on close and clears persisted state', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const stopBrowserSpy = vi.fn(async () => {});

    save_direct_state(
      {
        mode: 'remote',
        cdp_url: 'wss://cloud.example/devtools/browser/test',
        session_id: 'session-123',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        cloud_client_factory: () =>
          ({
            create_browser: vi.fn(),
            stop_browser: stopBrowserSpy,
          }) as any,
      });

      expect(exitCode).toBe(0);
      expect(stopBrowserSpy).toHaveBeenCalledWith('session-123');
      expect(stdout.read()).toContain('Browser closed');
      expect(stderr.read()).toBe('');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retains remote state when closing the cloud session fails', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();

    save_direct_state(
      {
        mode: 'remote',
        cdp_url: 'wss://cloud.example/devtools/browser/test',
        session_id: 'session-123',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(['close'], {
        state_file: stateFile,
        stdout: stdout.stream,
        stderr: stderr.stream,
        cloud_client_factory: () =>
          ({
            create_browser: vi.fn(),
            stop_browser: vi.fn(async () => {
              throw new Error('cloud unavailable');
            }),
          }) as any,
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).not.toContain('Browser closed');
      expect(stderr.read()).toContain('state was retained for retry');
      expect(load_direct_state(stateFile)).toMatchObject({
        mode: 'remote',
        session_id: 'session-123',
      });
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports advanced direct-mode browser controls', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const waitForFunction = vi.fn(async () => {});
    const locator = {
      hover: vi.fn(async () => {}),
      dblclick: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    };
    const inputText = vi.fn(async () => {});
    const sendKeys = vi.fn(async () => {});
    const session = {
      start: vi.fn(async () => {}),
      tabs: [{ target_id: 'target-1', url: 'https://example.com' }],
      active_tab: { target_id: 'target-1', url: 'https://example.com' },
      switch_to_tab: vi.fn(async () => {}),
      close_tab: vi.fn(async () => {}),
      go_forward: vi.fn(async () => {}),
      wait_for_element: vi.fn(async () => {}),
      select_dropdown_option: vi.fn(async () => ['Option A']),
      get_dom_element_by_index: vi.fn(async () => ({ index: 4 })),
      get_locate_element: vi.fn(async () => locator),
      _input_text_element_node: inputText,
      send_keys: sendKeys,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
        waitForFunction,
      })),
      validate_page_after_action: vi.fn(async () => {}),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      expect(
        await run_direct_command(['forward'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['switch', '1'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['close-tab'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['select', '4', 'Option A'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['input', '4', 'super-secret-input'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['keys', 'super-secret-keys'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['wait', 'selector', '#app', '2500'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['wait', 'text', 'Ready'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['hover', '4'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['dblclick', '4'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['rightclick', '4'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);

      expect(session.go_forward).toHaveBeenCalledTimes(1);
      expect(session.switch_to_tab).toHaveBeenCalledWith(1);
      expect(session.close_tab).toHaveBeenCalledWith('target-1');
      expect(session.select_dropdown_option).toHaveBeenCalledWith(
        { index: 4 },
        'Option A'
      );
      expect(inputText).toHaveBeenCalledWith(
        { index: 4 },
        'super-secret-input',
        { clear: true }
      );
      expect(sendKeys).toHaveBeenCalledWith('super-secret-keys');
      expect(session.wait_for_element).toHaveBeenCalledWith('#app', 2500);
      expect(waitForFunction).toHaveBeenCalledTimes(1);
      expect(locator.hover).toHaveBeenCalledWith({ timeout: 5000 });
      expect(locator.dblclick).toHaveBeenCalledWith({ timeout: 5000 });
      expect(locator.click).toHaveBeenCalledWith({
        button: 'right',
        timeout: 5000,
      });
      expect(session.validate_page_after_action).toHaveBeenCalledTimes(4);
      expect(stdout.read()).not.toContain('Option A');
      expect(stdout.read()).not.toContain('super-secret');
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds eval output inside the page before writing direct-mode output', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const evaluate = vi.fn(
      async (fn: (input: any) => unknown, input: any) => await fn(input)
    );
    const session = {
      start: vi.fn(async () => {}),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
        evaluate,
      })),
      validate_page_after_action: vi.fn(async () => {}),
      execute_javascript: vi.fn(async () => {
        throw new Error('unbounded eval path must not be used');
      }),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(
        ['eval', "'x'.repeat(200000)"],
        {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        }
      );

      expect(exitCode).toBe(0);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(session.execute_javascript).not.toHaveBeenCalled();
      expect(session.validate_page_after_action).toHaveBeenCalledTimes(2);
      expect(stdout.read()).toContain(
        '...[result truncated by browser-use safety limits]'
      );
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports direct-mode get commands and extract placeholder output', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const session = {
      start: vi.fn(async () => {}),
      tabs: [{ target_id: 'target-1', url: 'https://example.com' }],
      switch_to_tab: vi.fn(async () => {}),
      get_dom_element_by_index: vi.fn(async () => ({
        index: 5,
        xpath: '//*[@data-id="target"]',
      })),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
        title: vi.fn(async () => 'Example Title'),
        evaluate: vi.fn(
          async (
            _fn: unknown,
            input:
              | string
              | {
                  elementXPath: string;
                  dataKind: string;
                }
              | {
                  rootSelector: string | null;
                }
          ) => {
            if (typeof input === 'string') {
              return `<div class="target">${input}</div>`;
            }
            if ('rootSelector' in input) {
              return {
                html: `<div class="target">${input.rootSelector}</div>`,
                truncated: false,
                visitedNodes: 2,
                sourceUrl: 'https://example.com',
                rootFound: true,
              };
            }
            if (input.dataKind === 'text') {
              return 'Visible text';
            }
            if (input.dataKind === 'attributes') {
              return { 'data-id': 'target' };
            }
            if (input.dataKind === 'bbox') {
              return { x: 1, y: 2, width: 3, height: 4 };
            }
            return null;
          }
        ),
      })),
      get_page_html: vi.fn(async () => '<html></html>'),
      validate_page_after_action: vi.fn(async () => {}),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      expect(
        await run_direct_command(['get', 'title'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['get', 'html', '.target'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['get', 'text', '5'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['get', 'attributes', '5'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['get', 'bbox', '5'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(['extract', 'Extract profile'], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);

      const output = stdout.read();
      expect(output).toContain('Example Title');
      expect(output).toContain('<div class="target">.target</div>');
      expect(output).toContain('Visible text');
      expect(output).toContain('"data-id":"target"');
      expect(output).toContain('"width":3');
      expect(output).toContain('extract requires agent mode');
      expect(session.validate_page_after_action).toHaveBeenCalledTimes(10);
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('saves direct screenshots as private files', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-shot-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const screenshotPath = path.join(tempDir, 'capture.png');
    const stdout = createWritable();
    const stderr = createWritable();
    const session = {
      start: vi.fn(async () => {}),
      take_screenshot: vi.fn(async () =>
        Buffer.from('fake-png').toString('base64')
      ),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(
        ['screenshot', screenshotPath],
        {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        }
      );

      expect(exitCode).toBe(0);
      expect(fs.existsSync(screenshotPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(screenshotPath).mode & 0o777).toBe(0o600);
      }
      expect(stderr.read()).toBe('');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('forwards full-page screenshot mode', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-full-shot-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const takeScreenshot = vi.fn(async () =>
      Buffer.from('image').toString('base64')
    );
    const session = {
      start: vi.fn(async () => {}),
      take_screenshot: takeScreenshot,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    try {
      const exitCode = await run_direct_command(['screenshot', '--full'], {
        state_file: stateFile,
        session_factory: () => session,
        local_launcher: async () => ({ cdp_url: 'http://localhost:9222' }),
        stdout: { write: vi.fn() },
        stderr: { write: vi.fn() },
      });

      expect(exitCode).toBe(0);
      expect(takeScreenshot).toHaveBeenCalledWith(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports direct-mode cookie commands', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const cookieFile = path.join(tempDir, 'cookies.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const browserContext = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
    };
    const session = {
      start: vi.fn(async () => {}),
      tabs: [{ target_id: 'target-1', url: 'https://example.com' }],
      switch_to_tab: vi.fn(async () => {}),
      get_cookies: vi.fn(async () => [
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
        { name: 'admin', value: '777', domain: '.example.com', path: '/admin' },
        { name: 'other', value: '999', domain: '.elsewhere.test', path: '/' },
      ]),
      browser_context: browserContext,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      expect(
        await run_direct_command(
          ['cookies', 'get', '--url', 'https://example.com/app'],
          {
            state_file: stateFile,
            stdout: stdout.stream,
            stderr: stderr.stream,
            session_factory: () => session as any,
          }
        )
      ).toBe(0);
      expect(
        await run_direct_command(
          [
            'cookies',
            'set',
            'sid',
            '456',
            '--same-site',
            'Lax',
            '--expires',
            '1735689600',
          ],
          {
            state_file: stateFile,
            stdout: stdout.stream,
            stderr: stderr.stream,
            session_factory: () => session as any,
          }
        )
      ).toBe(0);
      expect(
        await run_direct_command(
          ['cookies', 'export', cookieFile, '--url', 'https://example.com/app'],
          {
            state_file: stateFile,
            stdout: stdout.stream,
            stderr: stderr.stream,
            session_factory: () => session as any,
          }
        )
      ).toBe(0);
      expect(
        await run_direct_command(['cookies', 'import', cookieFile], {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        })
      ).toBe(0);
      expect(
        await run_direct_command(
          ['cookies', 'clear', '--url', 'https://example.com/app'],
          {
            state_file: stateFile,
            stdout: stdout.stream,
            stderr: stderr.stream,
            session_factory: () => session as any,
          }
        )
      ).toBe(0);

      expect(browserContext.addCookies).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'sid',
          value: '456',
          sameSite: 'Lax',
          expires: 1735689600,
          url: 'https://example.com',
        }),
      ]);
      expect(browserContext.clearCookies).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(cookieFile)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(cookieFile).mode & 0o777).toBe(0o600);
      }
      expect(stdout.read()).toContain('"count": 1');
      expect(JSON.parse(fs.readFileSync(cookieFile, 'utf8'))).toEqual([
        expect.objectContaining({ name: 'sid' }),
      ]);
      expect(browserContext.addCookies).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'admin' }),
          expect.objectContaining({ name: 'other' }),
        ])
      );
      expect(stdout.read()).toContain(
        'Cleared 1 cookies matching https://example.com/app'
      );
      expect(stderr.read()).toBe('');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('respects domain policy for direct-mode cookie set and import commands', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const cookieFile = path.join(tempDir, 'cookies.json');
    const exportFile = path.join(tempDir, 'exported-cookies.json');
    const browserContext = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
    };
    const session = {
      start: vi.fn(async () => {}),
      tabs: [{ target_id: 'target-1', url: 'https://example.com' }],
      switch_to_tab: vi.fn(async () => {}),
      browser_context: browserContext,
      get_cookies: vi.fn(async () => [
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
        { name: 'blocked', value: '1', domain: '.evil.test', path: '/' },
      ]),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      _get_cookie_access_denial_reason: vi.fn((cookie: any) => {
        const target = String(cookie?.url ?? cookie?.domain ?? '');
        return target.includes('evil.test') ? 'not_in_allowed_domains' : null;
      }),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    fs.writeFileSync(
      cookieFile,
      JSON.stringify([
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
        { name: 'blocked', value: '1', domain: '.evil.test', path: '/' },
      ])
    );
    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      const blockedStdout = createWritable();
      const blockedStderr = createWritable();
      const blockedSetExitCode = await run_direct_command(
        ['cookies', 'set', 'blocked', '1', '--url', 'https://evil.test'],
        {
          state_file: stateFile,
          stdout: blockedStdout.stream,
          stderr: blockedStderr.stream,
          session_factory: () => session as any,
        }
      );
      const importStdout = createWritable();
      const importStderr = createWritable();
      const importExitCode = await run_direct_command(
        ['cookies', 'import', cookieFile],
        {
          state_file: stateFile,
          stdout: importStdout.stream,
          stderr: importStderr.stream,
          session_factory: () => session as any,
        }
      );
      const getStdout = createWritable();
      const getStderr = createWritable();
      const getExitCode = await run_direct_command(['cookies', 'get'], {
        state_file: stateFile,
        stdout: getStdout.stream,
        stderr: getStderr.stream,
        session_factory: () => session as any,
      });
      const blockedGetStdout = createWritable();
      const blockedGetStderr = createWritable();
      const blockedGetExitCode = await run_direct_command(
        ['cookies', 'get', '--url', 'https://evil.test'],
        {
          state_file: stateFile,
          stdout: blockedGetStdout.stream,
          stderr: blockedGetStderr.stream,
          session_factory: () => session as any,
        }
      );
      const exportStdout = createWritable();
      const exportStderr = createWritable();
      const exportExitCode = await run_direct_command(
        ['cookies', 'export', exportFile],
        {
          state_file: stateFile,
          stdout: exportStdout.stream,
          stderr: exportStderr.stream,
          session_factory: () => session as any,
        }
      );
      const clearStdout = createWritable();
      const clearStderr = createWritable();
      const clearExitCode = await run_direct_command(['cookies', 'clear'], {
        state_file: stateFile,
        stdout: clearStdout.stream,
        stderr: clearStderr.stream,
        session_factory: () => session as any,
      });

      expect(blockedSetExitCode).toBe(1);
      expect(blockedStderr.read()).toContain('Cookie target blocked');
      expect(importExitCode).toBe(0);
      expect(importStdout.read()).toContain(`Imported 1 cookies`);
      expect(importStderr.read()).toBe('');
      expect(getExitCode).toBe(0);
      expect(getStderr.read()).toBe('');
      expect(JSON.parse(getStdout.read())).toEqual({
        cookies: [
          { name: 'sid', value: '123', domain: '.example.com', path: '/' },
        ],
        count: 1,
      });
      expect(blockedGetExitCode).toBe(1);
      expect(blockedGetStderr.read()).toContain('Cookie URL blocked');
      expect(exportExitCode).toBe(0);
      expect(exportStderr.read()).toBe('');
      expect(exportStdout.read()).toContain('Exported 1 cookies');
      expect(JSON.parse(fs.readFileSync(exportFile, 'utf8'))).toEqual([
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
      ]);
      expect(clearExitCode).toBe(0);
      expect(clearStderr.read()).toBe('');
      expect(clearStdout.read()).toContain('Cleared 1 cookies');
      expect(browserContext.clearCookies).toHaveBeenCalled();
      expect(browserContext.addCookies).toHaveBeenCalledTimes(2);
      expect(browserContext.addCookies).toHaveBeenNthCalledWith(1, [
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
      ]);
      expect(browserContext.addCookies).toHaveBeenNthCalledWith(2, [
        { name: 'blocked', value: '1', domain: '.evil.test', path: '/' },
      ]);
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not clear blocked subdomain cookies for a parent URL in direct mode', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const browserContext = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
    };
    const session = {
      start: vi.fn(async () => {}),
      tabs: [{ target_id: 'target-1', url: 'https://example.com' }],
      browser_context: browserContext,
      get_cookies: vi.fn(async () => [
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
        {
          name: 'blocked',
          value: '1',
          domain: '.evil.example.com',
          path: '/',
        },
      ]),
      _get_cookie_access_denial_reason: vi.fn((cookie: any) => {
        const target = String(cookie?.url ?? cookie?.domain ?? '');
        return target.includes('evil.example.com')
          ? 'not_in_allowed_domains'
          : null;
      }),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };
    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      const stdout = createWritable();
      const stderr = createWritable();
      const exitCode = await run_direct_command(
        ['cookies', 'clear', '--url', 'https://example.com'],
        {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        }
      );

      expect(exitCode).toBe(0);
      expect(stderr.read()).toBe('');
      expect(stdout.read()).toContain(
        'Cleared 1 cookies matching https://example.com'
      );
      expect(browserContext.clearCookies).toHaveBeenCalled();
      expect(browserContext.addCookies).toHaveBeenCalledWith([
        {
          name: 'blocked',
          value: '1',
          domain: '.evil.example.com',
          path: '/',
        },
      ]);
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown direct cookie options instead of treating them as positional values', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-direct-')
    );
    const stateFile = path.join(tempDir, 'state.json');
    const stdout = createWritable();
    const stderr = createWritable();
    const browserContext = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
    };
    const session = {
      start: vi.fn(async () => {}),
      get_cookies: vi.fn(async () => [
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
      ]),
      browser_context: browserContext,
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com',
      })),
      event_bus: { stop: vi.fn(async () => {}) },
      detach_all_watchdogs: vi.fn(),
    };

    save_direct_state(
      {
        mode: 'local',
        cdp_url: 'http://127.0.0.1:9222',
        active_url: 'https://example.com',
      },
      stateFile
    );

    try {
      const exitCode = await run_direct_command(
        ['cookies', 'clear', '--urll', 'https://example.com/app'],
        {
          state_file: stateFile,
          stdout: stdout.stream,
          stderr: stderr.stream,
          session_factory: () => session as any,
        }
      );

      expect(exitCode).toBe(1);
      expect(browserContext.clearCookies).not.toHaveBeenCalled();
      expect(stderr.read()).toContain('Unknown option: --urll');
    } finally {
      clear_direct_state(stateFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
