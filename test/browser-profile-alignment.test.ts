import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const importProfileModule = async () => {
  vi.resetModules();
  return await import('../src/browser/profile.js');
};

const modeOf = (targetPath: string) => fs.statSync(targetPath).mode & 0o777;

describe('BrowserProfile alignment with latest py-browser-use defaults', () => {
  afterEach(() => {
    delete process.env.BROWSER_USE_DISABLE_EXTENSIONS;
    delete process.env.BROWSER_USE_CONFIG_DIR;
    delete process.env.BROWSER_USE_SCREEN_WIDTH;
    delete process.env.BROWSER_USE_SCREEN_HEIGHT;
  });

  it.each([
    ['screen width', { screen: { width: Number.NaN, height: 1080 } }],
    ['viewport height', { viewport: { width: 1920, height: Infinity } }],
    ['window width', { window_width: -1 }],
    ['video size', { record_video_size: { width: 640.5, height: 480 } }],
  ])('rejects invalid %s dimensions', async (_name, invalidOptions) => {
    const { BrowserProfile } = await importProfileModule();

    expect(
      () =>
        new BrowserProfile({
          downloads_path: os.tmpdir(),
          ...invalidOptions,
        })
    ).toThrow(/must be a non-negative safe integer/);
  });

  it.each([
    ['slow_mo', -1],
    ['timeout', Infinity],
    ['default_navigation_timeout', Number.NaN],
    ['minimum_wait_page_load_time', -0.1],
    ['maximum_wait_page_load_time', Infinity],
  ])('rejects invalid %s timing values', async (name, value) => {
    const { BrowserProfile } = await importProfileModule();

    expect(
      () =>
        new BrowserProfile({
          downloads_path: os.tmpdir(),
          [name]: value,
        })
    ).toThrow(`${name} must be a finite non-negative number`);
  });

  it('allows the all-elements viewport sentinel but rejects other negative expansions', async () => {
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({
      downloads_path: os.tmpdir(),
      viewport_expansion: -1,
    });

    expect(profile.viewport_expansion).toBe(-1);
    expect(
      () =>
        new BrowserProfile({
          downloads_path: os.tmpdir(),
          viewport_expansion: -2,
        })
    ).toThrow('viewport_expansion must be -1 or a non-negative safe integer');
  });

  it('rejects invalid geolocation coordinates before browser launch', async () => {
    const { BrowserProfile } = await importProfileModule();

    expect(
      () =>
        new BrowserProfile({
          downloads_path: os.tmpdir(),
          geolocation: {
            latitude: 91,
            longitude: 0,
            accuracy: 0,
          },
        })
    ).toThrow(/geolocation must contain finite/);
  });

  it('ignores invalid display dimensions from the environment', async () => {
    process.env.BROWSER_USE_SCREEN_WIDTH = 'Infinity';
    process.env.BROWSER_USE_SCREEN_HEIGHT = '1080';
    const { get_display_size } = await importProfileModule();

    expect(get_display_size()).toBeNull();
  });

  it('defaults wait_between_actions to 0.1 seconds', async () => {
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({});
    expect(profile.config.wait_between_actions).toBe(0.1);
  });

  it('uses 1920x1080 fallback for deprecated window_width/window_height options', async () => {
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({
      window_width: 1600,
    });

    expect(profile.config.window_size?.width).toBe(1600);
    expect(profile.config.window_size?.height).toBe(1080);
  });

  it('keeps default extensions enabled when env var is unset', async () => {
    delete process.env.BROWSER_USE_DISABLE_EXTENSIONS;
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({});
    expect(profile.config.enable_default_extensions).toBe(true);
  });

  it('disables default extensions when BROWSER_USE_DISABLE_EXTENSIONS is truthy', async () => {
    process.env.BROWSER_USE_DISABLE_EXTENSIONS = '1';
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({});
    expect(profile.config.enable_default_extensions).toBe(false);
  });

  it('still enables default extensions for falsey env values', async () => {
    process.env.BROWSER_USE_DISABLE_EXTENSIONS = 'false';
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({});
    expect(profile.config.enable_default_extensions).toBe(true);
  });

  it('lets explicit constructor values override env defaults', async () => {
    process.env.BROWSER_USE_DISABLE_EXTENSIONS = '1';
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({
      enable_default_extensions: true,
    });
    expect(profile.config.enable_default_extensions).toBe(true);
  });

  it('optimizes large allowed/prohibited domain lists into sets', async () => {
    const { BrowserProfile } = await importProfileModule();
    const domains = Array.from({ length: 120 }, (_, idx) => {
      return `site-${idx}.example.com`;
    });

    const profile = new BrowserProfile({
      allowed_domains: domains,
      prohibited_domains: domains,
    });

    expect(profile.config.allowed_domains).toBeInstanceOf(Set);
    expect(profile.config.prohibited_domains).toBeInstanceOf(Set);
    expect(
      (profile.config.allowed_domains as Set<string>).has(domains[0])
    ).toBe(true);
  });

  it('creates a unique default downloads_path when none is provided', async () => {
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({});
    const downloadsPath = profile.config.downloads_path;

    expect(typeof downloadsPath).toBe('string');
    expect(downloadsPath).toContain('browser-use-downloads-');
    expect(fs.existsSync(downloadsPath!)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(downloadsPath!).mode & 0o777).toBe(0o700);
    }
  });

  it('downloads default extension CRX files with private permissions', async () => {
    const { BrowserProfile } = await importProfileModule();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-download-')
    );
    const outputPath = path.join(tempDir, 'extension.crx');
    const getSpy = vi.spyOn(https, 'get').mockImplementation(((
      _url: string | URL,
      callback: (
        response: EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          resume: () => void;
        }
      ) => void
    ) => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
        resume: () => void;
      };
      response.statusCode = 200;
      response.headers = {};

      queueMicrotask(() => {
        callback(response);
        response.end(Buffer.from('fake-crx'));
      });

      return new EventEmitter();
    }) as any);

    try {
      const profile = new BrowserProfile({ enable_default_extensions: false });
      await (profile as any).downloadExtension(
        'https://example.test/extension.crx',
        outputPath
      );

      expect(fs.readFileSync(outputPath, 'utf-8')).toBe('fake-crx');
      if (process.platform !== 'win32') {
        expect(modeOf(outputPath)).toBe(0o600);
      }
    } finally {
      getSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces a hard deadline for stalled default extension requests', async () => {
    vi.useFakeTimers();
    const { BrowserProfile } = await importProfileModule();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-timeout-')
    );
    const outputPath = path.join(tempDir, 'extension.crx');
    const request = new EventEmitter() as EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
    };
    request.destroy = vi.fn();
    request.setTimeout = vi.fn();
    const getSpy = vi.spyOn(https, 'get').mockReturnValue(request as any);

    try {
      const profile = new BrowserProfile({ enable_default_extensions: false });
      const download = (profile as any).downloadExtension(
        'https://example.test/stalled.crx',
        outputPath
      );
      const timeoutExpectation = expect(download).rejects.toThrow(
        'HTTP request timed out'
      );
      await vi.advanceTimersByTimeAsync(30_000);

      await timeoutExpectation;
      expect(request.destroy).toHaveBeenCalledOnce();
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      getSpy.mockRestore();
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts default extensions into private directories', async () => {
    const { BrowserProfile } = await importProfileModule();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-extract-')
    );
    const crxPath = path.join(tempDir, 'extension.crx');
    const extractDir = path.join(tempDir, 'unpacked-extension');

    try {
      const zip = new AdmZip();
      zip.addFile(
        'manifest.json',
        Buffer.from(
          JSON.stringify({
            manifest_version: 3,
            name: 'Test Extension',
            version: '1.0.0',
          })
        )
      );
      zip.writeZip(crxPath);

      const profile = new BrowserProfile({ enable_default_extensions: false });
      await (profile as any).extractExtension(crxPath, extractDir);

      expect(fs.existsSync(path.join(extractDir, 'manifest.json'))).toBe(true);
      if (process.platform !== 'win32') {
        expect(modeOf(extractDir)).toBe(0o700);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves arg values containing equals signs', async () => {
    const { BrowserProfile } = await importProfileModule();
    const profile = new BrowserProfile({
      enable_default_extensions: false,
      args: ['--custom-size=1280,720', '--custom=bar=baz', '--custom-flag'],
    });

    const args = await profile.getArgs();
    expect(args).toContain('--custom-size=1280,720');
    expect(args).toContain('--custom=bar=baz');
    expect(args).toContain('--custom-flag');
  });

  it('copies Chrome-backed user profiles to a temp directory and skips transient files', async () => {
    const { BrowserProfile } = await importProfileModule();
    const sourceUserDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'chrome-user-data-src-')
    );
    let copiedUserDataDir: string | null = null;

    try {
      const profileDir = path.join(sourceUserDataDir, 'Profile 4');
      fs.mkdirSync(path.join(profileDir, 'IndexedDB'), { recursive: true });
      fs.writeFileSync(path.join(sourceUserDataDir, 'Local State'), '{}');
      fs.writeFileSync(path.join(profileDir, 'Preferences'), '{"ok":true}');
      fs.writeFileSync(path.join(profileDir, 'SingletonLock'), '1234');
      fs.writeFileSync(path.join(profileDir, 'LOCK'), 'lock');
      fs.writeFileSync(path.join(profileDir, 'Cookies-journal'), 'journal');
      fs.writeFileSync(path.join(profileDir, 'IndexedDB', 'data.lock'), 'lock');

      const profile = new BrowserProfile({
        user_data_dir: sourceUserDataDir,
        profile_directory: 'Profile 4',
        executable_path:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });

      copiedUserDataDir = profile.config.user_data_dir;
      expect(copiedUserDataDir).not.toBe(sourceUserDataDir);
      expect(path.basename(copiedUserDataDir!)).toMatch(
        /^browser-use-user-data-dir-/
      );
      expect(fs.existsSync(path.join(copiedUserDataDir!, 'Local State'))).toBe(
        true
      );
      expect(
        fs.existsSync(path.join(copiedUserDataDir!, 'Profile 4', 'Preferences'))
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(copiedUserDataDir!, 'Profile 4', 'SingletonLock')
        )
      ).toBe(false);
      expect(
        fs.existsSync(path.join(copiedUserDataDir!, 'Profile 4', 'LOCK'))
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(copiedUserDataDir!, 'Profile 4', 'Cookies-journal')
        )
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(copiedUserDataDir!, 'Profile 4', 'IndexedDB', 'data.lock')
        )
      ).toBe(false);
    } finally {
      fs.rmSync(sourceUserDataDir, { recursive: true, force: true });
      if (copiedUserDataDir) {
        fs.rmSync(copiedUserDataDir, { recursive: true, force: true });
      }
    }
  });

  it('copies Chromium-backed user profiles to a temp directory', async () => {
    const { BrowserProfile } = await importProfileModule();
    const sourceUserDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'chromium-user-data-src-')
    );
    let copiedUserDataDir: string | null = null;

    try {
      const profileDir = path.join(sourceUserDataDir, 'Default');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'Preferences'), '{"ok":true}');

      const profile = new BrowserProfile({
        user_data_dir: sourceUserDataDir,
        executable_path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
      });

      copiedUserDataDir = profile.config.user_data_dir;
      expect(copiedUserDataDir).not.toBe(sourceUserDataDir);
      expect(path.basename(copiedUserDataDir!)).toMatch(
        /^browser-use-user-data-dir-/
      );
      expect(
        fs.existsSync(path.join(copiedUserDataDir!, 'Default', 'Preferences'))
      ).toBe(true);
    } finally {
      fs.rmSync(sourceUserDataDir, { recursive: true, force: true });
      if (copiedUserDataDir) {
        fs.rmSync(copiedUserDataDir, { recursive: true, force: true });
      }
    }
  });

  it('keeps browser-use managed Chrome profiles persistent instead of temp-copying them', async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    process.env.BROWSER_USE_CONFIG_DIR = configDir;
    const { BrowserProfile } = await importProfileModule();

    try {
      const profile = new BrowserProfile({
        executable_path:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });

      expect(profile.config.user_data_dir).toBe(
        path.join(configDir, 'profiles', 'default-google-chrome')
      );
      expect(path.basename(profile.config.user_data_dir!)).not.toMatch(
        /^browser-use-user-data-dir-/
      );
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
