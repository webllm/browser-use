import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserProfile } from '../src/browser/profile.js';
import { BrowserSession } from '../src/browser/session.js';

// The IDs of the default extensions, which load from the extensions cache.
const DEFAULT_EXTENSION_IDS = [
  'ddkjiahejlhfcafbddmgiahcphecmpfh',
  'edibdbjcniadpccecjdfdjjppcpchdlm',
  'gidlfommnbibbmegmgajdbikelkdcmcl',
];

describe('persistent browser profiles', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/set') {
        response.setHeader(
          'set-cookie',
          'persisted=yes; Max-Age=86400; Path=/'
        );
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        `<!doctype html><title>profile</title><p id="cookie">${request.headers.cookie ?? 'none'}</p>`
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const visit = async (
    profile: BrowserProfile,
    pathname: string,
    inspect?: (session: BrowserSession) => Promise<void>,
    playwright?: unknown
  ) => {
    const session = new BrowserSession({
      browser_profile: profile,
      playwright: playwright as any,
    });
    await session.start();
    try {
      const page = await session.get_current_page();
      await page!.goto(`${baseUrl}${pathname}`);
      await inspect?.(session);
      return await page!.locator('#cookie').innerText();
    } finally {
      await session.kill();
    }
  };

  it('keeps cookies in the configured user_data_dir between sessions', async () => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-persistent-')
    );
    const profile = () =>
      new BrowserProfile({ headless: true, user_data_dir: userDataDir });

    try {
      expect(await visit(profile(), '/set')).toBe('none');
      expect(await visit(profile(), '/')).toBe('persisted=yes');
      expect(fs.existsSync(path.join(userDataDir, 'Default'))).toBe(true);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('loads a storage_state file into a fresh profile', async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-storage-state-')
    );
    const statePath = path.join(stateDir, 'state.json');

    try {
      await visit(new BrowserProfile({ headless: true }), '/set', (session) =>
        session.save_storage_state(statePath)
      );

      expect(
        await visit(
          new BrowserProfile({ headless: true, storage_state: statePath }),
          '/'
        )
      ).toBe('persisted=yes');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('gives each default session its own temporary profile', async () => {
    const userDataDirs: string[] = [];
    const playwright = {
      chromium: {
        executablePath: () => chromium.executablePath(),
        launchPersistentContext: (userDataDir: string, options: object) => {
          userDataDirs.push(userDataDir);
          return chromium.launchPersistentContext(userDataDir, options);
        },
      },
    };

    expect(
      await visit(
        new BrowserProfile({ headless: true }),
        '/set',
        undefined,
        playwright
      )
    ).toBe('none');
    expect(
      await visit(
        new BrowserProfile({ headless: true }),
        '/',
        undefined,
        playwright
      )
    ).toBe('none');
    // Playwright creates these profiles and deletes them on close or exit.
    expect(userDataDirs).toEqual(['', '']);
  }, 60_000);

  it('runs default extensions on agent pages in headless mode', async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-extension-config-')
    );
    const previousConfigDir = process.env.BROWSER_USE_CONFIG_DIR;
    process.env.BROWSER_USE_CONFIG_DIR = configDir;
    for (const [index, id] of DEFAULT_EXTENSION_IDS.entries()) {
      const extensionDir = path.join(configDir, 'extensions', id);
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(extensionDir, 'manifest.json'),
        JSON.stringify({
          manifest_version: 3,
          name: `Test extension ${index}`,
          version: '1.0.0',
          content_scripts: [
            {
              matches: ['<all_urls>'],
              js: ['mark.js'],
              run_at: 'document_start',
            },
          ],
        })
      );
      fs.writeFileSync(
        path.join(extensionDir, 'mark.js'),
        `document.documentElement.setAttribute('data-test-extension-${index}', 'ran');`
      );
    }

    try {
      let marks: string[] = [];
      await visit(
        new BrowserProfile({ headless: true, enable_default_extensions: true }),
        '/',
        async (session) => {
          const page = await session.get_current_page();
          marks = await page!.evaluate(() =>
            Array.from(document.documentElement.attributes)
              .map((attribute) => attribute.name)
              .filter((name) => name.startsWith('data-test-extension-'))
              .sort()
          );
        }
      );
      expect(marks).toEqual([
        'data-test-extension-0',
        'data-test-extension-1',
        'data-test-extension-2',
      ]);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.BROWSER_USE_CONFIG_DIR;
      } else {
        process.env.BROWSER_USE_CONFIG_DIR = previousConfigDir;
      }
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }, 60_000);
});
