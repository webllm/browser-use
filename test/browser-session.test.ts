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
import { DEFAULT_MAX_AUTO_DOWNLOAD_BYTES } from '../src/browser/download-limits.js';
import {
  DownloadProgressEvent,
  TabCreatedEvent,
} from '../src/browser/events.js';
import { URLNotAllowedError } from '../src/browser/views.js';
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

  it('does not expose remote endpoint credentials in its description', () => {
    const session = new BrowserSession({
      cdp_url:
        'wss://user:password@example.com:9443/devtools/browser/instance-id?token=top-secret#fragment',
    });

    const description = session.toString();

    expect(description).toContain(':9443');
    expect(description).not.toContain('user');
    expect(description).not.toContain('password');
    expect(description).not.toContain('example.com');
    expect(description).not.toContain('instance-id');
    expect(description).not.toContain('top-secret');
    expect(description).not.toContain('fragment');
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

  it('creates temporary browser user data directories with private permissions', async () => {
    const session = new BrowserSession();
    const tempDir = await (session as any)._createTempUserDataDir();

    try {
      expect(path.basename(tempDir)).toMatch(/^browser-use-user-data-dir-/);
      expect(fs.existsSync(tempDir)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates configured browser user data directories with private permissions', async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-user-data-root-')
    );
    const userDataDir = path.join(tempRoot, 'profile');
    const session = new BrowserSession();

    try {
      await session.prepareUserDataDir(userDataDir);

      expect(fs.existsSync(userDataDir)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(userDataDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
    let copiedUserDataDir: string | null = null;

    try {
      const session = BrowserSession.from_system_chrome({
        profile: { headless: true },
      });
      copiedUserDataDir = session.browser_profile.user_data_dir;

      expect(session.browser_profile.config.executable_path).toBe(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      );
      expect(session.browser_profile.user_data_dir).not.toBe(
        '/tmp/chrome-user-data'
      );
      expect(path.basename(session.browser_profile.user_data_dir!)).toMatch(
        /^browser-use-user-data-dir-/
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
      if (copiedUserDataDir) {
        fs.rmSync(copiedUserDataDir, { recursive: true, force: true });
      }
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

  it('does not configure global extraHTTPHeaders when domain policy is active', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        extra_http_headers: {
          Authorization: 'Bearer secret',
        },
      }),
    });

    const playwrightOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(playwrightOptions.extraHTTPHeaders).toBeUndefined();
    expect(playwrightOptions.extraHttpHeaders).toBeUndefined();
  });

  it('does not configure global permissions when domain policy is active', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        permissions: ['clipboard-read', 'notifications'],
      }),
    });

    const playwrightOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(playwrightOptions.permissions).toBeUndefined();
  });

  it('does not configure unfilterable recording options when domain policy is active', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        record_video_dir: '/tmp/browser-use-videos',
        record_video_size: { width: 800, height: 600 },
      }),
    });

    const playwrightOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(playwrightOptions.recordVideoDir).toBeUndefined();
    expect(playwrightOptions.recordVideoSize).toBeUndefined();
  });

  it('requires scoped http_credentials when domain policy is active', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        http_credentials: {
          username: 'user',
          password: 'pass',
        },
      }),
    });

    expect(() =>
      (session as any)._toPlaywrightOptions(
        session.browser_profile.kwargs_for_new_context()
      )
    ).toThrow('http_credentials must include an origin');
  });

  it('keeps http_credentials with an allowed origin when domain policy is active', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        http_credentials: {
          username: 'user',
          password: 'pass',
          origin: 'https://example.com',
        },
      }),
    });

    const playwrightOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(playwrightOptions.httpCredentials).toEqual({
      username: 'user',
      password: 'pass',
      origin: 'https://example.com',
    });
  });

  it('rejects http_credentials scoped to a blocked origin', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        http_credentials: {
          username: 'user',
          password: 'pass',
          origin: 'https://evil.test',
        },
      }),
    });

    expect(() =>
      (session as any)._toPlaywrightOptions(
        session.browser_profile.kwargs_for_new_context()
      )
    ).toThrow(URLNotAllowedError);
  });

  it('keeps client certificates scoped to an allowed origin', () => {
    const certificate = {
      origin: 'https://example.com',
      certPath: '/tmp/client-cert.pem',
      keyPath: '/tmp/client-key.pem',
    };
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        client_certificates: [certificate],
      }),
    });

    const playwrightOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(playwrightOptions.clientCertificates).toHaveLength(1);
    expect(playwrightOptions.clientCertificates[0].origin).toBe(
      certificate.origin
    );
    expect(playwrightOptions.clientCertificates[0].certPath).toBe(
      certificate.certPath
    );
    expect(playwrightOptions.clientCertificates[0].keyPath).toBe(
      certificate.keyPath
    );
  });

  it('rejects client certificates scoped to a blocked origin', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        client_certificates: [
          {
            origin: 'https://evil.test',
            cert: Buffer.from('certificate'),
            key: Buffer.from('private-key'),
          },
        ],
      }),
    });

    expect(() =>
      (session as any)._toPlaywrightOptions(
        session.browser_profile.kwargs_for_new_context()
      )
    ).toThrow(URLNotAllowedError);
  });

  it('requires client certificate origins under domain restrictions', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        client_certificates: [
          {
            cert: Buffer.from('certificate'),
            key: Buffer.from('private-key'),
          } as any,
        ],
      }),
    });

    expect(() =>
      (session as any)._toPlaywrightOptions(
        session.browser_profile.kwargs_for_new_context()
      )
    ).toThrow('Every client certificate must include an origin');
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

  it('scopes extra_http_headers to allowed request URLs when domain policy is active', async () => {
    let routeHandler: ((route: any) => Promise<void>) | null = null;
    const context = {
      pages: () => [
        {
          isClosed: () => false,
          on: vi.fn(),
          url: () => 'https://example.com',
          title: vi.fn(async () => 'Example'),
        },
      ],
      setExtraHTTPHeaders: vi.fn(async () => {}),
      route: vi.fn(
        async (_pattern: string, handler: (route: any) => Promise<void>) => {
          routeHandler = handler;
        }
      ),
      unroute: vi.fn(async () => {}),
    };
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        extra_http_headers: {
          Authorization: 'Bearer secret',
        },
      }),
      browser: {
        contexts: () => [context],
      } as any,
    });

    await session.start();

    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({});
    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(routeHandler).toBeTypeOf('function');

    const allowedFallback = vi.fn(async () => {});
    await routeHandler!({
      request: () => ({
        url: () => 'https://example.com/api',
        headers: () => ({ Accept: 'application/json' }),
      }),
      fallback: allowedFallback,
    });

    expect(allowedFallback).toHaveBeenCalledWith({
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
      },
    });

    const blockedFallback = vi.fn(async () => {});
    await routeHandler!({
      request: () => ({
        url: () => 'https://evil.test/api',
        headers: () => ({
          Accept: 'application/json',
          authorization: 'Bearer secret',
        }),
        isNavigationRequest: () => false,
      }),
      fallback: blockedFallback,
    });

    expect(blockedFallback).toHaveBeenCalledWith({
      headers: { Accept: 'application/json' },
    });

    const unreadableHeadersAbort = vi.fn(async () => {});
    await routeHandler!({
      request: () => ({
        url: () => 'https://evil.test/image.png',
        isNavigationRequest: () => false,
      }),
      fallback: vi.fn(async () => {}),
      abort: unreadableHeadersAbort,
    });

    expect(unreadableHeadersAbort).toHaveBeenCalledWith('blockedbyclient');

    const blockedNavigationFallback = vi.fn(async () => {});
    const blockedNavigationAbort = vi.fn(async () => {});
    await routeHandler!({
      request: () => ({
        url: () => 'https://evil.test/redirect-target',
        headers: () => ({ Accept: 'text/html' }),
        isNavigationRequest: () => true,
        resourceType: () => 'document',
      }),
      fallback: blockedNavigationFallback,
      abort: blockedNavigationAbort,
    });

    expect(blockedNavigationAbort).toHaveBeenCalledWith('blockedbyclient');
    expect(blockedNavigationFallback).not.toHaveBeenCalled();
  });

  it('installs a pre-request navigation guard without extra headers', async () => {
    let routeHandler: ((route: any) => Promise<void>) | null = null;
    const context = {
      pages: () => [
        {
          isClosed: () => false,
          on: vi.fn(),
          url: () => 'https://example.com',
          title: vi.fn(async () => 'Example'),
        },
      ],
      setExtraHTTPHeaders: vi.fn(async () => {}),
      route: vi.fn(
        async (_pattern: string, handler: (route: any) => Promise<void>) => {
          routeHandler = handler;
        }
      ),
      unroute: vi.fn(async () => {}),
    };
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
      browser: {
        contexts: () => [context],
      } as any,
    });

    await session.start();

    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    const abort = vi.fn(async () => {});
    await routeHandler!({
      request: () => ({
        url: () => 'https://evil.test/redirect-target',
        headers: () => ({}),
        isNavigationRequest: () => true,
      }),
      abort,
      fallback: vi.fn(async () => {}),
    });
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
  });

  it('rolls back disallowed existing pages during start', async () => {
    let pageUrl = 'https://evil.test/start?token=secret';
    const page = {
      isClosed: () => false,
      on: vi.fn(),
      url: () => pageUrl,
      title: vi.fn(async () => pageUrl),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    };
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
      browser: {
        contexts: () => [
          {
            pages: () => [page],
            route: vi.fn(async () => {}),
            unroute: vi.fn(async () => {}),
            setExtraHTTPHeaders: vi.fn(async () => {}),
          },
        ],
      } as any,
    });

    await expect(session.start()).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(page.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back disallowed pages restored after reconnect', async () => {
    let pageUrl = 'https://evil.test/reconnect?token=secret';
    const page = {
      isClosed: () => false,
      on: vi.fn(),
      url: () => pageUrl,
      title: vi.fn(async () => pageUrl),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    };
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    (session as any).browser_context = {
      pages: () => [page],
    };

    await expect(
      (session as any)._restorePagesAfterReconnect(null, 0)
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(page.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
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

  it('does not terminate a browser PID whose launch marker does not match', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    session.browser_pid = 12345;
    (session as any)._browserLaunchToken = 'owned-browser';
    (session as any)._getProcessCommandLine = vi.fn(() => '/usr/bin/sleep 30');
    const killSpy = vi.spyOn(process, 'kill');

    try {
      await (session as any)._terminateBrowserProcess();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('rechecks browser ownership before escalating to SIGKILL', async () => {
    vi.useFakeTimers();
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    session.browser_pid = 12345;
    (session as any)._browserLaunchToken = 'owned-browser';
    (session as any)._getProcessCommandLine = vi
      .fn()
      .mockReturnValueOnce('chrome --browser-use-session-token=owned-browser')
      .mockReturnValueOnce(null);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      const termination = (session as any)._terminateBrowserProcess();
      await vi.runAllTimersAsync();
      await termination;
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
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

  it('rolls back input-triggered navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'https://example.com/form';
    const locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-input';
      }),
      type: vi.fn(async () => {}),
    };
    const fakePage = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Form', 'https://example.com/form');

    await expect(
      session._input_text_element_node(
        { xpath: '/html/body/input' } as any,
        'submit'
      )
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('does not input text after a click navigates to a disallowed URL', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'https://example.com/form';
    const elementHandle = {
      click: vi.fn(async () => {
        pageUrl = 'https://evil.test/credential-field';
      }),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const locator = {
      elementHandle: vi.fn(async () => elementHandle),
    };
    const fakePage = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Form', 'https://example.com/form');

    await expect(
      session._input_text_element_node(
        { xpath: '/html/body/input' } as any,
        'super-secret-value'
      )
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(elementHandle.fill).not.toHaveBeenCalled();
    expect(elementHandle.type).not.toHaveBeenCalled();
    expect(elementHandle.dispose).toHaveBeenCalledTimes(1);
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
  });

  it('does not re-resolve an input locator after the document changes', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const originalHandle = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {
        throw new Error('Execution context was destroyed');
      }),
      dispose: vi.fn(async () => {}),
    };
    const replacementHandle = {
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const locator = {
      elementHandle: vi
        .fn()
        .mockResolvedValueOnce(originalHandle)
        .mockResolvedValueOnce(replacementHandle),
    };
    const documentHandle = { dispose: vi.fn(async () => {}) };
    const fakePage = {
      evaluateHandle: vi.fn(async () => documentHandle),
      evaluate: vi.fn(async () => {
        throw new Error('JSHandles can be evaluated only in their context');
      }),
    } as any;
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    vi.spyOn(session, 'validate_page_after_action').mockResolvedValue();

    await expect(
      session._input_text_element_node(
        { xpath: '/html/body/input' } as any,
        'super-secret-value'
      )
    ).rejects.toThrow('page document changed');

    expect(locator.elementHandle).toHaveBeenCalledTimes(1);
    expect(originalHandle.fill).not.toHaveBeenCalled();
    expect(replacementHandle.fill).not.toHaveBeenCalled();
    expect(originalHandle.dispose).toHaveBeenCalledTimes(1);
    expect(documentHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('rolls back upload-triggered navigation to disallowed URLs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-nav-'));
    const uploadPath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(uploadPath, 'upload');
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
        }),
      });
      let pageUrl = 'https://example.com/upload';
      const locator = {
        setInputFiles: vi.fn(async () => {
          pageUrl = 'https://evil.test/from-upload';
        }),
      };
      const fakePage = {
        url: vi.fn(() => pageUrl),
        title: vi.fn(async () => pageUrl),
        waitForLoadState: vi.fn(async () => {}),
        goto: vi.fn(async (url: string) => {
          pageUrl = url;
        }),
      } as any;
      vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
      vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
      session.update_current_page(
        fakePage,
        'Upload',
        'https://example.com/upload'
      );

      await expect(
        session.upload_file({ xpath: '/html/body/input' } as any, uploadPath)
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(fakePage.goto).toHaveBeenCalledWith(
        'about:blank',
        expect.objectContaining({ waitUntil: 'load' })
      );
      expect(session.active_tab?.url).toBe('about:blank');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
      if (process.platform !== 'win32') {
        expect(fs.statSync(downloadPath as string).mode & 0o777).toBe(0o600);
      }
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

  it('rolls back click downloads that settle on disallowed URLs', async () => {
    const downloadsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bu-click-dl-blocked-')
    );
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
          downloads_path: downloadsDir,
        }),
      });
      let pageUrl = 'https://example.com/download';
      const locator = {
        click: vi.fn(async () => {
          pageUrl = 'https://evil.test/from-download?token=secret';
        }),
      };
      const fakeDownload = {
        suggestedFilename: () => 'report.csv',
        url: () => 'https://example.com/report.csv',
        saveAs: vi.fn(async (targetPath: string) => {
          fs.writeFileSync(targetPath, 'abc');
        }),
      };
      const fakePage = {
        goto: vi.fn(async (url: string) => {
          pageUrl = url;
        }),
        title: vi.fn(async () => pageUrl),
        url: vi.fn(() => pageUrl),
        waitForEvent: vi.fn(async () => fakeDownload),
        waitForLoadState: vi.fn(async () => {}),
      };

      vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
      vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage as any);
      session.update_current_page(
        fakePage as any,
        'Download',
        'https://example.com/download'
      );

      await expect(
        session._click_element_node({ xpath: '/html/body/a[1]' } as any)
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(fakePage.goto).toHaveBeenCalledWith(
        'about:blank',
        expect.objectContaining({ waitUntil: 'load' })
      );
      expect(session.active_tab?.url).toBe('about:blank');
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('blocks element click downloads from disallowed download URLs before saving', async () => {
    const downloadsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bu-click-dl-url-blocked-')
    );
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
          downloads_path: downloadsDir,
        }),
      });
      let pageUrl = 'https://example.com/download';
      const locator = {
        click: vi.fn(async () => {}),
      };
      const fakeDownload = {
        cancel: vi.fn(async () => {}),
        suggestedFilename: () => 'report.csv',
        url: () => 'https://evil.test/report.csv?token=secret',
        saveAs: vi.fn(async (targetPath: string) => {
          fs.writeFileSync(targetPath, 'abc');
        }),
      };
      const fakePage = {
        goto: vi.fn(async (url: string) => {
          pageUrl = url;
        }),
        title: vi.fn(async () => pageUrl),
        url: vi.fn(() => pageUrl),
        waitForEvent: vi.fn(async () => fakeDownload),
        waitForLoadState: vi.fn(async () => {}),
      };

      vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
      vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage as any);
      session.update_current_page(
        fakePage as any,
        'Download',
        'https://example.com/download'
      );

      await expect(
        session._click_element_node({ xpath: '/html/body/a[1]' } as any)
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(fakeDownload.saveAs).not.toHaveBeenCalled();
      expect(fakeDownload.cancel).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(downloadsDir)).toEqual([]);
      expect(session.active_tab?.url).toBe('https://example.com/download');
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

  it('perform_click rolls back failed clicks that reached disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        downloads_path: null,
      }),
    });

    let pageUrl = 'https://example.com/start';
    const elementHandle = {
      click: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-failed-perform-click?token=secret';
        throw new Error('element is not clickable');
      }),
    };
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForEvent: vi.fn(() => new Promise(() => {})),
      waitForLoadState: vi.fn(async () => {}),
    } as any;
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      elementHandle as any
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Start', 'https://example.com/start');

    await expect(
      session.perform_click({ xpath: '/html/body/button[1]' } as any)
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
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

  it('rolls back perform_click navigations to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        downloads_path: null,
      }),
    });

    let pageUrl = 'https://example.com/current';
    const elementHandle = {
      click: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-click';
      }),
    };
    const fakePage = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Current'),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      waitForEvent: vi.fn(async () => {
        const error = new Error('Timeout 5000ms exceeded');
        error.name = 'TimeoutError';
        throw error;
      }),
      waitForLoadState: vi.fn(async () => {}),
    } as any;

    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      elementHandle as any
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);

    await expect(
      session.perform_click({ xpath: '/html/body/a[1]' } as any)
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
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
      if (process.platform !== 'win32') {
        expect(fs.statSync(downloadsPath).mode & 0o777).toBe(0o700);
        expect(fs.statSync(savedPath as string).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps suggested download filenames inside downloads_path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perform-click-'));
    const downloadsPath = path.join(tempRoot, 'downloads');
    const profile = new BrowserProfile({
      downloads_path: downloadsPath,
    });
    const session = new BrowserSession({
      browser_profile: profile,
    });

    const fakeDownload = {
      suggestedFilename: () => '../../outside.txt',
      url: () => 'https://example.com/download',
      saveAs: vi.fn(async (targetPath: string) => {
        fs.writeFileSync(targetPath, 'safe');
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
      const savedPath = (await session.perform_click({
        xpath: '/html/body/a[1]',
      } as any)) as string;

      const relativePath = path.relative(
        path.resolve(downloadsPath),
        path.resolve(savedPath)
      );
      expect(relativePath).toBe('outside.txt');
      expect(relativePath.startsWith('..')).toBe(false);
      expect(path.isAbsolute(relativePath)).toBe(false);
      expect(path.basename(savedPath)).toBe('outside.txt');
      expect(fs.existsSync(path.join(tempRoot, 'outside.txt'))).toBe(false);
      expect(fs.existsSync(savedPath)).toBe(true);
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

  it('rolls back aborted same-tab navigations that reached disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'about:blank';
    const abortError = new Error('Operation aborted');
    abortError.name = 'AbortError';
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        if (url === 'about:blank') {
          pageUrl = 'about:blank';
          return;
        }
        pageUrl = 'https://evil.test/aborted';
        throw abortError;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Blocked Page'),
    } as any;

    session.update_current_page(fakePage, 'about:blank', 'about:blank');
    (session as any).initialized = true;

    await expect(
      session.navigate_to('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
    expect(pageUrl).toBe('about:blank');
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

  it('skips the network readiness budget for same-document navigation', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    let pageUrl = 'https://example.com/page#first';
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Anchored Page'),
    } as any;
    const waitForStableNetwork = vi.spyOn(
      session as any,
      '_waitForStableNetwork'
    );

    session.update_current_page(fakePage, 'Anchored Page', pageUrl);
    (session as any).initialized = true;

    await session.navigate_to('https://example.com/page#second');

    expect(waitForStableNetwork).not.toHaveBeenCalled();
    expect(session.active_tab?.url).toBe('https://example.com/page#second');
  });

  it('keeps a background page readiness timeout isolated from active-page navigation', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    let activeUrl = 'https://example.com/active';
    const activePage = {
      goto: vi.fn(async (url: string) => {
        activeUrl = url;
      }),
      url: vi.fn(() => activeUrl),
      title: vi.fn(async () => 'Active Page'),
    } as any;
    const timeoutError = new Error('Timeout 25ms exceeded');
    timeoutError.name = 'TimeoutError';
    const backgroundPage = {
      waitForLoadState: vi.fn(async () => {
        throw timeoutError;
      }),
    } as any;

    session.update_current_page(activePage, 'Active Page', activeUrl);
    (session as any).initialized = true;

    await (session as any)._waitForLoad(backgroundPage, 25);
    await session.navigate_to('https://example.com/active-next');

    expect((session as any).currentPageLoadingStatus).toBeNull();
    expect((session as any)._getPageLoadingStatus(backgroundPage)).toContain(
      'timed out after 25ms'
    );
    expect((session as any)._getPageLoadingStatus(activePage)).toBeNull();
  });

  it('refreshes readiness state when browser-page synchronization replaces the active page', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const oldPage = {
      url: vi.fn(() => 'https://example.com/old'),
      on: vi.fn(),
    } as any;
    const replacementPage = {
      url: vi.fn(() => 'https://example.com/replacement'),
      on: vi.fn(),
    } as any;

    session.update_current_page(oldPage, 'Old page', 'https://example.com/old');
    (session as any)._setPageLoadingStatus(
      oldPage,
      'document',
      'OLD PAGE TIMEOUT'
    );
    session.browser_context = {
      pages: () => [replacementPage],
    } as any;

    (session as any)._syncTabsWithBrowserPages();

    expect(session.agent_current_page).toBe(replacementPage);
    expect((session as any).currentPageLoadingStatus).toBeNull();
    expect((session as any)._getPageLoadingStatus(oldPage)).toBe(
      'OLD PAGE TIMEOUT'
    );
    expect((session as any)._getPageLoadingStatus(replacementPage)).toBeNull();
  });

  it('exposes DOM readiness timeouts through loading_status', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const timeoutError = new Error('Timeout 50ms exceeded');
    timeoutError.name = 'TimeoutError';
    const fakePage = {
      url: vi.fn(() => 'about:blank'),
      title: vi.fn(async () => 'Blank'),
      waitForLoadState: vi.fn(async () => {
        throw timeoutError;
      }),
    } as any;

    session.update_current_page(fakePage, 'Blank', 'about:blank');
    (session as any).initialized = true;
    vi.spyOn(session, 'take_screenshot').mockResolvedValue(null);

    await (session as any)._waitForLoad(fakePage, 50);
    const state = await session.get_minimal_state_summary();

    expect(state.loading_status).toContain('timed out after 50ms');
    expect(state.loading_status).toContain('DOMContentLoaded');
  });

  it('exposes stalled resource waits through loading_status', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        maximum_wait_page_load_time: 0,
      }),
    });
    const stalledRequest = {
      resourceType: vi.fn(() => 'document'),
      url: vi.fn(() => 'https://example.com/stalled.js'),
      headers: vi.fn(() => ({})),
    };
    const fakePage = {
      url: vi.fn(() => 'https://example.com/stalled'),
      title: vi.fn(async () => 'Stalled Page'),
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        if (event === 'request') {
          listener(stalledRequest);
        }
      }),
      off: vi.fn(),
    } as any;

    session.update_current_page(
      fakePage,
      'Stalled Page',
      'https://example.com/stalled'
    );
    (session as any).initialized = true;
    vi.spyOn(session, 'take_screenshot').mockResolvedValue(null);

    await (session as any)._waitForStableNetwork(fakePage);
    const state = await session.get_minimal_state_summary();

    expect(state.loading_status).toContain('with 1 pending network requests');
    expect(state.loading_status).toContain('use the wait action');
    expect(fakePage.off).toHaveBeenCalledTimes(2);
  });

  it('rolls back same-tab redirects to disallowed final URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'about:blank';
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        pageUrl =
          url === 'about:blank' ? 'about:blank' : 'https://evil.test/final';
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Blocked Page'),
    } as any;

    session.update_current_page(fakePage, 'about:blank', 'about:blank');
    (session as any).initialized = true;

    await expect(
      session.navigate_to('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
    expect(pageUrl).toBe('about:blank');
  });

  it('rolls back same-tab navigation errors that already reached disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'about:blank';
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        if (url === 'about:blank') {
          pageUrl = 'about:blank';
          return;
        }
        pageUrl = 'https://evil.test/after-timeout';
        throw new Error('Navigation timeout');
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Blocked Page'),
    } as any;

    session.update_current_page(fakePage, 'about:blank', 'about:blank');
    (session as any).initialized = true;

    await expect(
      session.navigate_to('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
    expect(pageUrl).toBe('about:blank');
  });

  it('replaces current tab when disallowed rollback cannot load about:blank', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let blockedPageUrl = 'about:blank';
    const blockedPage = {
      goto: vi.fn(async (url: string) => {
        if (url === 'about:blank') {
          throw new Error('rollback failed');
        }
        blockedPageUrl = 'https://evil.test/stuck';
        throw new Error('Navigation timeout');
      }),
      url: vi.fn(() => blockedPageUrl),
      title: vi.fn(async () => 'Blocked Page'),
      close: vi.fn(async () => {}),
    } as any;
    let replacementUrl = 'about:blank';
    const replacementPage = {
      goto: vi.fn(async (url: string) => {
        replacementUrl = url;
      }),
      url: vi.fn(() => replacementUrl),
      title: vi.fn(async () => 'Blank Page'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    let replacementCreated = false;
    const browserContext = {
      newPage: vi.fn(async () => {
        replacementCreated = true;
        return replacementPage;
      }),
      pages: vi.fn(() =>
        replacementCreated ? [replacementPage] : [blockedPage]
      ),
    } as any;

    session.update_current_page(blockedPage, 'about:blank', 'about:blank');
    (session as any).browser_context = browserContext;
    (session as any).initialized = true;

    await expect(
      session.navigate_to('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(blockedPage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(browserContext.newPage).toHaveBeenCalledTimes(1);
    expect(replacementPage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(blockedPage.close).toHaveBeenCalledTimes(1);
    expect((session as any).agent_current_page).toBe(replacementPage);
    expect((session as any).human_current_page).toBe(replacementPage);
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('redacts blocked URL query and hash in URLNotAllowedError and recent events', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let caught: unknown = null;
    try {
      (session as any)._assert_url_allowed(
        'https://evil.test/path?token=secret#fragment'
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(URLNotAllowedError);
    expect((caught as Error).message).toContain(
      'https://evil.test/path?<redacted>#<redacted>'
    );
    expect((caught as Error).message).not.toContain('secret');
    const recentEvents = (session as any)._getRecentEventsSummary(10);
    expect(recentEvents).toContain(
      'https://evil.test/path?<redacted>#<redacted>'
    );
    expect(recentEvents).not.toContain('secret');
  });

  it('redacts allowed URL query and hash in recent browser events', () => {
    const session = new BrowserSession();

    (session as any)._recordRecentEvent('navigation_completed', {
      url: 'https://example.com/path?token=secret#fragment',
      error_message:
        'Failed while fetching https://example.com/path?token=secret#fragment',
    });

    const recentEvents = (session as any)._getRecentEventsSummary(10);
    expect(recentEvents).toContain(
      'https://example.com/path?<redacted>#<redacted>'
    );
    expect(recentEvents).not.toContain('secret');
    expect(recentEvents).not.toContain('#fragment');
  });

  it('rolls back history navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/current';
    const fakePage = {
      goBack: vi.fn(async () => {
        pageUrl = 'https://evil.test/history';
      }),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Current'),
    } as any;

    vi.spyOn(session as any, '_waitForStableNetwork').mockResolvedValue(
      undefined
    );
    session.update_current_page(
      fakePage,
      'Current',
      'https://example.com/current'
    );
    (session as any).initialized = true;

    await expect(session.go_back()).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
    expect(pageUrl).toBe('about:blank');
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

  it('rolls back click-triggered navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/start';
    const fakePage = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const locator = {
      click: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-click';
      }),
    };

    session.update_current_page(fakePage, 'Start', 'https://example.com/start');
    (session as any).initialized = true;
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);

    await expect(
      session._click_element_node({ xpath: '/html/body/a[1]' } as any)
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('blocks element clicks when the current page is already disallowed', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://evil.test/pre-click?token=secret';
    const fakePage = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      locator: vi.fn(() => ({
        count: vi.fn(async () => 1),
        click: vi.fn(async () => {}),
      })),
      on: vi.fn(),
      off: vi.fn(),
    } as any;

    session.update_current_page(fakePage, 'Blocked', pageUrl);

    await expect(
      session._click_element_node({ xpath: '/html/body/button[1]' } as any)
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.locator).not.toHaveBeenCalled();
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back keyboard-triggered navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/form';
    const fakePage = {
      keyboard: {
        press: vi.fn(async () => {
          pageUrl = 'https://evil.test/from-enter';
        }),
      },
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Form', 'https://example.com/form');

    await expect(session.send_keys('Enter')).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('blocks keyboard input when the current page is already disallowed', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://evil.test/pre-keyboard?token=secret';
    const press = vi.fn(async () => {});
    const fakePage = {
      keyboard: { press },
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Blocked', pageUrl);

    await expect(session.send_keys('Enter')).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(press).not.toHaveBeenCalled();
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back coordinate click navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/map';
    const fakePage = {
      mouse: {
        click: vi.fn(async () => {
          pageUrl = 'https://evil.test/from-coordinate';
        }),
      },
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Map', 'https://example.com/map');

    await expect(session.click_coordinates(10, 20)).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back failed coordinate clicks that reached disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/map';
    const fakePage = {
      mouse: {
        click: vi.fn(async () => {
          pageUrl = 'https://evil.test/from-failed-coordinate?token=secret';
          throw new Error('click failed');
        }),
      },
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Map', 'https://example.com/map');

    await expect(session.click_coordinates(10, 20)).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back scroll-triggered navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/list';
    const fakePage = {
      evaluate: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-scroll?token=secret';
        return true;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'List', 'https://example.com/list');

    await expect(
      session.scroll('down', 100, {
        node: { xpath: '/html/body/div[1]' } as any,
      })
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('maps scroll directions to container pixel deltas (positive = down)', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const fakePage = {
      evaluate: vi.fn(async () => false),
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Example'),
      waitForLoadState: vi.fn(async () => {}),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(fakePage, 'Example', 'https://example.com');
    const scrollContainerSpy = vi
      .spyOn(session as any, '_scrollContainer')
      .mockResolvedValue(undefined);

    await session.scroll('down', 100);
    expect(scrollContainerSpy).toHaveBeenLastCalledWith(100);

    await session.scroll('up', 250);
    expect(scrollContainerSpy).toHaveBeenLastCalledWith(-250);
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

  it('rolls back switching to an existing disallowed tab', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    const pageA = {
      bringToFront: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Allowed'),
    } as any;
    let pageBUrl = 'https://evil.test/preexisting?token=secret';
    const pageB = {
      bringToFront: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      url: vi.fn(() => pageBUrl),
      title: vi.fn(async () => pageBUrl),
      goto: vi.fn(async (url: string) => {
        pageBUrl = url;
      }),
    } as any;

    (session as any)._tabs = [
      {
        page_id: 0,
        tab_id: 'tab-0',
        url: 'https://example.com',
        title: 'Allowed',
      },
      {
        page_id: 1,
        tab_id: 'tab-1',
        url: 'https://evil.test/preexisting?token=secret',
        title: 'Blocked',
      },
    ];
    (session as any).tabPages.set(0, pageA);
    (session as any).tabPages.set(1, pageB);
    (session as any).currentTabIndex = 0;

    await expect(session.switch_to_tab('tab-1')).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(pageB.bringToFront).toHaveBeenCalledTimes(1);
    expect(pageB.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back disallowed current pages before building browser state', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'https://evil.test/state?token=secret';
    const page = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    session.update_current_page(page, 'Blocked', pageUrl);
    (session as any).initialized = true;

    await expect(
      session.get_browser_state_with_recovery({ include_screenshot: true })
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(page.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('captures viewport-sized screenshots for routine browser state', async () => {
    const element = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      {},
      [new DOMTextNode(true, null, 'Continue')]
    );
    element.highlight_index = 1;
    const domState = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, [element]),
      { 1: element }
    );
    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockResolvedValue(domState);
    const screenshot = vi.fn(async () => Buffer.from('viewport screenshot'));
    const page = {
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Allowed'),
      waitForLoadState: vi.fn(async () => {}),
      screenshot,
      evaluate: vi.fn(async () => ({
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        pageWidth: 1280,
        pageHeight: 1_000_000,
      })),
    } as any;
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    session.update_current_page(page, 'Allowed', 'https://example.com');
    (session as any).initialized = true;

    try {
      await session.get_browser_state_with_recovery({
        include_screenshot: true,
      });

      expect(screenshot).toHaveBeenCalledWith({
        type: 'png',
        fullPage: false,
      });
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('rolls back disallowed current pages before legacy state summary reads', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'https://evil.test/legacy-state?token=secret';
    const page = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => pageUrl),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      evaluate: vi.fn(async () => ({ secret: true })),
      screenshot: vi.fn(async () => Buffer.from('secret screenshot')),
    } as any;
    session.update_current_page(page, 'Blocked', pageUrl);

    await expect(session.get_state_summary()).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('does not return browser state after page becomes disallowed during state collection', async () => {
    const secretNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      {},
      [new DOMTextNode(true, null, 'Secret button')]
    );
    secretNode.highlight_index = 1;
    const secretDom = new DOMState(
      new DOMElementNode(true, null, 'body', '/html/body', {}, [secretNode]),
      { 1: secretNode }
    );
    let pageUrl = 'https://example.com/start';
    const clickableSpy = vi
      .spyOn(DomService.prototype, 'get_clickable_elements')
      .mockImplementation(async () => {
        pageUrl = 'https://evil.test/state-after-dom?token=secret';
        return secretDom;
      });

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    const page = {
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Allowed'),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      waitForLoadState: vi.fn(async () => {}),
      screenshot: vi.fn(async () => Buffer.from('secret screenshot')),
      evaluate: vi.fn(async () => ({
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        pageWidth: 1280,
        pageHeight: 720,
      })),
    } as any;
    session.update_current_page(page, 'Allowed', pageUrl);
    (session as any).initialized = true;

    try {
      await expect(
        session.get_browser_state_with_recovery({ include_screenshot: true })
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(page.goto).toHaveBeenCalledWith(
        'about:blank',
        expect.objectContaining({ waitUntil: 'load' })
      );
      expect(page.screenshot).not.toHaveBeenCalled();
      expect(page.evaluate).not.toHaveBeenCalled();
      expect(session.active_tab?.url).toBe('about:blank');
    } finally {
      clickableSpy.mockRestore();
    }
  });

  it('redacts disallowed background tabs in exposed tab lists', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    const pageA = {
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Allowed'),
      on: vi.fn(),
    } as any;
    const pageB = {
      url: vi.fn(() => 'https://evil.test/private?token=secret'),
      title: vi.fn(async () => 'Secret title'),
      on: vi.fn(),
    } as any;
    session.update_current_page(pageA, 'Allowed', 'https://example.com');
    (session as any)._tabs = [
      {
        page_id: 0,
        tab_id: 'tab-0',
        url: 'https://example.com',
        title: 'Allowed',
      },
      {
        page_id: 1,
        tab_id: 'tab-1',
        url: 'https://evil.test/private?token=secret',
        title: 'Secret title',
      },
    ];
    (session as any).tabPages.set(0, pageA);
    (session as any).tabPages.set(1, pageB);
    (session as any).currentTabIndex = 0;
    (session as any).browser_context = {
      pages: () => [pageA, pageB],
    };

    const builtTabs = (session as any)._buildTabs();
    const tabsInfo = await session.get_tabs_info();

    expect(JSON.stringify(builtTabs)).not.toContain('evil.test');
    expect(JSON.stringify(builtTabs)).not.toContain('secret');
    expect(builtTabs[1]).toMatchObject({
      page_id: 1,
      tab_id: 'tab-1',
      url: 'about:blank',
      title: 'blocked by domain policy',
    });
    expect(JSON.stringify(tabsInfo)).not.toContain('evil.test');
    expect(JSON.stringify(tabsInfo)).not.toContain('secret');
    expect(tabsInfo[1]).toMatchObject({
      page_id: 1,
      tab_id: 'tab-1',
      url: 'about:blank',
      title: 'blocked by domain policy',
    });
    expect(pageB.title).not.toHaveBeenCalled();
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

  it('create_new_tab restores previous tab on aborted navigation', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const abortError = new Error('Operation aborted');
    abortError.name = 'AbortError';
    const existingPage = {
      url: vi.fn(() => 'https://current.test'),
      title: vi.fn(async () => 'Current'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const abortingPage = {
      goto: vi.fn(async () => {
        throw abortError;
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
      newPage: vi.fn(async () => abortingPage),
      pages: vi.fn(() => [existingPage]),
    } as any;
    (session as any).initialized = true;

    await expect(
      session.create_new_tab('https://slow.test')
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(session.tabs).toHaveLength(1);
    expect(session.active_tab?.url).toBe('https://current.test');
    expect(abortingPage.close).toHaveBeenCalledTimes(1);
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

  it('rolls back forward navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/current';
    const fakePage = {
      goForward: vi.fn(async () => {
        pageUrl = 'https://evil.test/forward';
      }),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Current'),
    } as any;

    vi.spyOn(session as any, '_waitForStableNetwork').mockResolvedValue(
      undefined
    );
    session.update_current_page(
      fakePage,
      'Current',
      'https://example.com/current'
    );
    (session as any).initialized = true;

    await expect(session.go_forward()).rejects.toBeInstanceOf(
      URLNotAllowedError
    );
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back refresh navigation to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/current';
    const fakePage = {
      reload: vi.fn(async () => {
        pageUrl = 'https://evil.test/refresh';
      }),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Current'),
    } as any;

    vi.spyOn(session as any, '_waitForStableNetwork').mockResolvedValue(
      undefined
    );
    session.update_current_page(
      fakePage,
      'Current',
      'https://example.com/current'
    );
    (session as any).initialized = true;

    await expect(session.refresh()).rejects.toBeInstanceOf(URLNotAllowedError);
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('does not reopen disallowed URLs during crash recovery', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    const newPage = vi.fn(async () => ({
      goto: vi.fn(async () => {}),
    }));
    session.browser_context = {
      newPage,
    } as any;

    const reopened = await (session as any)._tryReopenUrl(
      'https://evil.test/crashed',
      1000
    );

    expect(reopened).toBe(false);
    expect(newPage).not.toHaveBeenCalled();
  });

  it('closes crash recovery pages that redirect to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'about:blank';
    const page = {
      goto: vi.fn(async (url: string) => {
        pageUrl =
          url === 'https://example.com/crashed'
            ? 'https://evil.test/recovered?token=secret'
            : url;
      }),
      url: vi.fn(() => pageUrl),
      close: vi.fn(async () => {}),
      setViewportSize: vi.fn(async () => {}),
    };
    session.browser_context = {
      newPage: vi.fn(async () => page),
    } as any;
    const warningSpy = vi
      .spyOn(session.logger, 'warning')
      .mockImplementation(() => undefined);

    try {
      const reopened = await (session as any)._tryReopenUrl(
        'https://example.com/crashed',
        1000
      );

      expect(reopened).toBe(false);
      expect(page.goto).toHaveBeenCalledWith(
        'about:blank',
        expect.objectContaining({ waitUntil: 'load' })
      );
      expect(page.close).toHaveBeenCalledTimes(1);
      expect(session.agent_current_page).toBeNull();
      const logs = warningSpy.mock.calls.flat().join('\n');
      expect(logs).toContain('https://evil.test/recovered?<redacted>');
      expect(logs).not.toContain('token=secret');
    } finally {
      warningSpy.mockRestore();
    }
  });

  it('redacts crash recovery URLs before logging', async () => {
    const session = new BrowserSession();
    const rawUrl = 'https://example.com/crashed?token=abc#section';
    const newPage = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => rawUrl),
      setViewportSize: vi.fn(async () => {}),
    };
    session.browser_context = {
      newPage: vi.fn(async () => newPage),
    } as any;
    vi.spyOn(session as any, '_isPageResponsive').mockResolvedValue(true);
    const debugSpy = vi
      .spyOn(session.logger, 'debug')
      .mockImplementation(() => undefined);
    const infoSpy = vi
      .spyOn(session.logger, 'info')
      .mockImplementation(() => undefined);

    try {
      const reopened = await (session as any)._tryReopenUrl(rawUrl, 1000);

      expect(reopened).toBe(true);
      const logs = [...debugSpy.mock.calls, ...infoSpy.mock.calls]
        .flat()
        .join('\n');
      expect(logs).toContain(
        'https://example.com/crashed?<redacted>#<redacted>'
      );
      expect(logs).not.toContain('token=abc');
      expect(logs).not.toContain('#section');
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('redacts tab visibility URLs before logging', async () => {
    const session = new BrowserSession();
    const debugSpy = vi
      .spyOn(session.logger, 'debug')
      .mockImplementation(() => undefined);
    const page = {
      evaluate: vi.fn(async () => true),
      url: vi.fn(() => 'https://example.com/visible?token=abc#section'),
    } as any;

    try {
      (session as any)._onTabVisibilityChange(page);
      await Promise.resolve();
      await Promise.resolve();

      const logs = debugSpy.mock.calls.flat().join('\n');
      expect(logs).toContain(
        'https://example.com/visible?<redacted>#<redacted>'
      );
      expect(logs).not.toContain('token=abc');
      expect(logs).not.toContain('#section');
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('rolls back JavaScript navigations to disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/current';
    const fakePage = {
      evaluate: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-eval';
        return 'navigated';
      }),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      url: vi.fn(() => pageUrl),
      title: vi.fn(async () => 'Current'),
    } as any;
    session.update_current_page(
      fakePage,
      'Current',
      'https://example.com/current'
    );

    await expect(
      session.execute_javascript('window.location.href = "https://evil.test"')
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back disallowed URLs reached while waiting', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://evil.test/from-wait?token=secret';
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
    } as any;
    session.update_current_page(
      fakePage,
      'Current',
      'https://example.com/current'
    );

    await expect(session.wait(0.001)).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('rolls back disallowed URLs reached while waiting for elements', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/current';
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-wait-selector?token=secret';
      }),
    } as any;
    session.update_current_page(
      fakePage,
      'Current',
      'https://example.com/current'
    );

    await expect(session.wait_for_element('#app', 1)).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('blocks HTML reads from disallowed current pages', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://evil.test/html?token=secret';
    const fakePage = {
      content: vi.fn(async () => '<html>secret</html>'),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
    } as any;
    session.update_current_page(fakePage, 'HTML', 'https://example.com/start');

    await expect(session.get_page_html()).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.content).not.toHaveBeenCalled();
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
  });

  it('blocks screenshots from disallowed current pages', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://evil.test/screenshot?token=secret';
    const fakePage = {
      bringToFront: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
    } as any;
    session.update_current_page(
      fakePage,
      'Screenshot',
      'https://example.com/start'
    );

    await expect(session.take_screenshot()).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.bringToFront).not.toHaveBeenCalled();
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
  });

  it('closes new tabs that settle on disallowed redirect URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let newPageUrl = 'about:blank';
    const existingPage = {
      url: vi.fn(() => 'https://example.com/current'),
      title: vi.fn(async () => 'Current'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const newPage = {
      goto: vi.fn(async () => {
        newPageUrl = 'https://example.com/intermediate';
      }),
      url: vi.fn(() => newPageUrl),
      title: vi.fn(async () => 'Redirected'),
      close: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    } as any;

    session.update_current_page(
      existingPage,
      'Current',
      'https://example.com/current'
    );
    (session as any).browser_context = {
      newPage: vi.fn(async () => newPage),
      pages: vi.fn(() => [existingPage, newPage]),
    } as any;
    (session as any).initialized = true;
    vi.spyOn(session as any, '_waitForStableNetwork').mockImplementation(
      async () => {
        newPageUrl = 'https://evil.test/final';
      }
    );

    await expect(
      session.create_new_tab('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(newPage.close).toHaveBeenCalledTimes(1);
    expect(session.tabs).toHaveLength(1);
    expect(session.active_tab?.url).toBe('https://example.com/current');
  });

  it('closes new tabs whose failed navigation already reached disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let newPageUrl = 'about:blank';
    const existingPage = {
      url: vi.fn(() => 'https://example.com/current'),
      title: vi.fn(async () => 'Current'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const newPage = {
      goto: vi.fn(async (url: string) => {
        if (url === 'about:blank') {
          newPageUrl = 'about:blank';
          return;
        }
        newPageUrl = 'https://evil.test/after-timeout';
        throw new Error('Navigation timeout');
      }),
      url: vi.fn(() => newPageUrl),
      title: vi.fn(async () => 'Redirected'),
      close: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    } as any;

    session.update_current_page(
      existingPage,
      'Current',
      'https://example.com/current'
    );
    (session as any).browser_context = {
      newPage: vi.fn(async () => newPage),
      pages: vi.fn(() => [existingPage, newPage]),
    } as any;
    (session as any).initialized = true;

    await expect(
      session.create_new_tab('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(newPage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(newPage.close).toHaveBeenCalledTimes(1);
    expect(session.tabs).toHaveLength(1);
    expect(session.active_tab?.url).toBe('https://example.com/current');
  });

  it('closes aborted new tabs that already reached disallowed URLs', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    const abortError = new Error('Operation aborted');
    abortError.name = 'AbortError';
    let newPageUrl = 'about:blank';
    const existingPage = {
      url: vi.fn(() => 'https://example.com/current'),
      title: vi.fn(async () => 'Current'),
      on: vi.fn(),
      off: vi.fn(),
    } as any;
    const newPage = {
      goto: vi.fn(async (url: string) => {
        if (url === 'about:blank') {
          newPageUrl = 'about:blank';
          return;
        }
        newPageUrl = 'https://evil.test/aborted';
        throw abortError;
      }),
      url: vi.fn(() => newPageUrl),
      title: vi.fn(async () => 'Redirected'),
      close: vi.fn(async () => {}),
      on: vi.fn(),
      off: vi.fn(),
    } as any;

    session.update_current_page(
      existingPage,
      'Current',
      'https://example.com/current'
    );
    (session as any).browser_context = {
      newPage: vi.fn(async () => newPage),
      pages: vi.fn(() => [existingPage, newPage]),
    } as any;
    (session as any).initialized = true;

    await expect(
      session.create_new_tab('https://example.com/start')
    ).rejects.toBeInstanceOf(URLNotAllowedError);

    expect(newPage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(newPage.close).toHaveBeenCalledTimes(1);
    expect(session.tabs).toHaveLength(1);
    expect(session.active_tab?.url).toBe('https://example.com/current');
    expect(newPageUrl).toBe('about:blank');
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

    const oversizedDialog = {
      type: () => 'alert',
      message: () => 'x'.repeat(100_000),
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    };
    await dialogHandler?.(oversizedDialog);
    const captured = (session as any)._closedPopupMessages.at(-1) as string;
    expect(captured.length).toBeLessThanOrEqual(8 * 1024 + '[alert] '.length);
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

  it('rolls back disallowed current pages before building minimal state', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'https://evil.test/minimal?token=secret';
    const fakePage = {
      url: () => pageUrl,
      title: vi.fn(async () => pageUrl),
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
    } as any;
    session.update_current_page(fakePage, 'Blocked', pageUrl);
    (session as any).initialized = true;

    await expect(session.get_minimal_state_summary()).rejects.toBeInstanceOf(
      URLNotAllowedError
    );

    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
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

  it('rolls back disallowed navigations from highlight cleanup callbacks', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });

    let pageUrl = 'https://example.com/start';
    const previousWindow = (globalThis as any).window;
    const previousDocument = (globalThis as any).document;
    const fakeWindow = {
      _highlightCleanupFunctions: [
        () => {
          pageUrl = 'https://evil.test/from-highlight-cleanup?token=secret';
        },
      ],
    } as any;
    const fakeDocument = {
      querySelectorAll: vi.fn(() => []),
    } as any;
    const fakePage = {
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
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
    } as any;

    session.update_current_page(fakePage, 'Start', 'https://example.com/start');

    await expect(session.remove_highlights()).rejects.toBeInstanceOf(
      URLNotAllowedError
    );
    expect(fakePage.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
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
    const firstLaunchArgs = launch.mock.calls[0]?.[0]?.args as string[];
    const firstLaunchToken = firstLaunchArgs.find((arg) =>
      arg.startsWith('--browser-use-session-token=')
    );
    expect(firstLaunchToken).toBeTruthy();
    expect(secondLaunchOptions?.args as string[]).toContain(firstLaunchToken);

    await session.stop();
  });

  it('perform_click blocks disallowed download URLs before saving', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perform-click-'));
    const downloadsPath = path.join(tempRoot, 'downloads');
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
        downloads_path: downloadsPath,
      }),
    });

    let pageUrl = 'https://example.com/download';
    const fakeDownload = {
      cancel: vi.fn(async () => {}),
      suggestedFilename: () => 'report.csv',
      url: () => 'https://evil.test/report.csv?token=secret',
      saveAs: vi.fn(async (targetPath: string) => {
        fs.writeFileSync(targetPath, 'csv');
      }),
    };
    const fakePage = {
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForEvent: vi.fn(async () => fakeDownload),
      waitForLoadState: vi.fn(async () => {}),
    } as any;
    const elementHandle = {
      click: vi.fn(async () => {}),
    };

    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      elementHandle as any
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.update_current_page(
      fakePage,
      'Download',
      'https://example.com/download'
    );

    try {
      await expect(
        session.perform_click({ xpath: '/html/body/a[1]' } as any)
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(fakeDownload.saveAs).not.toHaveBeenCalled();
      expect(fakeDownload.cancel).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(downloadsPath)).toEqual([]);
      expect(session.active_tab?.url).toBe('https://example.com/download');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
      if (process.platform !== 'win32') {
        expect(fs.statSync(downloadedPath!).mode & 0o777).toBe(0o600);
      }
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

      const evaluate = vi.fn(async (_fn: unknown, _url: string) => ({
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

  it('redacts sensitive PDF URL parts before logging', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          downloads_path: downloadsDir,
        }),
      });
      const rawUrl =
        'https://user:pass@example.com/report.pdf?token=abc#section';
      const infoSpy = vi
        .spyOn(session.logger, 'info')
        .mockImplementation(() => undefined);
      const evaluate = vi.fn(async (_fn: unknown, _url: string) => ({
        data: [37, 80, 68, 70],
        fromCache: false,
        responseSize: 4,
      }));
      const fakePage = {
        url: () => rawUrl,
        evaluate,
      } as any;

      try {
        await (session as any)._auto_download_pdf_if_needed(fakePage);

        expect(evaluate.mock.calls[0]?.[1]).toEqual({
          pdfUrl: rawUrl,
          redirectMode: 'follow',
          maxBytes: DEFAULT_MAX_AUTO_DOWNLOAD_BYTES,
        });
        const logs = infoSpy.mock.calls.flat().join('\n');
        expect(logs).toContain(
          'https://example.com/report.pdf?<redacted>#<redacted>'
        );
        expect(logs).not.toContain('user:pass');
        expect(logs).not.toContain('token=abc');
        expect(logs).not.toContain('#section');
      } finally {
        infoSpy.mockRestore();
      }
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('blocks PDF auto-downloads from disallowed current pages before fetching bytes', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
          downloads_path: downloadsDir,
        }),
      });
      let pageUrl = 'https://evil.test/private.pdf?token=secret';
      const fakePage = {
        url: vi.fn(() => pageUrl),
        title: vi.fn(async () => pageUrl),
        goto: vi.fn(async (url: string) => {
          pageUrl = url;
        }),
        evaluate: vi.fn(async () => ({
          data: [37, 80, 68, 70],
          fromCache: false,
          responseSize: 4,
        })),
      } as any;
      session.update_current_page(fakePage, 'Blocked', pageUrl);

      await expect(
        (session as any)._auto_download_pdf_if_needed(fakePage)
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(fakePage.evaluate).not.toHaveBeenCalled();
      expect(fakePage.goto).toHaveBeenCalledWith(
        'about:blank',
        expect.objectContaining({ waitUntil: 'load' })
      );
      expect(session.get_downloaded_files()).toEqual([]);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('rejects PDF redirects while URL access restrictions are active', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })
      );
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
          downloads_path: downloadsDir,
        }),
      });
      const pdfUrl = 'https://example.com/restricted.pdf';
      const fakePage = {
        url: () => pdfUrl,
        evaluate: vi.fn(async (callback: any, argument: unknown) =>
          callback(argument)
        ),
      } as any;

      const downloadedPath = await (
        session as any
      )._auto_download_pdf_if_needed(fakePage);

      expect(downloadedPath).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledWith(pdfUrl, {
        cache: 'force-cache',
        redirect: 'error',
      });
    } finally {
      fetchSpy.mockRestore();
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized PDF responses before reading their bodies', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(), {
        status: 200,
        headers: {
          'content-length': String(DEFAULT_MAX_AUTO_DOWNLOAD_BYTES + 1),
        },
      })
    );
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          downloads_path: downloadsDir,
        }),
      });
      const pdfUrl = 'https://example.com/oversized.pdf';
      const fakePage = {
        url: () => pdfUrl,
        evaluate: vi.fn(async (callback: any, argument: unknown) =>
          callback(argument)
        ),
      } as any;

      const downloadedPath = await (
        session as any
      )._auto_download_pdf_if_needed(fakePage);

      expect(downloadedPath).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(downloadsDir)).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
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

  it('inputs text after a click replaces the field in the same document', async () => {
    await page.setContent(`
      <input
        id="input"
        type="text"
        onclick="this.replaceWith(this.cloneNode())"
      />
    `);
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(
      page.locator('#input')
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue(page);
    vi.spyOn(session, 'validate_page_after_action').mockResolvedValue();

    await session._input_text_element_node(
      { xpath: '/html/body/input' } as any,
      'safe value'
    );

    await expect(page.locator('#input').inputValue()).resolves.toBe(
      'safe value'
    );
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
  it('filters BrowserSession.get_cookies by allowed_domains by default', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    session.browser_context = {
      cookies: vi.fn(async () => [
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
        { name: 'blocked', value: '1', domain: 'evil.test', path: '/' },
      ]),
    } as any;

    await expect(session.get_cookies()).resolves.toEqual([
      { name: 'sid', value: '123', domain: 'example.com', path: '/' },
    ]);
    await expect(
      session.get_cookies({ include_blocked: true })
    ).resolves.toEqual([
      { name: 'sid', value: '123', domain: 'example.com', path: '/' },
      { name: 'blocked', value: '1', domain: 'evil.test', path: '/' },
    ]);
  });

  it('saves storage state through BrowserSession with private permissions', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const stateDir = path.join(tempDir, 'nested');
    const statePath = path.join(stateDir, 'state.json');

    const session = new BrowserSession();
    session.browser_context = {
      storageState: vi.fn(async () => ({
        cookies: [{ name: 'sid', value: '123' }],
        origins: [],
      })),
    } as any;

    try {
      await session.save_storage_state(statePath);

      expect(fs.existsSync(statePath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters saved storage state by allowed_domains', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    session.browser_context = {
      storageState: vi.fn(async () => ({
        cookies: [
          { name: 'sid', value: '123', domain: 'example.com', path: '/' },
          { name: 'blocked', value: '1', domain: 'evil.test', path: '/' },
        ],
        origins: [
          { origin: 'https://example.com', localStorage: [] },
          {
            origin: 'https://evil.test',
            localStorage: [{ name: 'token', value: 'secret' }],
          },
        ],
      })),
    } as any;

    try {
      await session.save_storage_state(statePath);

      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(parsed.cookies).toEqual([
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
      ]);
      expect(parsed.origins).toEqual([
        { origin: 'https://example.com', localStorage: [] },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads origin storage through BrowserSession without violating allowed_domains', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          cookies: [
            { name: 'sid', value: '123', domain: 'example.com', path: '/' },
            {
              name: 'blocked',
              value: '1',
              domain: 'evil.example.com',
              path: '/',
            },
          ],
          origins: [
            {
              origin: 'https://example.com',
              localStorage: [{ name: 'token', value: 'abc' }],
              sessionStorage: [{ name: 'sid', value: 'xyz' }],
            },
            {
              origin: 'https://evil.example.com',
              localStorage: [{ name: 'blocked', value: '1' }],
            },
          ],
        },
        null,
        2
      )
    );

    const addCookies = vi.fn(async () => {});
    const goto = vi.fn(async () => {});
    const evaluate = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      goto,
      evaluate,
      close,
    }));
    const session = new BrowserSession({
      profile: {
        allowed_domains: ['https://example.com'],
      },
    });
    session.browser_context = {
      addCookies,
      newPage,
    } as any;

    try {
      await session.load_storage_state(statePath);

      expect(addCookies).toHaveBeenCalledWith([
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
      ]);
      expect(newPage).toHaveBeenCalledTimes(1);
      expect(goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts blocked storage origin URLs while loading through BrowserSession', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          cookies: [],
          origins: [
            {
              origin: 'https://evil.example.com/path?token=secret#frag',
              localStorage: [{ name: 'token', value: 'abc' }],
            },
          ],
        },
        null,
        2
      )
    );

    const session = new BrowserSession({
      profile: {
        allowed_domains: ['https://example.com'],
      },
    });
    session.browser_context = {
      addCookies: vi.fn(async () => {}),
      newPage: vi.fn(async () => ({
        goto: vi.fn(async () => {}),
        evaluate: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      })),
    } as any;
    const warningSpy = vi
      .spyOn(session.logger, 'warning')
      .mockImplementation(() => {});

    try {
      await session.load_storage_state(statePath);

      const warningText = warningSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .join('\n');
      expect(warningText).not.toContain('secret');
      expect(warningText).toContain(
        'https://evil.example.com/path?<redacted>#<redacted>'
      );
    } finally {
      warningSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips BrowserSession origin storage after redirect to blocked URL', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          cookies: [],
          origins: [
            {
              origin: 'https://example.com',
              localStorage: [{ name: 'token', value: 'abc' }],
            },
          ],
        },
        null,
        2
      )
    );

    let pageUrl = 'about:blank';
    const goto = vi.fn(async (url: string) => {
      pageUrl =
        url === 'https://example.com'
          ? 'https://evil.test/after-redirect'
          : url;
    });
    const evaluate = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      goto,
      url: vi.fn(() => pageUrl),
      evaluate,
      close,
    }));
    const session = new BrowserSession({
      profile: {
        allowed_domains: ['https://example.com'],
      },
    });
    session.browser_context = {
      addCookies: vi.fn(async () => {}),
      newPage,
    } as any;

    try {
      await session.load_storage_state(statePath);

      expect(newPage).toHaveBeenCalledTimes(1);
      expect(goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
      expect(goto).toHaveBeenCalledWith('about:blank', {
        waitUntil: 'load',
        timeout: 5000,
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips BrowserSession origin storage after redirect to a different allowed origin', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          cookies: [],
          origins: [
            {
              origin: 'https://auth.example.com',
              localStorage: [{ name: 'token', value: 'abc' }],
            },
          ],
        },
        null,
        2
      )
    );

    let pageUrl = 'about:blank';
    const goto = vi.fn(async (url: string) => {
      pageUrl =
        url === 'https://auth.example.com'
          ? 'https://app.example.com/after-redirect'
          : url;
    });
    const evaluate = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      goto,
      url: vi.fn(() => pageUrl),
      evaluate,
      close,
    }));
    const session = new BrowserSession({
      profile: {
        allowed_domains: ['*.example.com'],
      },
    });
    session.browser_context = {
      addCookies: vi.fn(async () => {}),
      newPage,
    } as any;

    try {
      await session.load_storage_state(statePath);

      expect(goto).toHaveBeenCalledWith('about:blank', {
        waitUntil: 'load',
        timeout: 5000,
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

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
