import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserConnectedEvent,
  BrowserStopEvent,
  LoadStorageStateEvent,
  SaveStorageStateEvent,
  StorageStateLoadedEvent,
  StorageStateSavedEvent,
} from '../src/browser/events.js';
import { StorageStateWatchdog } from '../src/browser/watchdogs/storage-state-watchdog.js';

const createTempStoragePath = () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-use-storage-watchdog-')
  );
  return {
    tempDir,
    storagePath: path.join(tempDir, 'storage-state.json'),
  };
};

describe('storage state watchdog alignment', () => {
  it('filters inline storage state before creating the browser context', () => {
    const session = new BrowserSession({
      profile: {
        user_data_dir: null,
        allowed_domains: ['https://example.com'],
        storage_state: {
          cookies: [
            { name: 'sid', value: '123', domain: 'example.com', path: '/' },
            { name: 'secret', value: 'leak', domain: 'evil.test', path: '/' },
          ],
          origins: [
            {
              origin: 'https://example.com',
              localStorage: [{ name: 'theme', value: 'dark' }],
            },
            {
              origin: 'https://evil.test',
              localStorage: [{ name: 'token', value: 'leak' }],
            },
          ],
        },
      },
    });

    const contextOptions = (session as any)._toPlaywrightOptions(
      session.browser_profile.kwargs_for_new_context()
    );

    expect(contextOptions.storageState).toEqual({
      cookies: [
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
      ],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [{ name: 'theme', value: 'dark' }],
        },
      ],
    });
  });

  it('filters file-backed storage state before creating the browser context', () => {
    const { tempDir, storagePath } = createTempStoragePath();
    const originalState = {
      cookies: [
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
        { name: 'secret', value: 'leak', domain: 'evil.test', path: '/' },
      ],
      origins: [
        {
          origin: 'https://evil.test',
          localStorage: [{ name: 'token', value: 'leak' }],
        },
      ],
    };
    try {
      fs.writeFileSync(storagePath, JSON.stringify(originalState));
      const session = new BrowserSession({
        profile: {
          user_data_dir: null,
          allowed_domains: ['https://example.com'],
          storage_state: storagePath,
        },
      });

      const contextOptions = (session as any)._toPlaywrightOptions(
        session.browser_profile.kwargs_for_new_context()
      );

      expect(contextOptions.storageState).toEqual({
        cookies: [
          { name: 'sid', value: '123', domain: 'example.com', path: '/' },
        ],
        origins: [],
      });
      expect(JSON.parse(fs.readFileSync(storagePath, 'utf-8'))).toEqual(
        originalState
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('saves storage state and emits StorageStateSavedEvent', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({
          cookies: [{ name: 'sid', value: '123' }],
          origins: [{ origin: 'https://example.com', localStorage: [] }],
        })),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      expect(fs.existsSync(storagePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      expect(parsed.cookies).toHaveLength(1);
      expect(parsed.origins).toHaveLength(1);

      const savedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateSavedEvent
      );
      expect(savedCall).toBeDefined();
      const savedEvent = savedCall?.[0] as StorageStateSavedEvent;
      expect(savedEvent.path).toBe(path.resolve(storagePath));
      expect(savedEvent.cookies_count).toBe(1);
      expect(savedEvent.origins_count).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters saved storage state by allowed_domains', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [
              { name: 'legacy', value: '1', domain: 'evil.test', path: '/' },
            ],
            origins: [
              {
                origin: 'https://evil.test',
                localStorage: [{ name: 'token', value: 'secret' }],
              },
            ],
          },
          null,
          2
        )
      );

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
          allowed_domains: ['https://example.com'],
        },
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
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      expect(parsed.cookies).toEqual([
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
      ]);
      expect(parsed.origins).toEqual([
        { origin: 'https://example.com', localStorage: [] },
      ]);

      const savedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateSavedEvent
      );
      const savedEvent = savedCall?.[0] as StorageStateSavedEvent;
      expect(savedEvent.cookies_count).toBe(1);
      expect(savedEvent.origins_count).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('saves storage state files with private permissions', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify({ cookies: [], origins: [] }, null, 2)
      );
      if (process.platform !== 'win32') {
        fs.chmodSync(storagePath, 0o644);
      }

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({
          cookies: [{ name: 'sid', value: '123' }],
          origins: [],
        })),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      expect(fs.existsSync(storagePath)).toBe(true);
      expect(fs.existsSync(`${storagePath}.bak`)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(`${storagePath}.bak`).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates storage state directories with private permissions', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-storage-watchdog-')
    );
    const storageDir = path.join(tempDir, 'nested');
    const storagePath = path.join(storageDir, 'storage-state.json');
    try {
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({
          cookies: [{ name: 'sid', value: '123' }],
          origins: [],
        })),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      expect(fs.existsSync(storagePath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(storageDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads storage state cookies and emits StorageStateLoadedEvent', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [{ name: 'sid', value: '123' }],
            origins: [{ origin: 'https://example.com', localStorage: [] }],
          },
          null,
          2
        )
      );

      const addCookies = vi.fn(async () => {});
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        addCookies,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      expect(addCookies).toHaveBeenCalledTimes(1);
      expect(addCookies).toHaveBeenCalledWith([{ name: 'sid', value: '123' }]);

      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      expect(loadedCall).toBeDefined();
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.path).toBe(path.resolve(storagePath));
      expect(loadedEvent.cookies_count).toBe(1);
      expect(loadedEvent.origins_count).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips storage state cookies blocked by allowed_domains', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
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
            origins: [],
          },
          null,
          2
        )
      );

      const addCookies = vi.fn(async () => {});
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
          allowed_domains: ['https://example.com'],
        },
      });
      session.browser_context = {
        addCookies,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      expect(addCookies).toHaveBeenCalledWith([
        { name: 'sid', value: '123', domain: 'example.com', path: '/' },
      ]);
      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.cookies_count).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('replays origins localStorage and sessionStorage entries on load', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [],
            origins: [
              {
                origin: 'https://example.com',
                localStorage: [{ name: 'token', value: 'abc' }],
                sessionStorage: [{ name: 'sid', value: 'xyz' }],
              },
            ],
          },
          null,
          2
        )
      );

      const goto = vi.fn(async () => {});
      const evaluate = vi.fn(
        async (
          _fn: unknown,
          _payload: {
            localStorageEntries: Array<{ name: string; value: string }>;
            sessionStorageEntries: Array<{ name: string; value: string }>;
          }
        ) => {}
      );
      const close = vi.fn(async () => {});
      const newPage = vi.fn(async () => ({
        goto,
        evaluate,
        close,
      }));

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        addCookies: vi.fn(async () => {}),
        newPage,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      expect(newPage).toHaveBeenCalledTimes(1);
      expect(goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      const call = evaluate.mock.calls[0];
      expect(call).toBeDefined();
      const payload = call?.[1];
      expect(payload).toBeDefined();
      if (!payload) {
        throw new Error('missing evaluate payload');
      }
      expect(payload.localStorageEntries).toEqual([
        { name: 'token', value: 'abc' },
      ]);
      expect(payload.sessionStorageEntries).toEqual([
        { name: 'sid', value: 'xyz' },
      ]);
      expect(close).toHaveBeenCalledTimes(1);

      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.origins_count).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not navigate to blocked origins while loading storage state', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [],
            origins: [
              {
                origin: 'https://evil.example.com',
                localStorage: [{ name: 'token', value: 'abc' }],
              },
            ],
          },
          null,
          2
        )
      );

      const newPage = vi.fn(async () => ({
        goto: vi.fn(async () => {}),
        evaluate: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }));
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
          allowed_domains: ['https://example.com'],
        },
      });
      session.browser_context = {
        addCookies: vi.fn(async () => {}),
        newPage,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      expect(newPage).not.toHaveBeenCalled();
      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.origins_count).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts blocked storage origin URLs while loading storage state', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    let warningSpy: {
      mock: { calls: unknown[][] };
      mockRestore: () => void;
    } | null = null;
    try {
      fs.writeFileSync(
        storagePath,
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
          storage_state: storagePath,
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
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );
      warningSpy = vi
        .spyOn(session.logger, 'warning')
        .mockImplementation(() => {});

      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      const warningText = warningSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .join('\n');
      expect(warningText).not.toContain('secret');
      expect(warningText).toContain(
        'https://evil.example.com/path?<redacted>#<redacted>'
      );
    } finally {
      warningSpy?.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips replaying origin storage after redirect to blocked URL', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
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
          storage_state: storagePath,
          allowed_domains: ['https://example.com'],
        },
      });
      session.browser_context = {
        addCookies: vi.fn(async () => {}),
        newPage,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

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
      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.origins_count).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips replaying origin storage after redirect to a different allowed origin', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
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
          storage_state: storagePath,
          allowed_domains: ['*.example.com'],
        },
      });
      session.browser_context = {
        addCookies: vi.fn(async () => {}),
        newPage,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      expect(goto).toHaveBeenCalledWith('about:blank', {
        waitUntil: 'load',
        timeout: 5000,
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.origins_count).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('replaces stale authentication state when saving after logout', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [
              {
                name: 'session',
                value: 'stale-auth-token',
                domain: '.example.com',
                path: '/',
              },
            ],
            origins: [
              {
                origin: 'https://persisted.example.com',
                localStorage: [{ name: 'a', value: '1' }],
              },
            ],
          },
          null,
          2
        )
      );

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({
          cookies: [],
          origins: [],
        })),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      const saved = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      expect(saved).toEqual({ cookies: [], origins: [] });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bridges browser lifecycle events to load/save storage events', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
        addCookies: vi.fn(async () => {}),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );
      await session.event_bus.dispatch_or_throw(new BrowserStopEvent());

      expect(
        dispatchSpy.mock.calls.some(
          ([event]) => event instanceof LoadStorageStateEvent
        )
      ).toBe(true);
      expect(
        dispatchSpy.mock.calls.some(
          ([event]) => event instanceof SaveStorageStateEvent
        )
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts periodic auto-save on connect and stops it on browser stop', async () => {
    vi.useFakeTimers();
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      const storageState = vi
        .fn()
        .mockResolvedValueOnce({
          cookies: [{ name: 'sid', value: '1' }],
          origins: [],
        })
        .mockResolvedValue({
          cookies: [{ name: 'sid', value: '2' }],
          origins: [],
        });

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState,
        addCookies: vi.fn(async () => {}),
      } as any;

      const watchdog = new StorageStateWatchdog({ browser_session: session });
      (watchdog as any)._autoSaveIntervalMs = 10;
      session.attach_watchdog(watchdog);

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );
      await vi.advanceTimersByTimeAsync(30);

      expect(storageState).toHaveBeenCalled();

      await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
      const callCountAfterStop = storageState.mock.calls.length;

      await vi.advanceTimersByTimeAsync(50);
      expect(storageState.mock.calls.length).toBe(callCountAfterStop);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
