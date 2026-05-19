/**
 * Tests for BrowserSession functionality.
 *
 * Tests cover:
 * 1. Session lifecycle (start, stop)
 * 2. Basic browser operations
 * 3. Configuration options
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock utils
vi.mock('../src/utils.js', () => {
  let counter = 0;
  const decorator =
    <T extends (...args: any[]) => any>(_label?: string) =>
    (fn: T) =>
      fn;

  return {
    uuid7str: () => `uuid-${++counter}`,
    time_execution_sync: decorator,
    time_execution_async: decorator,
    SignalHandler: class {
      register() {}
      reset() {}
      unregister() {}
    },
    get_browser_use_version: () => 'test-version',
    is_new_tab_page: (url: string) =>
      url === 'about:blank' || url.startsWith('chrome://'),
    match_url_with_domain_pattern: (url: string, pattern: string) => {
      if (!pattern) return false;
      const normalized = pattern.replace(/\*/g, '');
      return url.includes(normalized);
    },
    sanitize_surrogates: (text: string) => text,
    log_pretty_path: (p: string) => p,
  };
});

// Mock telemetry
vi.mock('../src/telemetry/service.js', () => ({
  productTelemetry: {
    capture: vi.fn(),
    flush: vi.fn(),
  },
}));

// Import after mocks
import { BrowserSession, systemChrome } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';
import {
  DownloadProgressEvent,
  TabCreatedEvent,
} from '../src/browser/events.js';
import { DomService } from '../src/dom/service.js';
import { DOMElementNode, DOMTextNode, DOMState } from '../src/dom/views.js';

