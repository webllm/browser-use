import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';
import {
  BrowserStateRequestEvent,
  ClickElementEvent,
  ClickCoordinateEvent,
  FileDownloadedEvent,
  GetDropdownOptionsEvent,
  NavigateToUrlEvent,
  ScrollEvent,
  ScrollToTextEvent,
  SelectDropdownOptionEvent,
  SendKeysEvent,
  SwitchTabEvent,
  WaitEvent,
} from '../src/browser/events.js';
import { DOMElementNode, DOMTextNode } from '../src/dom/views.js';
import { AboutBlankWatchdog } from '../src/browser/watchdogs/aboutblank-watchdog.js';
import { CaptchaWatchdog } from '../src/browser/watchdogs/captcha-watchdog.js';
import { DefaultActionWatchdog } from '../src/browser/watchdogs/default-action-watchdog.js';
import { CDPSessionWatchdog } from '../src/browser/watchdogs/cdp-session-watchdog.js';
import { CrashWatchdog } from '../src/browser/watchdogs/crash-watchdog.js';
import { DownloadsWatchdog } from '../src/browser/watchdogs/downloads-watchdog.js';
import { DOMWatchdog } from '../src/browser/watchdogs/dom-watchdog.js';
import { HarRecordingWatchdog } from '../src/browser/watchdogs/har-recording-watchdog.js';
import { LocalBrowserWatchdog } from '../src/browser/watchdogs/local-browser-watchdog.js';
import { PermissionsWatchdog } from '../src/browser/watchdogs/permissions-watchdog.js';
import { PopupsWatchdog } from '../src/browser/watchdogs/popups-watchdog.js';
import { RecordingWatchdog } from '../src/browser/watchdogs/recording-watchdog.js';
import { ScreenshotWatchdog } from '../src/browser/watchdogs/screenshot-watchdog.js';
import { SecurityWatchdog } from '../src/browser/watchdogs/security-watchdog.js';
import { StorageStateWatchdog } from '../src/browser/watchdogs/storage-state-watchdog.js';
import { URLNotAllowedError } from '../src/browser/views.js';

