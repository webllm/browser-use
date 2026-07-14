import { describe, expect, it, vi } from 'vitest';
import { discoverLocalCdpWebSocketUrl } from '../src/browser/cdp-discovery.js';

describe('local CDP discovery', () => {
  it('accepts a bounded loopback browser websocket endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          webSocketDebuggerUrl:
            'ws://127.0.0.1:9222/devtools/browser/browser-id',
        }),
        { status: 200 }
      )
    );

    await expect(
      discoverLocalCdpWebSocketUrl({
        port: 9222,
        fetchImplementation: fetchMock as typeof fetch,
      })
    ).resolves.toBe('ws://127.0.0.1:9222/devtools/browser/browser-id');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it.each([
    'ws://example.com:9222/devtools/browser/browser-id',
    'ws://127.0.0.1:9333/devtools/browser/browser-id',
    'wss://127.0.0.1:9222/devtools/browser/browser-id',
    'ws://127.0.0.1:9222/devtools/page/page-id',
  ])(
    'rejects unexpected websocket endpoint %s',
    async (webSocketDebuggerUrl) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ webSocketDebuggerUrl }), {
          status: 200,
        })
      );

      await expect(
        discoverLocalCdpWebSocketUrl({
          port: 9222,
          fetchImplementation: fetchMock as typeof fetch,
        })
      ).resolves.toBeNull();
    }
  );

  it('rejects oversized version responses before reading them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 + 1) },
      })
    );

    await expect(
      discoverLocalCdpWebSocketUrl({
        port: 9222,
        fetchImplementation: fetchMock as typeof fetch,
      })
    ).resolves.toBeNull();
  });

  it('times out while reading a stalled version response', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener(
                'abort',
                () => controller.error(new Error('aborted')),
                { once: true }
              );
            },
          }),
          { status: 200 }
        );
      }
    );

    await expect(
      discoverLocalCdpWebSocketUrl({
        port: 9222,
        timeoutMs: 20,
        fetchImplementation: fetchMock as typeof fetch,
      })
    ).resolves.toBeNull();
  });
});