describe('BrowserSession Basic Operations', () => {
  const withPlatform = async (
    platform: NodeJS.Platform,
    fn: () => void | Promise<void>
  ) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  };

  const chromiumExecutablePath =
    process.platform === 'darwin'
      ? '/Applications/Chromium.app/Contents/MacOS/Chromium'
      : process.platform === 'linux'
        ? '/usr/bin/chromium'
        : 'C:\\Users\\tester\\AppData\\Local\\Chromium\\Application\\chrome.exe';

  const chromiumUserDataDir =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Chromium')
      : process.platform === 'linux'
        ? path.join(os.homedir(), '.config', 'chromium')
        : path.join(
            process.env.LOCALAPPDATA ??
              path.join(os.homedir(), 'AppData', 'Local'),
            'Chromium',
            'User Data'
          );

  const canaryExecutablePath =
    process.platform === 'darwin'
      ? '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
      : process.platform === 'linux'
        ? '/usr/bin/google-chrome-unstable'
        : 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe';

  const canaryUserDataDir =
    process.platform === 'darwin'
      ? path.join(
          os.homedir(),
          'Library',
          'Application Support',
          'Google',
          'Chrome Canary'
        )
      : process.platform === 'linux'
        ? path.join(os.homedir(), '.config', 'google-chrome-unstable')
        : path.join(
            process.env.LOCALAPPDATA ??
              path.join(os.homedir(), 'AppData', 'Local'),
            'Google',
            'Chrome SxS',
            'User Data'
          );

  it('creates browser session with profile', () => {
    const profile = new BrowserProfile({
      headless: true,
    });

    const session = new BrowserSession({
      browser_profile: profile,
    });

    expect(session).toBeDefined();
  });

  it('lists Chrome profiles from Local State metadata', () => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-chrome-profiles-')
    );
    try {
      fs.writeFileSync(
        path.join(userDataDir, 'Local State'),
        JSON.stringify({
          profile: {
            info_cache: {
              'Profile 2': { name: 'Work' },
              Default: { name: 'Personal' },
            },
          },
        })
      );

      expect(systemChrome.listProfiles(userDataDir)).toEqual([
        { directory: 'Default', name: 'Personal', email: '' },
        { directory: 'Profile 2', name: 'Work', email: '' },
      ]);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('exposes Chrome profile listing via BrowserSession', () => {
    const findExecutableSpy = vi
      .spyOn(systemChrome, 'findExecutable')
      .mockReturnValue(chromiumExecutablePath);
    const getUserDataDirSpy = vi
      .spyOn(systemChrome, 'getUserDataDir')
      .mockReturnValue('/tmp/chromium-user-data');
    const listProfilesSpy = vi
      .spyOn(systemChrome, 'listProfiles')
      .mockReturnValue([{ directory: 'Default', name: 'Default Profile' }]);

    try {
      expect(BrowserSession.list_chrome_profiles()).toEqual([
        { directory: 'Default', name: 'Default Profile' },
      ]);
      expect(getUserDataDirSpy).toHaveBeenCalledWith(chromiumExecutablePath);
      expect(listProfilesSpy).toHaveBeenCalledWith('/tmp/chromium-user-data');
      expect(listProfilesSpy).toHaveBeenCalledTimes(1);
    } finally {
      findExecutableSpy.mockRestore();
      getUserDataDirSpy.mockRestore();
      listProfilesSpy.mockRestore();
    }
  });

  it('maps Chromium executables to the matching user data directory', () => {
    expect(systemChrome.getUserDataDir(chromiumExecutablePath)).toBe(
      chromiumUserDataDir
    );
  });

  it('maps Canary executables to the matching user data directory', () => {
    expect(systemChrome.getUserDataDir(canaryExecutablePath)).toBe(
      canaryUserDataDir
    );
  });

  it('detects unstable Chrome commands on Linux', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-linux-chrome-')
    );
    const unstableBinary = path.join(tempDir, 'google-chrome-unstable');
    const whichBinary = path.join(tempDir, 'which');
    const originalPath = process.env.PATH;
    fs.writeFileSync(unstableBinary, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(unstableBinary, 0o755);
    fs.writeFileSync(
      whichBinary,
      `#!/bin/sh
case "$1" in
  google-chrome-unstable)
    printf '%s\\n' ${JSON.stringify(unstableBinary)}
    ;;
  *)
    exit 1
    ;;
esac
`
    );
    fs.chmodSync(whichBinary, 0o755);

    try {
      process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
      await withPlatform('linux', async () => {
        expect(systemChrome.findExecutable()).toBe(unstableBinary);
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects Canary installs on Windows', async () => {
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation(((
      candidate: fs.PathLike
    ) => {
      const normalized = String(candidate).replace(/\\/g, '/');
      return normalized.endsWith('Google/Chrome SxS/Application/chrome.exe');
    }) as any);

    try {
      await withPlatform('win32', async () => {
        expect(systemChrome.findExecutable()).toBe(
          path.join(
            process.env.LOCALAPPDATA ?? '',
            'Google',
            'Chrome SxS',
            'Application',
            'chrome.exe'
          )
        );
      });
    } finally {
      existsSyncSpy.mockRestore();
    }
  });

  it('prefers stable Chrome over Canary on Windows', async () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local';
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation(((
      candidate: fs.PathLike
    ) => {
      const normalized = String(candidate).replace(/\\/g, '/');
      return (
        normalized.startsWith('C:/Users/tester/AppData/Local/') &&
        (normalized.endsWith('Google/Chrome/Application/chrome.exe') ||
          normalized.endsWith('Google/Chrome SxS/Application/chrome.exe'))
      );
    }) as any);

    try {
      await withPlatform('win32', async () => {
        expect(systemChrome.findExecutable()).toBe(
          path.join(
            process.env.LOCALAPPDATA ?? '',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          )
        );
      });
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      existsSyncSpy.mockRestore();
    }
  });

  it('builds BrowserSession.from_system_chrome from detected profile data', () => {
    const findExecutableSpy = vi
      .spyOn(systemChrome, 'findExecutable')
      .mockReturnValue(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      );
    const getUserDataDirSpy = vi
      .spyOn(systemChrome, 'getUserDataDir')
      .mockReturnValue('/tmp/chrome-user-data');
    const listProfilesSpy = vi
      .spyOn(systemChrome, 'listProfiles')
      .mockReturnValue([{ directory: 'Profile 4', name: 'Work' }]);

    try {
      const session = BrowserSession.from_system_chrome({
        profile: { headless: true },
      });

      expect(session.browser_profile.config.executable_path).toBe(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      );
      expect(session.browser_profile.user_data_dir).toBe(
        '/tmp/chrome-user-data'
      );
      expect(session.browser_profile.config.profile_directory).toBe(
        'Profile 4'
      );
      expect(session.browser_profile.config.headless).toBe(true);
      expect(getUserDataDirSpy).toHaveBeenCalledWith(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      );
      expect(listProfilesSpy).toHaveBeenCalledWith('/tmp/chrome-user-data');
    } finally {
      findExecutableSpy.mockRestore();
      getUserDataDirSpy.mockRestore();
      listProfilesSpy.mockRestore();
    }
  });

  it('maps extra_http_headers to Playwright extraHTTPHeaders', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        extra_http_headers: {
          'X-Test-Header': 'value',
        },
      }),
    });

    const playwrightOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(playwrightOptions).toMatchObject({
      extraHTTPHeaders: {
        'X-Test-Header': 'value',
      },
    });
    expect(playwrightOptions.extraHttpHeaders).toBeUndefined();
  });

  it('applies configured extra_http_headers to existing contexts on start', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        extra_http_headers: {
          'X-Test-Header': 'value',
        },
      }),
      browser: {
        contexts: () => [
          {
            pages: () => [
              {
                isClosed: () => false,
                on: vi.fn(),
                url: () => 'https://example.com',
                title: vi.fn(async () => 'Example'),
              },
            ],
            setExtraHTTPHeaders: vi.fn(async () => {}),
          },
        ],
      } as any,
    });

    await session.start();

    expect(
      (session.browser_context as any).setExtraHTTPHeaders
    ).toHaveBeenCalledWith({
      'X-Test-Header': 'value',
    });
  });

  it('clones provided browser_profile to avoid shared mutable state', () => {
    const profile = new BrowserProfile({
      keep_alive: null,
      allowed_domains: ['example.com'],
    });

    const session = new BrowserSession({
      browser_profile: profile,
    });

    expect(session.browser_profile).not.toBe(profile);
    profile.keep_alive = true;
    expect(session.browser_profile.keep_alive).toBeNull();
  });

  it('supports python compatibility aliases for ownership and model_copy', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser: {} as any,
    });

    expect(session._owns_browser_resources).toBe(false);

    const copied = session.model_copy();
    expect(copied).toBeInstanceOf(BrowserSession);
    expect(copied).not.toBe(session);
  });

  it('treats sessions initialized with browser_pid as non-owning', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser_pid: 12345,
    });

    expect(session._owns_browser_resources).toBe(false);
  });

  it('normalizes pid values before tracking child processes', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    expect((session as any)._normalizePid(123)).toBe(123);
    expect((session as any)._normalizePid(0)).toBeNull();
    expect((session as any)._normalizePid(-1)).toBeNull();
    expect((session as any)._normalizePid(Number.NaN)).toBeNull();
  });

  it('skips invalid tracked pids when killing child processes', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    (session as any)._childProcesses = new Set([0, -10, Number.NaN]);
    const killSpy = vi.spyOn(process, 'kill');

    try {
      await (session as any)._killChildProcesses();
      expect(killSpy).not.toHaveBeenCalled();
      expect((session as any)._childProcesses.size).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('returns no child processes for invalid parent pid input', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    await expect((session as any)._getChildProcesses(0)).resolves.toEqual([]);
    await expect((session as any)._getChildProcesses(-4)).resolves.toEqual([]);
    await expect(
      (session as any)._getChildProcesses(Number.NaN)
    ).resolves.toEqual([]);
  });

  it('enforces single-agent attachment claims', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    expect(session.claim_agent('agent-a')).toBe(true);
    expect(session.claim_agent('agent-a')).toBe(true);
    expect(session.claim_agent('agent-b')).toBe(false);
    expect(session.get_attached_agent_id()).toBe('agent-a');

    expect(session.release_agent('agent-b')).toBe(false);
    expect(session.get_attached_agent_id()).toBe('agent-a');

    expect(session.release_agent('agent-a')).toBe(true);
    expect(session.get_attached_agent_id()).toBeNull();
  });

  it('supports shared attachment mode for controlled parallel agents', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    expect(session.claim_agent('agent-a', 'shared')).toBe(true);
    expect(session.claim_agent('agent-b', 'shared')).toBe(true);
    expect(session.get_attached_agent_ids().sort()).toEqual([
      'agent-a',
      'agent-b',
    ]);
    expect(session.claim_agent('agent-c')).toBe(false);

    expect(session.release_agent('agent-a')).toBe(true);
    expect(session.get_attached_agent_ids()).toEqual(['agent-b']);
    expect(session.release_agent('agent-b')).toBe(true);
    expect(session.get_attached_agent_ids()).toEqual([]);
  });

  it('deduplicates concurrent stop calls', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    await session.start();

    const shutdownSpy = vi
      .spyOn(session as any, '_shutdown_browser_session')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        (session as any).initialized = false;
      });

    await Promise.all([session.stop(), session.stop(), session.stop()]);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('appends text when clear=false in _input_text_element_node', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
    };
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);

    await session._input_text_element_node(
      { xpath: '/html/body/input' } as any,
      'append',
      { clear: false }
    );

    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(locator.type).toHaveBeenCalledWith('append', { timeout: 5000 });
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it('dispatches completed DownloadProgressEvent during element click downloads', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-click-dl-'));
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });

      const locator = {
        click: vi.fn(async () => {}),
      };
      const fakeDownload = {
        suggestedFilename: () => 'report.csv',
        url: () => 'https://example.com/report.csv',
        saveAs: vi.fn(async (targetPath: string) => {
          fs.writeFileSync(targetPath, 'abc');
        }),
      };
      const fakePage = {
        waitForEvent: vi.fn(async () => fakeDownload),
        waitForLoadState: vi.fn(async () => {}),
      };

      vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
      vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage as any);

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      const downloadPath = await session._click_element_node({
        xpath: '/html/body/a[1]',
      } as any);

      expect(downloadPath).toContain('report.csv');
      expect(fs.existsSync(downloadPath as string)).toBe(true);
      expect(
        dispatchSpy.mock.calls.some(
          ([event]) =>
            event instanceof DownloadProgressEvent &&
            event.state === 'completed'
        )
      ).toBe(true);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('_click_element_node does not leak an unhandledRejection when click throws and download wait times out', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-click-leak-'));
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });

      const locator = {
        click: vi.fn(async () => {
          throw new Error('element is not clickable');
        }),
      };
      const timeoutError = new Error('page.waitForEvent: Timeout 5000ms exceeded.');
      timeoutError.name = 'TimeoutError';
      // resolves async with a rejection so the rejection settles after the
      // synchronous call site, mimicking the real playwright timer behaviour.
      const fakePage = {
        waitForEvent: vi.fn(
          () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(timeoutError), 5);
            })
        ),
        waitForLoadState: vi.fn(async () => {}),
      };

      vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
      vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage as any);

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        await expect(
          session._click_element_node({ xpath: '/html/body/a[1]' } as any)
        ).rejects.toThrow('element is not clickable');
        // give the dangling waitForEvent rejection time to settle
        await new Promise(r => setTimeout(r, 30));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(unhandled).toEqual([]);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('perform_click rethrows element click failures', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const elementHandle = {
      click: vi.fn(async () => {
        throw new Error('element is not clickable');
      }),
    };
    const fakePage = {
      waitForEvent: vi.fn(() => new Promise(() => {})),
    } as any;

    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      elementHandle as any
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);

    await expect(
      session.perform_click({ xpath: '/html/body/button[1]' } as any)
    ).rejects.toThrow('element is not clickable');
  });

  it('perform_click treats only download timeouts as non-download clicks', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const timeoutError = new Error('Timeout 5000ms exceeded');
    timeoutError.name = 'TimeoutError';

    const elementHandle = {
      click: vi.fn(async () => {}),
    };
    const fakePage = {
      waitForEvent: vi.fn(async () => {
        throw timeoutError;
      }),
      waitForLoadState: vi.fn(async () => {}),
    } as any;

    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      elementHandle as any
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);

    const result = await session.perform_click({
      xpath: '/html/body/button[1]',
    } as any);

    expect(result).toBeNull();
    expect(fakePage.waitForLoadState).toHaveBeenCalledTimes(1);
  });

  it('perform_click creates download directory before saving files', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perform-click-'));
    const downloadsPath = path.join(tempRoot, 'downloads');
    const profile = new BrowserProfile({
      downloads_path: downloadsPath,
    });
    const session = new BrowserSession({
      browser_profile: profile,
    });

    const fakeDownload = {
      suggestedFilename: () => 'report.csv',
      url: () => 'https://example.com/report.csv',
      saveAs: vi.fn(async (targetPath: string) => {
        fs.writeFileSync(targetPath, 'csv');
      }),
    };
    const fakePage = {
      waitForEvent: vi.fn(async () => fakeDownload),
    } as any;
    const elementHandle = {
      click: vi.fn(async () => {}),
    };

    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      elementHandle as any
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);

    try {
      expect(fs.existsSync(downloadsPath)).toBe(false);
      const savedPath = await session.perform_click({
        xpath: '/html/body/a[1]',
      } as any);

      expect(typeof savedPath).toBe('string');
      expect(savedPath).toContain(downloadsPath);
      expect(fs.existsSync(downloadsPath)).toBe(true);
      expect(fs.existsSync(savedPath as string)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('aborts navigation when signal is triggered', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const never = new Promise<never>(() => {});
    const fakePage = {
      goto: vi.fn(() => never),
      url: () => 'about:blank',
    } as any;

    session.update_current_page(fakePage, 'about:blank', 'about:blank');
    (session as any).initialized = true;

    const controller = new AbortController();
    const navigation = session.navigate_to('https://example.com', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(navigation).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('tracks final URL and title after navigation redirects', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    let pageUrl = 'about:blank';
    const fakePage = {
      goto: vi.fn(async () => {
        pageUrl = 'https://example.com/final';
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Final Page'),
    } as any;

    session.update_current_page(fakePage, 'about:blank', 'about:blank');
    (session as any).initialized = true;

    await session.navigate_to('http://example.com/start');

    expect(session.active_tab?.url).toBe('https://example.com/final');
    expect(session.active_tab?.title).toBe('Final Page');
    expect((session as any).historyStack.at(-1)).toBe(
      'https://example.com/final'
    );
  });

  it('go_back uses live browser history even with a minimal internal stack', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    let pageUrl = 'https://example.com/page-2';
    const fakePage = {
      goBack: vi.fn(async () => {
        pageUrl = 'https://example.com/page-1';
        return null;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () =>
        pageUrl.endsWith('page-1') ? 'Page 1' : 'Page 2'
      ),
    } as any;

    session.update_current_page(
      fakePage,
      'Page 2',
      'https://example.com/page-2'
    );
    (session as any).initialized = true;
    (session as any).historyStack = ['https://example.com/page-2'];

    await session.go_back();

    expect(fakePage.goBack).toHaveBeenCalledTimes(1);
    expect(session.active_tab?.url).toBe('https://example.com/page-1');
    expect(session.active_tab?.title).toBe('Page 1');
  });

  it('syncs current URL after click-triggered navigation', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    let pageUrl = 'https://example.com/start';
    const fakePage = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const locator = {
      click: vi.fn(async () => {
        pageUrl = 'https://example.com/after-click';
      }),
    };

    session.update_current_page(fakePage, 'Start', 'https://example.com/start');
    (session as any).initialized = true;
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);

    await session._click_element_node({ xpath: '/html/body/a[1]' } as any);

    expect(session.active_tab?.url).toBe('https://example.com/after-click');
    expect((session as any).historyStack.at(-1)).toBe(
      'https://example.com/after-click'
    );
  });

  it('switches tabs by 4-char tab_id aliases', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const pageA = {
      bringToFront: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      url: vi.fn(() => 'https://a.test'),
    } as any;
    const pageB = {
      bringToFront: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      url: vi.fn(() => 'https://b.test'),
    } as any;

    (session as any)._tabs = [
      { page_id: 0, tab_id: '0000', url: 'https://a.test', title: 'A' },
      { page_id: 7, tab_id: '0007', url: 'https://b.test', title: 'B' },
    ];
    (session as any).tabPages.set(0, pageA);
    (session as any).tabPages.set(7, pageB);
    (session as any).currentTabIndex = 0;

    await session.switch_to_tab('0007');

    expect(session.active_tab?.tab_id).toBe('0007');
    expect(session.active_tab?.page_id).toBe(7);
    expect(pageB.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('surfaces externally opened tabs in state and allows switching to them', async () => {
    const minimalDom = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, []),
      {}
    );
    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockResolvedValue(minimalDom);

    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({}),
      });

      const evaluateA = vi.fn(async (script: unknown) => {
        const source =
          typeof script === 'function' ? script.toString() : String(script);
        if (source.includes('getEntriesByType')) {
          return [];
        }
        if (source.includes('viewportWidth') && source.includes('pageHeight')) {
          return {
            viewportWidth: 1280,
            viewportHeight: 720,
            scrollX: 0,
            scrollY: 0,
            pageWidth: 1280,
            pageHeight: 720,
          };
        }
        return null;
      });

      const pageA = {
        url: vi.fn(() => 'https://tab-a.test'),
        title: vi.fn(async () => 'Tab A'),
        evaluate: evaluateA,
        on: vi.fn(),
        off: vi.fn(),
        waitForLoadState: vi.fn(async () => {}),
        bringToFront: vi.fn(async () => {}),
      } as any;
      const pageB = {
        url: vi.fn(() => 'https://tab-b.test'),
        title: vi.fn(async () => 'Tab B'),
        on: vi.fn(),
        off: vi.fn(),
        waitForLoadState: vi.fn(async () => {}),
        bringToFront: vi.fn(async () => {}),
      } as any;

      session.update_current_page(pageA, 'Tab A', 'https://tab-a.test');
      (session as any).browser_context = {
        pages: vi.fn(() => [pageA, pageB]),
      } as any;
      (session as any).initialized = true;

      const summary = await session.get_browser_state_with_recovery({
        include_screenshot: false,
      });

      expect(summary.tabs.some((tab) => tab.url === 'https://tab-b.test')).toBe(
        true
      );

      await session.switch_to_tab(-1);
      expect(session.active_tab?.url).toBe('https://tab-b.test');
      expect(pageB.bringToFront).toHaveBeenCalledTimes(1);
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('create_new_tab throws on navigation failure and restores previous tab', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const existingPage = {
      url: vi.fn(() => 'https://current.test'),
      title: vi.fn(async () => 'Current'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const failingPage = {
      goto: vi.fn(async () => {
        throw new Error('navigation failed');
      }),
      close: vi.fn(async () => {}),
      url: vi.fn(() => 'about:blank'),
    } as any;

    session.update_current_page(
      existingPage,
      'Current',
      'https://current.test'
    );
    (session as any).browser_context = {
      newPage: vi.fn(async () => failingPage),
      pages: vi.fn(() => [existingPage]),
    } as any;
    (session as any).initialized = true;

    await expect(session.create_new_tab('https://broken.test')).rejects.toThrow(
      'navigation failed'
    );

    expect(session.tabs).toHaveLength(1);
    expect(session.active_tab?.url).toBe('https://current.test');
    expect(failingPage.close).toHaveBeenCalledTimes(1);
  });

  it('create_new_tab records redirected final URL in tab state and events', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    let redirectedUrl = 'about:blank';
    const existingPage = {
      url: vi.fn(() => 'https://current.test'),
      title: vi.fn(async () => 'Current'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const newPage = {
      goto: vi.fn(async () => {
        redirectedUrl = 'https://redirected.test/final';
      }),
      url: vi.fn(() => redirectedUrl),
      title: vi.fn(async () => 'Redirected'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const createdEvents: TabCreatedEvent[] = [];
    session.event_bus.on(
      'TabCreatedEvent',
      (event) => {
        createdEvents.push(event as TabCreatedEvent);
      },
      { handler_id: 'test.tab.created.redirected' }
    );

    session.update_current_page(
      existingPage,
      'Current',
      'https://current.test'
    );
    (session as any).browser_context = {
      newPage: vi.fn(async () => newPage),
      pages: vi.fn(() => [existingPage, newPage]),
    } as any;
    (session as any).initialized = true;
    vi.spyOn(session as any, '_waitForStableNetwork').mockResolvedValue(
      undefined
    );

    await session.create_new_tab('https://redirected.test/start');

    expect(session.active_tab?.url).toBe('https://redirected.test/final');
    expect((session as any).historyStack.at(-1)).toBe(
      'https://redirected.test/final'
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].url).toBe('https://redirected.test/final');
  });

  it('aborts browser state capture when signal is already aborted', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    session.update_current_page({ url: () => 'about:blank' } as any);
    (session as any).initialized = true;

    const controller = new AbortController();
    controller.abort();

    await expect(
      session.get_browser_state_with_recovery({ signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('auto-handles JavaScript dialogs and records closed popup messages', async () => {
    const listeners = new Map<string, (dialog: any) => Promise<void>>();
    const fakePage = {
      url: () => 'about:blank',
      on: vi.fn((event: string, handler: (dialog: any) => Promise<void>) => {
        listeners.set(event, handler);
      }),
    } as any;

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      page: fakePage,
    });

    const dialogHandler = listeners.get('dialog');
    expect(typeof dialogHandler).toBe('function');

    const alertDialog = {
      type: () => 'alert',
      message: () => 'This is alert',
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    };
    await dialogHandler?.(alertDialog);
    expect(alertDialog.accept).toHaveBeenCalledTimes(1);
    expect((session as any)._closedPopupMessages).toContain(
      '[alert] This is alert'
    );

    const promptDialog = {
      type: () => 'prompt',
      message: () => 'Need user input',
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    };
    await dialogHandler?.(promptDialog);
    expect(promptDialog.dismiss).toHaveBeenCalledTimes(1);
    expect((session as any)._closedPopupMessages).toContain(
      '[prompt] Need user input'
    );
  });

  it('preserves closed popup messages in minimal state summary', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      closed_popup_messages: ['[alert] Existing popup message'],
    });

    const fakePage = {
      url: () => 'https://example.com',
      title: vi.fn(async () => 'Example'),
    } as any;
    session.update_current_page(fakePage);
    (session as any).initialized = true;

    const summary = await session.get_minimal_state_summary();
    expect(summary.closed_popup_messages).toEqual([
      '[alert] Existing popup message',
    ]);
  });

  it('includes recent events, pending requests, and pagination buttons in browser state', async () => {
    const paginationNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/nav/button[1]',
      { 'aria-label': 'Next page', role: 'button' },
      [new DOMTextNode(true, null, 'Next')]
    );
    paginationNode.highlight_index = 1;
    const domState = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, [
        paginationNode,
      ]),
      { 1: paginationNode }
    );

    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockResolvedValue(domState);

    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({}),
      });

      const evaluate = vi.fn(async (script: unknown) => {
        const source =
          typeof script === 'function' ? script.toString() : String(script);
        if (source.includes('getEntriesByType')) {
          return [
            {
              url: 'https://example.com/api/items',
              method: 'GET',
              loading_duration_ms: 120,
              resource_type: 'fetch',
            },
          ];
        }
        if (source.includes('viewportWidth') && source.includes('pageHeight')) {
          return {
            viewportWidth: 1280,
            viewportHeight: 720,
            scrollX: 0,
            scrollY: 0,
            pageWidth: 1280,
            pageHeight: 2000,
          };
        }
        if (
          source.includes('embed[type="application/pdf"]') ||
          source.includes('object[type="application/pdf"]')
        ) {
          return false;
        }
        return null;
      });

      const fakePage = {
        url: () => 'https://example.com/list',
        title: vi.fn(async () => 'List'),
        evaluate,
        on: vi.fn(),
        off: vi.fn(),
      } as any;

      session.update_current_page(fakePage, 'List', 'https://example.com/list');
      (session as any).initialized = true;
      (session as any)._recordRecentEvent('tab_switched', {
        url: 'https://example.com/list',
        page_id: 0,
      });

      const summary = await session.get_browser_state_with_recovery({
        include_screenshot: false,
        include_recent_events: true,
      });

      expect(summary.recent_events).toContain('"event_type":"tab_switched"');
      expect(summary.pending_network_requests).toHaveLength(1);
      expect(summary.pending_network_requests[0]?.url).toContain('/api/items');
      expect(summary.pagination_buttons).toHaveLength(1);
      expect(summary.pagination_buttons[0]?.button_type).toBe('next');
      expect((session as any)._original_viewport_size).toEqual([1280, 720]);
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('refreshes stale url/title from the live page in recovery state', async () => {
    const minimalDom = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, []),
      {}
    );
    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockResolvedValue(minimalDom);

    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({}),
      });

      const evaluate = vi.fn(async (script: unknown) => {
        const source =
          typeof script === 'function' ? script.toString() : String(script);
        if (source.includes('getEntriesByType')) {
          return [];
        }
        if (source.includes('viewportWidth') && source.includes('pageHeight')) {
          return {
            viewportWidth: 1280,
            viewportHeight: 720,
            scrollX: 0,
            scrollY: 0,
            pageWidth: 1280,
            pageHeight: 720,
          };
        }
        return null;
      });

      const fakePage = {
        url: () => 'https://live.example/final',
        title: vi.fn(async () => 'Live title'),
        evaluate,
        on: vi.fn(),
        off: vi.fn(),
      } as any;

      session.update_current_page(
        fakePage,
        'Stale title',
        'https://stale.example'
      );
      (session as any).initialized = true;

      const summary = await session.get_browser_state_with_recovery({
        include_screenshot: false,
      });

      expect(summary.url).toBe('https://live.example/final');
      expect(summary.title).toBe('Live title');
      expect(session.active_tab?.url).toBe('https://live.example/final');
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('retries DOM extraction once when recovery initially returns an empty DOM', async () => {
    const emptyDom = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, []),
      {}
    );
    const buttonNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      {},
      [new DOMTextNode(true, null, 'Retry button')]
    );
    buttonNode.highlight_index = 1;
    const populatedDom = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, [buttonNode]),
      { 1: buttonNode }
    );
    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockResolvedValueOnce(emptyDom)
      .mockResolvedValueOnce(populatedDom);

    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({}),
      });
      const waitSpy = vi
        .spyOn(session as any, '_waitWithAbort')
        .mockResolvedValue(undefined);

      const evaluate = vi.fn(async (script: unknown) => {
        const source =
          typeof script === 'function' ? script.toString() : String(script);
        if (source.includes('getEntriesByType')) {
          return [];
        }
        if (source.includes('viewportWidth') && source.includes('pageHeight')) {
          return {
            viewportWidth: 1280,
            viewportHeight: 720,
            scrollX: 0,
            scrollY: 0,
            pageWidth: 1280,
            pageHeight: 720,
          };
        }
        return null;
      });

      const fakePage = {
        url: () => 'https://example.com/retry-dom',
        title: vi.fn(async () => 'Retry DOM'),
        evaluate,
        on: vi.fn(),
        off: vi.fn(),
      } as any;

      session.update_current_page(
        fakePage,
        'Retry DOM',
        'https://example.com/retry-dom'
      );
      (session as any).initialized = true;

      const summary = await session.get_browser_state_with_recovery({
        include_screenshot: false,
      });

      expect(clickableSpy).toHaveBeenCalledTimes(2);
      expect(waitSpy).toHaveBeenCalledWith(250, null);
      expect(summary.selector_map[1]?.tag_name).toBe('button');
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('passes profile highlight and viewport settings to recovery DOM extraction', async () => {
    const minimalDom = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, []),
      {}
    );
    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockResolvedValue(minimalDom);

    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          highlight_elements: false,
          viewport_expansion: 321,
        }),
      });

      const evaluate = vi.fn(async (script: unknown) => {
        const source =
          typeof script === 'function' ? script.toString() : String(script);
        if (source.includes('getEntriesByType')) {
          return [];
        }
        if (source.includes('viewportWidth') && source.includes('pageHeight')) {
          return {
            viewportWidth: 1280,
            viewportHeight: 720,
            scrollX: 0,
            scrollY: 0,
            pageWidth: 1280,
            pageHeight: 720,
          };
        }
        return null;
      });

      const fakePage = {
        url: () => 'https://example.com',
        title: vi.fn(async () => 'Example'),
        evaluate,
        on: vi.fn(),
        off: vi.fn(),
      } as any;

      session.update_current_page(fakePage, 'Example', 'https://example.com');
      (session as any).initialized = true;

      await session.get_browser_state_with_recovery({
        include_screenshot: false,
      });

      expect(clickableSpy).toHaveBeenCalledWith(false, -1, 321);
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('removes playwright highlight containers and cleanup callbacks', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const cleanupFn = vi.fn();
    const container = { remove: vi.fn() };
    const label = { remove: vi.fn() };
    const legacyHighlight = { remove: vi.fn() };
    const legacyStyled = { style: { outline: '1px solid red', border: '1px' } };

    const previousWindow = (globalThis as any).window;
    const previousDocument = (globalThis as any).document;

    const fakeWindow = {
      _highlightCleanupFunctions: [cleanupFn],
    } as any;
    const fakeDocument = {
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === '#playwright-highlight-container') {
          return [container];
        }
        if (selector === '.playwright-highlight-label') {
          return [label];
        }
        if (selector === '.browser-use-highlight') {
          return [legacyHighlight];
        }
        if (selector === '[style*="browser-use"]') {
          return [legacyStyled];
        }
        return [];
      }),
    } as any;

    const fakePage = {
      on: vi.fn(),
      evaluate: vi.fn(async (callback: () => void) => {
        (globalThis as any).window = fakeWindow;
        (globalThis as any).document = fakeDocument;
        try {
          callback();
        } finally {
          (globalThis as any).window = previousWindow;
          (globalThis as any).document = previousDocument;
        }
      }),
    } as any;

    session.update_current_page(fakePage);
    await session.remove_highlights();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
    expect(fakeWindow._highlightCleanupFunctions).toEqual([]);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(label.remove).toHaveBeenCalledTimes(1);
    expect(legacyHighlight.remove).toHaveBeenCalledTimes(1);
    expect(legacyStyled.style.outline).toBe('');
    expect(legacyStyled.style.border).toBe('');
  });

  it('forwards full_page screenshots to CDP captureBeyondViewport', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const fakePage = {
      url: () => 'https://example.com',
      bringToFront: vi.fn(async () => {}),
    } as any;
    const cdpSession = {
      send: vi.fn(async () => ({ data: 'ZmFrZS1pbWFnZS1iNjQ=' })),
      detach: vi.fn(async () => {}),
    } as any;

    (session as any).browser_context = {} as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue(
      cdpSession
    );

    const screenshot = await session.take_screenshot(true);

    expect(screenshot).toBe('ZmFrZS1pbWFnZS1iNjQ=');
    expect(cdpSession.send).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.objectContaining({
        captureBeyondViewport: true,
      })
    );
    expect(cdpSession.detach).toHaveBeenCalledTimes(1);
  });

  it('forwards screenshot clip regions to CDP captureScreenshot', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const fakePage = {
      url: () => 'https://example.com',
      bringToFront: vi.fn(async () => {}),
    } as any;
    const cdpSession = {
      send: vi.fn(async () => ({ data: 'ZmFrZS1pbWFnZS1iNjQ=' })),
      detach: vi.fn(async () => {}),
    } as any;

    (session as any).browser_context = {} as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue(
      cdpSession
    );

    const screenshot = await session.take_screenshot(false, {
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });

    expect(screenshot).toBe('ZmFrZS1pbWFnZS1iNjQ=');
    expect(cdpSession.send).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.objectContaining({
        captureBeyondViewport: false,
        clip: {
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          scale: 1,
        },
      })
    );
    expect(cdpSession.detach).toHaveBeenCalledTimes(1);
  });

  it('starts and stops browser session', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        headless: true,
      }),
    });

    await session.start();
    expect(session.browser).toBeTruthy();
    expect(session.browser_context).toBeTruthy();
    expect(await session.get_current_page()).toBeTruthy();

    await session.stop();
    expect(session.browser).toBeNull();
    expect(session.browser_context).toBeNull();
  });

  it('retries chromium launch without sandbox when sandbox is unavailable', async () => {
    const launch = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Chromium sandboxing failed! No usable sandbox.')
      );
    const fakePage = {
      url: () => 'about:blank',
      title: vi.fn(async () => 'about:blank'),
      isClosed: vi.fn(() => false),
    };
    const fakeContext = {
      pages: vi.fn(() => []),
      newPage: vi.fn(async () => fakePage),
      close: vi.fn(async () => {}),
    };
    const fakeBrowser = {
      contexts: vi.fn(() => []),
      newContext: vi.fn(async () => fakeContext),
      close: vi.fn(async () => {}),
      process: vi.fn(() => ({ pid: 12345 })),
    };
    launch.mockResolvedValueOnce(fakeBrowser);

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        headless: true,
        chromium_sandbox: true,
      }),
      playwright: {
        chromium: {
          launch,
        },
      } as any,
    });

    await session.start();

    expect(launch).toHaveBeenCalledTimes(2);
    const secondLaunchOptions = launch.mock.calls[1]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(secondLaunchOptions?.chromiumSandbox).toBe(false);
    expect(Array.isArray(secondLaunchOptions?.args)).toBe(true);
    expect(secondLaunchOptions?.args as string[]).toContain('--no-sandbox');

    await session.stop();
  });
});

