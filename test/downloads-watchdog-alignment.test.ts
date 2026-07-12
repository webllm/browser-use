import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserConnectedEvent,
  BrowserLaunchEvent,
  BrowserStateRequestEvent,
  DownloadProgressEvent,
  BrowserStoppedEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
  NavigationCompleteEvent,
} from '../src/browser/events.js';
import { DownloadsWatchdog } from '../src/browser/watchdogs/downloads-watchdog.js';
import { DEFAULT_MAX_AUTO_DOWNLOAD_BYTES } from '../src/browser/download-limits.js';

describe('downloads watchdog alignment', () => {
  it('tracks active downloads and records completed files in session state', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-1',
        url: 'https://example.com/file.pdf',
        suggested_filename: 'file.pdf',
      })
    );
    expect(watchdog.get_active_downloads()).toHaveLength(1);

    await session.event_bus.dispatch_or_throw(
      new FileDownloadedEvent({
        guid: 'download-guid-1',
        url: 'https://example.com/file.pdf',
        path: '/tmp/file.pdf',
        file_name: 'file.pdf',
        file_size: 128,
      })
    );

    expect(watchdog.get_active_downloads()).toHaveLength(0);
    expect(session.get_downloaded_files()).toEqual(['/tmp/file.pdf']);
  });

  it('does not duplicate tracked file paths for repeated download events', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const fileEvent = new FileDownloadedEvent({
      guid: 'download-guid-2',
      url: 'https://example.com/archive.zip',
      path: '/tmp/archive.zip',
      file_name: 'archive.zip',
      file_size: 512,
    });

    await session.event_bus.dispatch_or_throw(fileEvent);
    await session.event_bus.dispatch_or_throw(fileEvent);

    expect(session.get_downloaded_files()).toEqual(['/tmp/archive.zip']);
  });

  it('tracks progress and notifies direct download callbacks', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const onStart = vi.fn();
    const onProgress = vi.fn();
    const onComplete = vi.fn();
    watchdog.register_download_callbacks({
      on_start: onStart,
      on_progress: onProgress,
      on_complete: onComplete,
    });

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-callback',
        url: 'https://example.com/report.csv',
        suggested_filename: 'report.csv',
      })
    );
    await session.event_bus.dispatch_or_throw(
      new DownloadProgressEvent({
        guid: 'download-guid-callback',
        received_bytes: 64,
        total_bytes: 128,
        state: 'inProgress',
      })
    );
    await session.event_bus.dispatch_or_throw(
      new FileDownloadedEvent({
        guid: 'download-guid-callback',
        url: 'https://example.com/report.csv',
        path: '/tmp/report.csv',
        file_name: 'report.csv',
        file_size: 128,
      })
    );

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);

    const tracked = watchdog.get_active_downloads();
    expect(tracked).toHaveLength(0);
  });

  it('supports unregistering direct download callbacks', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const onStart = vi.fn();
    watchdog.register_download_callbacks({
      on_start: onStart,
    });
    watchdog.unregister_download_callbacks({
      on_start: onStart,
    });

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-unregister',
        url: 'https://example.com/unregister.bin',
        suggested_filename: 'unregister.bin',
      })
    );

    expect(onStart).not.toHaveBeenCalled();
  });

  it('accepts python-aligned positional callback registration', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const onStart = vi.fn();
    const onProgress = vi.fn();
    const onComplete = vi.fn();
    watchdog.register_download_callbacks(onStart, onProgress, onComplete);

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-positional',
        url: 'https://example.com/positional.bin',
        suggested_filename: 'positional.bin',
      })
    );
    await session.event_bus.dispatch_or_throw(
      new DownloadProgressEvent({
        guid: 'download-guid-positional',
        received_bytes: 5,
        total_bytes: 5,
        state: 'completed',
      })
    );
    await session.event_bus.dispatch_or_throw(
      new FileDownloadedEvent({
        guid: 'download-guid-positional',
        url: 'https://example.com/positional.bin',
        path: '/tmp/positional.bin',
        file_name: 'positional.bin',
        file_size: 5,
      })
    );

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('ensures downloads directory exists on BrowserLaunchEvent', async () => {
    const downloadsPath = `/tmp/browser-use-downloads-${Date.now()}`;
    const session = new BrowserSession({
      profile: {
        downloads_path: downloadsPath,
      },
    });
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(new BrowserLaunchEvent());

    expect(fs.existsSync(downloadsPath)).toBe(true);
    fs.rmSync(downloadsPath, { recursive: true, force: true });
  });

  it('clears active download cache on BrowserStoppedEvent', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-3',
        url: 'https://example.com/large.bin',
        suggested_filename: 'large.bin',
      })
    );
    expect(watchdog.get_active_downloads()).toHaveLength(1);

    await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());

    expect(watchdog.get_active_downloads()).toHaveLength(0);
  });

  it('bridges BrowserStateRequestEvent to NavigationCompleteEvent for active tab', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const navigationEvents: NavigationCompleteEvent[] = [];
    session.event_bus.on(
      'NavigationCompleteEvent',
      (event) => {
        navigationEvents.push(event as NavigationCompleteEvent);
      },
      { handler_id: 'test.downloads.state.nav-complete' }
    );

    const stateEvent = new BrowserStateRequestEvent({
      include_screenshot: false,
      include_recent_events: false,
    });
    await session.event_bus.dispatch_or_throw(stateEvent);

    expect(navigationEvents).toHaveLength(1);
    expect(navigationEvents[0].target_id).toBe(session.active_tab?.target_id);
    expect(navigationEvents[0].url).toBe(session.active_tab?.url);
    expect(navigationEvents[0].event_parent_id).toBe(stateEvent.event_id);
  });

  it('detects downloadable network responses via CDP monitoring and materializes PDF bodies', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cdp-dl-'));
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });
      const watchdog = new DownloadsWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const listeners = new Map<string, (payload: any) => void>();
      const cdpSend = vi.fn(async (method: string) => {
        if (method === 'Network.getResponseBody') {
          return {
            body: Buffer.from('%PDF-1.4').toString('base64'),
            base64Encoded: true,
          };
        }
        return {};
      });
      vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
        send: cdpSend,
        on: (event: string, handler: (payload: any) => void) => {
          listeners.set(event, handler);
        },
        off: (event: string) => {
          listeners.delete(event);
        },
        detach: vi.fn(async () => {}),
      } as any);
      session.browser_context = {
        newCDPSession: vi.fn(async () => ({})),
      } as any;

      const started: DownloadStartedEvent[] = [];
      const progressed: DownloadProgressEvent[] = [];
      const completed: FileDownloadedEvent[] = [];
      session.event_bus.on(
        'DownloadStartedEvent',
        (event) => started.push(event as DownloadStartedEvent),
        { handler_id: 'test.downloads.cdp.start' }
      );
      session.event_bus.on(
        'DownloadProgressEvent',
        (event) => progressed.push(event as DownloadProgressEvent),
        { handler_id: 'test.downloads.cdp.progress' }
      );
      session.event_bus.on(
        'FileDownloadedEvent',
        (event) => completed.push(event as FileDownloadedEvent),
        { handler_id: 'test.downloads.cdp.complete' }
      );

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );

      listeners.get('Network.responseReceived')?.({
        requestId: 'req-pdf-1',
        response: {
          url: 'https://example.com/files/report.pdf',
          mimeType: 'application/pdf',
          headers: {},
        },
      });
      listeners.get('Network.loadingFinished')?.({
        requestId: 'req-pdf-1',
        encodedDataLength: 8,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(started).toHaveLength(1);
      expect(progressed).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0].mime_type).toBe('application/pdf');
      expect(fs.existsSync(completed[0].path)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(completed[0].path).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('blocks CDP auto-download materialization for disallowed response URLs', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cdp-dl-'));
    try {
      const session = new BrowserSession({
        profile: {
          allowed_domains: ['https://example.com'],
          downloads_path: downloadsDir,
        },
      });
      const watchdog = new DownloadsWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const listeners = new Map<string, (payload: any) => void>();
      const cdpSend = vi.fn(async (method: string) => {
        if (method === 'Network.getResponseBody') {
          return {
            body: Buffer.from('%PDF-1.4').toString('base64'),
            base64Encoded: true,
          };
        }
        return {};
      });
      vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
        send: cdpSend,
        on: (event: string, handler: (payload: any) => void) => {
          listeners.set(event, handler);
        },
        off: (event: string) => {
          listeners.delete(event);
        },
        detach: vi.fn(async () => {}),
      } as any);
      session.browser_context = {
        newCDPSession: vi.fn(async () => ({})),
      } as any;

      const started: DownloadStartedEvent[] = [];
      const completed: FileDownloadedEvent[] = [];
      session.event_bus.on(
        'DownloadStartedEvent',
        (event) => started.push(event as DownloadStartedEvent),
        { handler_id: 'test.downloads.cdp.blocked-start' }
      );
      session.event_bus.on(
        'FileDownloadedEvent',
        (event) => completed.push(event as FileDownloadedEvent),
        { handler_id: 'test.downloads.cdp.blocked-complete' }
      );

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );

      listeners.get('Network.responseReceived')?.({
        requestId: 'req-pdf-blocked',
        response: {
          url: 'https://evil.test/files/report.pdf?token=secret',
          mimeType: 'application/pdf',
          headers: {},
        },
      });
      listeners.get('Network.loadingFinished')?.({
        requestId: 'req-pdf-blocked',
        encodedDataLength: 8,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(started).toHaveLength(0);
      expect(completed).toHaveLength(0);
      expect(cdpSend).not.toHaveBeenCalledWith(
        'Network.getResponseBody',
        expect.anything()
      );
      expect(fs.readdirSync(downloadsDir)).toEqual([]);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized CDP PDF bodies before requesting them', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cdp-dl-'));
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });
      const watchdog = new DownloadsWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const listeners = new Map<string, (payload: any) => void>();
      const cdpSend = vi.fn(async () => ({}));
      vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
        send: cdpSend,
        on: (event: string, handler: (payload: any) => void) => {
          listeners.set(event, handler);
        },
        off: (event: string) => {
          listeners.delete(event);
        },
        detach: vi.fn(async () => {}),
      } as any);
      session.browser_context = {
        newCDPSession: vi.fn(async () => ({})),
      } as any;

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );

      listeners.get('Network.responseReceived')?.({
        requestId: 'req-pdf-oversized',
        response: {
          url: 'https://example.com/files/oversized.pdf',
          mimeType: 'application/pdf',
          headers: {},
        },
      });
      listeners.get('Network.loadingFinished')?.({
        requestId: 'req-pdf-oversized',
        encodedDataLength: DEFAULT_MAX_AUTO_DOWNLOAD_BYTES + 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(cdpSend).not.toHaveBeenCalledWith(
        'Network.getResponseBody',
        expect.anything()
      );
      expect(fs.readdirSync(downloadsDir)).toEqual([]);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('reduces page-controlled download names to safe basenames', () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cdp-dl-'));
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });
      const watchdog = new DownloadsWatchdog({ browser_session: session });

      expect((watchdog as any)._sanitizeFilename('../outside/report.pdf')).toBe(
        'report.pdf'
      );
      expect((watchdog as any)._sanitizeFilename('..\\secret.pdf')).toBe(
        'secret.pdf'
      );
      expect((watchdog as any)._sanitizeFilename('\0')).toBe('download');
      expect(
        (watchdog as any)._isPathContained(
          path.join(downloadsDir, 'report.pdf'),
          downloadsDir
        )
      ).toBe(true);
      expect(
        (watchdog as any)._isPathContained(
          path.join(downloadsDir, '..', 'report.pdf'),
          downloadsDir
        )
      ).toBe(false);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('materializes CDP downloads inside downloads_path when headers include traversal', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cdp-dl-'));
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });
      const watchdog = new DownloadsWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const listeners = new Map<string, (payload: any) => void>();
      vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
        send: vi.fn(async (method: string) => {
          if (method === 'Network.getResponseBody') {
            return {
              body: Buffer.from('%PDF-1.4').toString('base64'),
              base64Encoded: true,
            };
          }
          return {};
        }),
        on: (event: string, handler: (payload: any) => void) => {
          listeners.set(event, handler);
        },
        off: (event: string) => {
          listeners.delete(event);
        },
        detach: vi.fn(async () => {}),
      } as any);
      session.browser_context = {
        newCDPSession: vi.fn(async () => ({})),
      } as any;

      const completed: FileDownloadedEvent[] = [];
      session.event_bus.on(
        'FileDownloadedEvent',
        (event) => completed.push(event as FileDownloadedEvent),
        { handler_id: 'test.downloads.cdp.traversal-complete' }
      );

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );

      listeners.get('Network.responseReceived')?.({
        requestId: 'req-pdf-traversal',
        response: {
          url: 'https://example.com/download',
          mimeType: 'application/pdf',
          headers: {
            'content-disposition':
              'attachment; filename="../outside/report.pdf"',
          },
        },
      });
      listeners.get('Network.loadingFinished')?.({
        requestId: 'req-pdf-traversal',
        encodedDataLength: 8,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(completed).toHaveLength(1);
      expect(completed[0].file_name).toBe('report.pdf');
      expect(path.dirname(completed[0].path)).toBe(downloadsDir);
      expect(fs.existsSync(path.join(downloadsDir, 'report.pdf'))).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(completed[0].path).mode & 0o777).toBe(0o600);
      }
      expect(fs.existsSync(path.join(downloadsDir, '..', 'outside'))).toBe(
        false
      );
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });
});
