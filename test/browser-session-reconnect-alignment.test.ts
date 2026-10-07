import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';

class MockBrowser extends EventEmitter {
  private connected = true;

  constructor(private readonly browserContexts: any[]) {
    super();
  }

  contexts() {
    return this.browserContexts;
  }

  isConnected() {
    return this.connected;
  }

  disconnectUnexpectedly() {
    this.connected = false;
    this.emit('disconnected');
  }
}

const createPage = (url: string, title: string) =>
  ({
    isClosed: () => false,
    url: () => url,
    title: vi.fn(async () => title),
  }) as any;

const createContext = (page: any) =>
  ({
    pages: () => [page],
    newPage: vi.fn(async () => page),
    setExtraHTTPHeaders: vi.fn(async () => {}),
    browser: () => null,
  }) as any;

describe('browser session reconnect alignment', () => {
  it('automatically reconnects remote CDP sessions after unexpected disconnects', async () => {
    const firstPage = createPage('https://first.example', 'First');
    const secondPage = createPage('https://second.example', 'Second');
    const firstContext = createContext(firstPage);
    const secondContext = createContext(secondPage);
    const firstBrowser = new MockBrowser([firstContext]);
    const secondBrowser = new MockBrowser([secondContext]);
    firstContext.browser = () => firstBrowser;
    secondContext.browser = () => secondBrowser;

    const connectOverCDP = vi
      .fn()
      .mockResolvedValueOnce(firstBrowser as any)
      .mockResolvedValueOnce(secondBrowser as any);

    const session = new BrowserSession({
      cdp_url: 'ws://localhost:9222/devtools/browser/test',
      playwright: {
        chromium: {
          connectOverCDP,
        },
      } as any,
    });

    vi.spyOn(session, 'attach_default_watchdogs').mockImplementation(() => {});
    const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');

    await session.start();
    expect(connectOverCDP).toHaveBeenNthCalledWith(
      1,
      'ws://localhost:9222/devtools/browser/test',
      expect.objectContaining({
        slowMo: session.browser_profile.config.slow_mo,
        timeout: session.browser_profile.config.timeout,
      })
    );

    firstBrowser.disconnectUnexpectedly();

    await vi.waitFor(() => {
      expect(connectOverCDP).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(session.is_reconnecting).toBe(false);
    });

    const currentPage = await session.get_current_page();
    expect(currentPage).toBe(secondPage);
    expect(session.browser_context).toBe(secondContext);

    const dispatchedEvents = dispatchSpy.mock.calls.map(([event]) => event);
    const dispatchedTypes = dispatchedEvents.map(
      (event) =>
        (event as { event_type?: string }).event_type ??
        (event as { constructor?: { name?: string } }).constructor?.name
    );

    expect(dispatchedTypes).toContain('BrowserStoppedEvent');
    expect(dispatchedTypes).toContain('BrowserReconnectingEvent');
    expect(dispatchedTypes).toContain('BrowserReconnectedEvent');
    expect(
      dispatchedTypes.filter(
        (eventType) => eventType === 'BrowserConnectedEvent'
      )
    ).toHaveLength(2);

    const reconnectingIndex = dispatchedTypes.lastIndexOf(
      'BrowserReconnectingEvent'
    );
    const connectedIndex = dispatchedTypes.lastIndexOf('BrowserConnectedEvent');
    const reconnectedIndex = dispatchedTypes.lastIndexOf(
      'BrowserReconnectedEvent'
    );

    expect(connectedIndex).toBeGreaterThan(reconnectingIndex);
    expect(reconnectedIndex).toBeGreaterThan(connectedIndex);
    expect(
      dispatchedEvents.find(
        (event) =>
          (event as { event_type?: string }).event_type ===
            'BrowserStoppedEvent' &&
          (event as { reason?: string | null }).reason === 'connection_lost'
      )
    ).toBeDefined();
  });

  it('reconnects again when the new connection drops during the reconnect window', async () => {
    const firstPage = createPage('https://first.example', 'First');
    const secondPage = createPage('https://second.example', 'Second');
    const thirdPage = createPage('https://third.example', 'Third');
    const firstContext = createContext(firstPage);
    const secondContext = createContext(secondPage);
    const thirdContext = createContext(thirdPage);
    const firstBrowser = new MockBrowser([firstContext]);
    const secondBrowser = new MockBrowser([secondContext]);
    const thirdBrowser = new MockBrowser([thirdContext]);
    firstContext.browser = () => firstBrowser;
    secondContext.browser = () => secondBrowser;
    thirdContext.browser = () => thirdBrowser;

    const connectOverCDP = vi
      .fn()
      .mockResolvedValueOnce(firstBrowser as any)
      .mockResolvedValueOnce(secondBrowser as any)
      .mockResolvedValueOnce(thirdBrowser as any);

    const session = new BrowserSession({
      cdp_url: 'ws://localhost:9222/devtools/browser/test',
      playwright: {
        chromium: {
          connectOverCDP,
        },
      } as any,
    });

    vi.spyOn(session, 'attach_default_watchdogs').mockImplementation(() => {});
    await session.start();

    let droppedDuringReconnect = false;
    session.event_bus.on('BrowserReconnectedEvent', () => {
      if (!droppedDuringReconnect) {
        droppedDuringReconnect = true;
        // The reconnect is still marked as running while this event is handled.
        expect(session.is_reconnecting).toBe(true);
        secondBrowser.disconnectUnexpectedly();
      }
    });

    firstBrowser.disconnectUnexpectedly();

    await vi.waitFor(() => {
      expect(connectOverCDP).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(session.is_reconnecting).toBe(false);
    });

    expect(droppedDuringReconnect).toBe(true);
    expect(session.browser_context).toBe(thirdContext);
    await expect(session.get_current_page()).resolves.toBe(thirdPage);
  });
});