describe('BrowserProfile Configuration', () => {
  it('creates profile with default headless (null by default)', () => {
    const profile = new BrowserProfile({});
    // headless defaults to null (auto-detect) in BrowserProfile
    expect(profile.config.headless).toBeNull();
  });

  it('creates profile with custom viewport', () => {
    const profile = new BrowserProfile({
      viewport: { width: 1920, height: 1080 },
    });

    expect(profile.viewport?.width).toBe(1920);
    expect(profile.viewport?.height).toBe(1080);
  });

  it('creates profile with user agent', () => {
    const customUA = 'Custom User Agent';
    const profile = new BrowserProfile({
      user_agent: customUA,
    });

    // Access via config since user_agent is not a public getter
    expect(profile.config.user_agent).toBe(customUA);
  });

  it('creates profile with headless mode', () => {
    const profile = new BrowserProfile({
      headless: true,
    });

    expect(profile.config.headless).toBe(true);
  });
});

describe('BrowserSession PDF Auto Download', () => {
  it('auto-downloads detected PDFs and tracks the file', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          downloads_path: downloadsDir,
        }),
      });

      const fakePage = {
        url: () => 'https://example.com/report.pdf',
        evaluate: vi.fn(async () => ({
          data: [37, 80, 68, 70], // %PDF
          fromCache: true,
          responseSize: 4,
        })),
      } as any;

      const downloadedPath = await (
        session as any
      )._auto_download_pdf_if_needed(fakePage);

      expect(downloadedPath).toBeTruthy();
      expect(fs.existsSync(downloadedPath!)).toBe(true);
      expect(session.get_downloaded_files()).toContain(downloadedPath);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('skips re-downloading the same PDF filename', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          downloads_path: downloadsDir,
        }),
      });

      const evaluate = vi.fn(async () => ({
        data: [37, 80, 68, 70],
        fromCache: false,
        responseSize: 4,
      }));
      const fakePage = {
        url: () => 'https://example.com/duplicate.pdf?token=abc',
        evaluate,
      } as any;

      const firstPath = await (session as any)._auto_download_pdf_if_needed(
        fakePage
      );
      const secondPath = await (session as any)._auto_download_pdf_if_needed(
        fakePage
      );

      expect(firstPath).toBeTruthy();
      expect(secondPath).toBeNull();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(session.get_downloaded_files()).toHaveLength(1);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });
});

