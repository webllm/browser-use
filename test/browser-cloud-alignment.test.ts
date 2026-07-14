import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeviceAuthClient } from '../src/sync/auth.js';
import {
  CloudBrowserAuthError,
  CloudBrowserClient,
  CloudBrowserError,
} from '../src/browser/cloud/index.js';

const listenOnLoopback = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
};

const closeServer = async (server: Server) => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

describe('browser cloud alignment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BROWSER_USE_API_KEY;
  });

  it('creates a cloud browser and stores current session id', async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: 'browser-session-1',
          status: 'running',
          liveUrl: 'https://live.browser-use.com/session/1',
          cdpUrl: 'wss://cdp.browser-use.com/session/1',
          timeoutAt: '2026-02-10T00:20:00Z',
          startedAt: '2026-02-10T00:00:00Z',
          finishedAt: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    });

    const client = new CloudBrowserClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'test-api-key',
      fetch_impl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.create_browser({
      cloud_profile_id: 'profile-123',
      cloud_proxy_country_code: 'us',
      cloud_timeout: 25,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalled();
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('https://api.browser-use.test/api/v2/browsers');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Browser-Use-API-Key': 'test-api-key',
      'Content-Type': 'application/json',
    });
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({
      profile_id: 'profile-123',
      proxy_country_code: 'us',
      timeout: 25,
    });

    expect(result.id).toBe('browser-session-1');
    expect(result.cdpUrl).toContain('wss://');
    expect(client.current_session_id).toBe('browser-session-1');
  });

  it.each([
    ['omits an unset proxy', {}, {}],
    [
      'preserves an explicitly disabled cloud proxy',
      { cloud_proxy_country_code: null },
      { proxy_country_code: null },
    ],
    [
      'preserves an explicitly disabled legacy proxy',
      { proxy_country_code: null },
      { proxy_country_code: null },
    ],
    [
      'serializes a configured proxy country',
      { cloud_proxy_country_code: 'de' },
      { proxy_country_code: 'de' },
    ],
    [
      'prefers the cloud proxy alias even when it is null',
      { cloud_proxy_country_code: null, proxy_country_code: 'us' },
      { proxy_country_code: null },
    ],
  ])('%s', async (_label, request, expectedBody) => {
    const fetchImpl = vi.fn(
      async (_url?: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ id: 'browser-proxy', status: 'running' }),
          { status: 200 }
        )
    );
    const client = new CloudBrowserClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'test-api-key',
      fetch_impl: fetchImpl as unknown as typeof fetch,
    });

    await client.create_browser(request);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(expectedBody);
  });

  it('stops browser session and clears current session id', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            id: 'browser-session-stop',
            status: 'stopped',
            liveUrl: 'https://live.browser-use.com/session/stop',
            cdpUrl: 'wss://cdp.browser-use.com/session/stop',
            timeoutAt: '2026-02-10T00:20:00Z',
            startedAt: '2026-02-10T00:00:00Z',
            finishedAt: '2026-02-10T00:10:00Z',
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          id: 'browser-session-stop',
          status: 'running',
          liveUrl: 'https://live.browser-use.com/session/stop',
          cdpUrl: 'wss://cdp.browser-use.com/session/stop',
          timeoutAt: '2026-02-10T00:20:00Z',
          startedAt: '2026-02-10T00:00:00Z',
          finishedAt: null,
        }),
        { status: 200 }
      );
    });
    const client = new CloudBrowserClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'test-api-key',
      fetch_impl: fetchImpl as unknown as typeof fetch,
    });
    client.current_session_id = 'browser-session-stop';

    const result = await client.stop_browser();

    expect(result.status).toBe('stopped');
    expect(client.current_session_id).toBeNull();
    const patchCall = fetchImpl.mock.calls.find(
      ([, init]) => init?.method === 'PATCH'
    );
    expect(patchCall?.[0]).toBe(
      'https://api.browser-use.test/api/v2/browsers/browser-session-stop'
    );
  });

  it('throws CloudBrowserAuthError when no API key is available', async () => {
    vi.spyOn(DeviceAuthClient.prototype, 'api_token', 'get').mockReturnValue(
      null
    );
    const client = new CloudBrowserClient({
      api_base_url: 'https://api.browser-use.test',
      fetch_impl: vi.fn() as unknown as typeof fetch,
    });

    await expect(client.create_browser({})).rejects.toBeInstanceOf(
      CloudBrowserAuthError
    );
  });

  it('maps non-auth HTTP errors to CloudBrowserError', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ detail: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new CloudBrowserClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'test-api-key',
      fetch_impl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.create_browser({})).rejects.toBeInstanceOf(
      CloudBrowserError
    );
  });

  it('times out stalled cloud browser requests', async () => {
    let requestSignal: AbortSignal | null = null;
    const client = new CloudBrowserClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'test-api-key',
      request_timeout_ms: 5,
      fetch_impl: ((_url, init) => {
        requestSignal = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            'abort',
            () => reject(requestSignal?.reason),
            { once: true }
          );
        });
      }) as typeof fetch,
    });

    await expect(client.create_browser({})).rejects.toThrow(
      'HTTP request timed out'
    );
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not forward its API key to a redirect target', async () => {
    let redirectedRequests = 0;
    const redirectTarget = createServer((_request, response) => {
      redirectedRequests += 1;
      response.end('{}');
    });
    const targetPort = await listenOnLoopback(redirectTarget);
    const apiServer = createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${targetPort}/steal`,
      });
      response.end();
    });
    const apiPort = await listenOnLoopback(apiServer);

    try {
      const client = new CloudBrowserClient({
        api_base_url: `http://127.0.0.1:${apiPort}`,
        api_key: 'top-secret-api-key',
      });

      await expect(client.create_browser({})).rejects.toThrow();
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([closeServer(apiServer), closeServer(redirectTarget)]);
    }
  });
});