describe('default action watchdog alignment', () => {
  it('attaches default watchdog stack only once', () => {
    const session = new BrowserSession();

    session.attach_default_watchdogs();
    session.attach_default_watchdogs();

    const watchdogs = session.get_watchdogs();
    expect(watchdogs).toHaveLength(14);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof LocalBrowserWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof CDPSessionWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof CrashWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof AboutBlankWatchdog)
    ).toBe(true);
    expect(watchdogs.some((watchdog) => watchdog instanceof DOMWatchdog)).toBe(
      true
    );
    expect(
      watchdogs.some((watchdog) => watchdog instanceof PermissionsWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof PopupsWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof SecurityWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof ScreenshotWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof RecordingWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof DownloadsWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof StorageStateWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof DefaultActionWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof CaptchaWatchdog)
    ).toBe(true);
  });

  it('attaches HarRecordingWatchdog when record_har_path is configured', () => {
    const session = new BrowserSession({
      profile: {
        record_har_path: './tmp/default-stack.har',
      },
    });

    session.attach_default_watchdogs();

    const watchdogs = session.get_watchdogs();
    expect(watchdogs).toHaveLength(15);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof HarRecordingWatchdog)
    ).toBe(true);
  });

  it('routes navigation and tab switch events to BrowserSession methods', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const navigateSpy = vi
      .spyOn(session, 'navigate_to')
      .mockResolvedValue(null as any);
    const switchSpy = vi
      .spyOn(session, 'switch_to_tab')
      .mockResolvedValue(null as any);

    await session.event_bus.dispatch_or_throw(
      new NavigateToUrlEvent({ url: 'https://example.com' })
    );
    await session.event_bus.dispatch_or_throw(
      new SwitchTabEvent({ target_id: 'tab_test_target' })
    );

    expect(navigateSpy).toHaveBeenCalledWith('https://example.com', {
      wait_until: 'load',
      timeout_ms: null,
    });
    expect(switchSpy).toHaveBeenCalledWith('tab_test_target');
  });

  it('routes new-tab navigation through BrowserSession.create_new_tab', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const createTabSpy = vi
      .spyOn(session, 'create_new_tab')
      .mockResolvedValue(null as any);
    const navigateSpy = vi
      .spyOn(session, 'navigate_to')
      .mockResolvedValue(null as any);

    await session.event_bus.dispatch_or_throw(
      new NavigateToUrlEvent({
        url: 'https://example.com/new-tab',
        new_tab: true,
        wait_until: 'networkidle',
        timeout_ms: 7000,
      })
    );

    expect(createTabSpy).toHaveBeenCalledWith('https://example.com/new-tab', {
      wait_until: 'networkidle',
      timeout_ms: 7000,
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('switches to the most recently opened tab when target_id is null', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    (session as any)._tabs = [
      {
        page_id: 0,
        tab_id: '0000',
        target_id: 'tab_target_old',
        url: 'about:blank',
        title: 'about:blank',
        parent_page_id: null,
      },
      {
        page_id: 1,
        tab_id: '0001',
        target_id: 'tab_target_new',
        url: 'https://example.com/new',
        title: 'new',
        parent_page_id: null,
      },
    ];

    const switchSpy = vi
      .spyOn(session, 'switch_to_tab')
      .mockResolvedValue(null as any);

    await session.event_bus.dispatch_or_throw(new SwitchTabEvent());

    expect(switchSpy).toHaveBeenCalledWith('tab_target_new');
  });

  it('creates about:blank tab when switch request has no target and no tabs exist', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    (session as any)._tabs = [];
    const createTabSpy = vi
      .spyOn(session, 'create_new_tab')
      .mockResolvedValue(null as any);
    const switchSpy = vi
      .spyOn(session, 'switch_to_tab')
      .mockResolvedValue(null as any);

    await session.event_bus.dispatch_or_throw(new SwitchTabEvent());

    expect(createTabSpy).toHaveBeenCalledWith('about:blank');
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('routes BrowserStateRequestEvent and returns handler result', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();
    const mockedState = { url: 'https://state.example' } as any;

    const stateSpy = vi
      .spyOn(session, 'get_browser_state_with_recovery')
      .mockResolvedValue(mockedState);

    const result = await session.event_bus.dispatch_or_throw(
      new BrowserStateRequestEvent({
        include_dom: true,
        include_screenshot: false,
        include_recent_events: true,
      })
    );

    expect(stateSpy).toHaveBeenCalledWith({
      cache_clickable_elements_hashes: true,
      include_screenshot: false,
      include_recent_events: true,
    });
    expect(result.event.event_result).toBe(mockedState);
  });

  it('routes wait and send-keys events through BrowserSession helpers', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const waitSpy = vi.spyOn(session, 'wait').mockResolvedValue();
    const sendKeysSpy = vi.spyOn(session, 'send_keys').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(new WaitEvent({ seconds: 2 }));
    await session.event_bus.dispatch_or_throw(
      new SendKeysEvent({ keys: 'Control+A' })
    );

    expect(waitSpy).toHaveBeenCalledWith(2);
    expect(sendKeysSpy).toHaveBeenCalledWith('Control+A');
  });

  it('routes coordinate click events through BrowserSession.click_coordinates', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const clickSpy = vi.spyOn(session, 'click_coordinates').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(
      new ClickCoordinateEvent({
        coordinate_x: 120,
        coordinate_y: 260,
        button: 'left',
      })
    );

    expect(clickSpy).toHaveBeenCalledWith(120, 260, { button: 'left' });
  });

  it('routes scroll events through BrowserSession.scroll', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const scrollSpy = vi.spyOn(session, 'scroll').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(
      new ScrollEvent({
        direction: 'down',
        amount: 640,
      })
    );

    expect(scrollSpy).toHaveBeenCalledWith('down', 640, { node: null });
  });

  it('routes scroll-to-text events through BrowserSession.scroll_to_text', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const scrollToTextSpy = vi
      .spyOn(session, 'scroll_to_text')
      .mockResolvedValue();

    await session.event_bus.dispatch_or_throw(
      new ScrollToTextEvent({
        text: 'checkout',
        direction: 'down',
      })
    );

    expect(scrollToTextSpy).toHaveBeenCalledWith('checkout', {
      direction: 'down',
    });
  });

  it('routes get-dropdown-options events through BrowserSession.get_dropdown_options', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const node = new DOMElementNode(
      true,
      null,
      'select',
      '/html/body/select[1]',
      {},
      []
    );
    const getOptionsSpy = vi
      .spyOn(session, 'get_dropdown_options')
      .mockResolvedValue({
        message: '0: text="One", value="one"',
      } as any);

    await session.event_bus.dispatch_or_throw(
      new GetDropdownOptionsEvent({
        node,
      })
    );

    expect(getOptionsSpy).toHaveBeenCalledWith(node);
  });

  it('routes select-dropdown-option events through BrowserSession.select_dropdown_option', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const node = new DOMElementNode(
      true,
      null,
      'select',
      '/html/body/select[1]',
      {},
      []
    );
    const selectSpy = vi
      .spyOn(session, 'select_dropdown_option')
      .mockResolvedValue({
        message: 'Selected option One (one)',
      } as any);

    await session.event_bus.dispatch_or_throw(
      new SelectDropdownOptionEvent({
        node,
        text: 'One',
      })
    );

    expect(selectSpy).toHaveBeenCalledWith(node, 'One');
  });

  it('returns validation_error when click target is a file input', async () => {
    const session = new BrowserSession();
    const watchdog = new DefaultActionWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const node = new DOMElementNode(
      true,
      null,
      'input',
      '/html/body/input[1]',
      { type: 'file' },
      []
    );
    const result = await session.event_bus.dispatch_or_throw(
      new ClickElementEvent({ node })
    );

    expect(result.event.event_result).toEqual({
      validation_error:
        'The target element is a file input. Use upload_file action instead of click.',
    });
  });

  it('materializes print-button clicks to PDF via CDP and dispatches FileDownloadedEvent', async () => {
    const downloadsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-default-action-print-')
    );
    try {
      const session = new BrowserSession({
        profile: {
          downloads_path: downloadsDir,
        },
      });
      const watchdog = new DefaultActionWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const page = {
        title: vi.fn(async () => 'Quarterly Report'),
        url: vi.fn(() => 'https://example.com/print'),
      } as any;
      const cdpSend = vi.fn(async (method: string) => {
        if (method === 'Page.printToPDF') {
          return {
            data: Buffer.from('%PDF-1.4 test').toString('base64'),
          };
        }
        return {};
      });
      vi.spyOn(session, 'get_current_page').mockResolvedValue(page);
      vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
        send: cdpSend,
      } as any);

      const fileEvents: FileDownloadedEvent[] = [];
      session.event_bus.on(
        'FileDownloadedEvent',
        (event) => {
          fileEvents.push(event as FileDownloadedEvent);
        },
        { handler_id: 'test.default-action.print.downloaded' }
      );

      const node = new DOMElementNode(
        true,
        null,
        'button',
        '/html/body/button[1]',
        {},
        []
      );
      node.children = [new DOMTextNode(true, node, 'Print report')];

      const result = await session.event_bus.dispatch_or_throw(
        new ClickElementEvent({ node })
      );
      const outputPath = result.event.event_result as unknown as string;

      expect(cdpSend).toHaveBeenCalledWith('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: 'ReturnAsStream',
      });
      expect(typeof outputPath).toBe('string');
      expect(outputPath.endsWith('.pdf')).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      }
      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0].path).toBe(outputPath);
      expect(fileEvents[0].mime_type).toBe('application/pdf');
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('blocks print-to-pdf materialization from disallowed current pages', async () => {
    const downloadsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-default-action-print-blocked-')
    );
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: ['https://example.com'],
          downloads_path: downloadsDir,
        }),
      });
      const watchdog = new DefaultActionWatchdog({ browser_session: session });
      let pageUrl = 'https://evil.test/print?token=secret';
      const page = {
        title: vi.fn(async () => 'Secret Report'),
        url: vi.fn(() => pageUrl),
        goto: vi.fn(async (url: string) => {
          pageUrl = url;
        }),
        waitForLoadState: vi.fn(async () => {}),
      } as any;
      const cdpSend = vi.fn(async () => ({
        data: Buffer.from('%PDF-1.4 secret').toString('base64'),
      }));
      vi.spyOn(session, 'get_current_page').mockResolvedValue(page);
      vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
        send: cdpSend,
      } as any);

      await expect(
        (watchdog as any)._handlePrintButtonClick()
      ).rejects.toBeInstanceOf(URLNotAllowedError);

      expect(cdpSend).not.toHaveBeenCalled();
      expect(page.title).not.toHaveBeenCalled();
      expect(page.goto).toHaveBeenCalledWith(
        'about:blank',
        expect.objectContaining({ waitUntil: 'load' })
      );
      expect(fs.readdirSync(downloadsDir)).toHaveLength(0);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('falls back to normal click when print-to-pdf fails', async () => {
    const session = new BrowserSession();
    const watchdog = new DefaultActionWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    vi.spyOn(session, 'get_current_page').mockResolvedValue({
      title: vi.fn(async () => 'Print fallback'),
      url: vi.fn(() => 'https://example.com/fallback'),
    } as any);
    vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
      send: vi.fn(async () => {
        throw new Error('print unavailable');
      }),
    } as any);
    const clickSpy = vi
      .spyOn(session, '_click_element_node')
      .mockResolvedValue(null);

    const node = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      {
        onclick: 'window.print()',
      },
      []
    );
    const result = await session.event_bus.dispatch_or_throw(
      new ClickElementEvent({ node })
    );

    expect(clickSpy).toHaveBeenCalledWith(node);
    expect(result.event.event_result).toBeNull();
  });
});