describe('Direct Playwright Operations', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('navigates to URL', async () => {
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
  });

  it('gets page content', async () => {
    await page.setContent('<html><body><h1>Test</h1></body></html>');
    const content = await page.content();
    expect(content).toContain('Test');
  });

  it('handles page interactions', async () => {
    await page.setContent(`
      <html>
        <body>
          <button id="btn" onclick="this.textContent='Clicked'">Click me</button>
        </body>
      </html>
    `);

    await page.click('#btn');
    const text = await page.textContent('#btn');
    expect(text).toBe('Clicked');
  });

  it('handles form inputs', async () => {
    await page.setContent(`
      <html>
        <body>
          <input id="input" type="text" />
        </body>
      </html>
    `);

    await page.fill('#input', 'Hello World');
    const value = await page.inputValue('#input');
    expect(value).toBe('Hello World');
  });

  it('handles multiple tabs', async () => {
    const page2 = await context.newPage();
    await page2.goto('about:blank');

    const pages = context.pages();
    expect(pages.length).toBeGreaterThanOrEqual(2);

    await page2.close();
  });

  it('captures screenshots', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-test-'));
    const screenshotPath = path.join(tempDir, 'test.png');

    await page.setContent(
      '<html><body style="background:blue;"></body></html>'
    );
    await page.screenshot({ path: screenshotPath });

    expect(fs.existsSync(screenshotPath)).toBe(true);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });

  it('evaluates JavaScript', async () => {
    const result = await page.evaluate(() => 1 + 1);
    expect(result).toBe(2);
  });

  it('gets scroll position', async () => {
    await page.setContent(`
      <html>
        <body style="height: 5000px;">
          <div>Tall content</div>
        </body>
      </html>
    `);

    const scrollInfo = await page.evaluate(() => ({
      scrollTop: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      clientHeight: window.innerHeight,
    }));

    expect(scrollInfo.scrollTop).toBe(0);
    expect(scrollInfo.scrollHeight).toBeGreaterThan(0);
  });

  it('handles navigation history', async () => {
    await page.setContent('<html><body>Page 1</body></html>');

    // Page should be functional
    const content = await page.content();
    expect(content).toContain('Page 1');
  });
});

describe('Storage State', () => {
  it('saves and loads storage state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    // Add a cookie
    await context.addCookies([
      {
        name: 'test_cookie',
        value: 'test_value',
        domain: 'localhost',
        path: '/',
      },
    ]);

    // Save state
    await context.storageState({ path: statePath });

    expect(fs.existsSync(statePath)).toBe(true);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state).toHaveProperty('cookies');

    await browser.close();

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });
});

describe('DOM Extraction Patterns', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('extracts interactive elements', async () => {
    await page.setContent(`
      <html>
        <body>
          <button id="btn1">Button 1</button>
          <a href="#" id="link1">Link 1</a>
          <input type="text" id="input1" />
          <select id="select1">
            <option>Option 1</option>
          </select>
        </body>
      </html>
    `);

    const interactiveElements = await page.evaluate(() => {
      const selectors = ['button', 'a', 'input', 'select', 'textarea'];
      const elements: string[] = [];
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          elements.push(el.tagName.toLowerCase());
        });
      }
      return elements;
    });

    expect(interactiveElements).toContain('button');
    expect(interactiveElements).toContain('a');
    expect(interactiveElements).toContain('input');
    expect(interactiveElements).toContain('select');
  });

  it('handles complex nested structures', async () => {
    await page.setContent(`
      <html>
        <body>
          <nav>
            <ul>
              <li><a href="#1">Item 1</a></li>
              <li><a href="#2">Item 2</a></li>
            </ul>
          </nav>
          <main>
            <form>
              <input type="text" name="name" />
              <button type="submit">Submit</button>
            </form>
          </main>
        </body>
      </html>
    `);

    const structure = await page.evaluate(() => {
      return {
        hasNav: !!document.querySelector('nav'),
        hasMain: !!document.querySelector('main'),
        hasForm: !!document.querySelector('form'),
        linkCount: document.querySelectorAll('a').length,
        inputCount: document.querySelectorAll('input').length,
      };
    });

    expect(structure.hasNav).toBe(true);
    expect(structure.hasMain).toBe(true);
    expect(structure.hasForm).toBe(true);
    expect(structure.linkCount).toBe(2);
    expect(structure.inputCount).toBe(1);
  });
});

describe('Error Handling', () => {
  it('handles navigation timeout gracefully', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto('http://localhost:99999', { timeout: 1000 });
    } catch (error) {
      expect(error).toBeDefined();
    }

    await browser.close();
  });

  it('handles missing elements', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent('<html><body></body></html>');

    const element = await page.$('#nonexistent');
    expect(element).toBeNull();

    await browser.close();
  });
});
