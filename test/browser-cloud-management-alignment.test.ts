import { describe, expect, it } from 'vitest';
import { CloudManagementClient } from '../src/browser/cloud/management.js';
import { CloudBrowserError } from '../src/browser/cloud/views.js';

describe('browser cloud management alignment', () => {
  it('calls task management endpoints with browser-use auth headers', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new CloudManagementClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'bu_test_key',
      fetch_impl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [],
              totalItems: 0,
              pageNumber: 1,
              pageSize: 10,
            }),
        } as Response;
      }) as typeof fetch,
    });

    const result = await client.list_tasks({
      pageSize: 10,
      filterBy: 'started',
      sessionId: 'session-1',
    });

    expect(result.totalItems).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      'https://api.browser-use.test/api/v2/tasks?pageSize=10&filterBy=started&sessionId=session-1'
    );
    expect(
      (requests[0]!.init.headers as Record<string, string>)[
        'X-Browser-Use-API-Key'
      ]
    ).toBe('bu_test_key');
    expect(requests[0]!.init.redirect).toBe('error');
  });

  it('supports session and profile lifecycle endpoints', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const payloads = [
      {
        id: 'session-1',
        status: 'active',
        startedAt: '2026-03-18T10:00:00Z',
        liveUrl: 'https://live.browser-use.com/session-1',
      },
      {
        id: 'profile-1',
        createdAt: '2026-03-18T10:00:00Z',
        updatedAt: '2026-03-18T10:00:00Z',
        name: 'Primary',
      },
      {
        id: 'profile-1',
        createdAt: '2026-03-18T10:00:00Z',
        updatedAt: '2026-03-18T10:05:00Z',
        name: 'Renamed',
      },
      {},
    ];
    let index = 0;
    const client = new CloudManagementClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'bu_test_key',
      fetch_impl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        const payload = payloads[index] ?? {};
        index += 1;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
        } as Response;
      }) as typeof fetch,
    });

    const session = await client.create_session({
      profileId: 'profile-1',
      proxyCountryCode: 'us',
    });
    const profile = await client.get_profile('profile-1');
    const updated = await client.update_profile('profile-1', {
      name: 'Renamed',
    });
    await client.delete_profile('profile-1');

    expect(session.id).toBe('session-1');
    expect(profile.name).toBe('Primary');
    expect(updated.name).toBe('Renamed');
    expect(requests[0]!.url).toBe(
      'https://api.browser-use.test/api/v2/sessions'
    );
    expect(requests[0]!.init.method).toBe('POST');
    expect(requests[1]!.url).toBe(
      'https://api.browser-use.test/api/v2/profiles/profile-1'
    );
    expect(requests[1]!.init.method).toBe('GET');
    expect(requests[2]!.url).toBe(
      'https://api.browser-use.test/api/v2/profiles/profile-1'
    );
    expect(requests[2]!.init.method).toBe('PATCH');
    expect(requests[2]!.init.body).toBe(JSON.stringify({ name: 'Renamed' }));
    expect(requests[3]!.url).toBe(
      'https://api.browser-use.test/api/v2/profiles/profile-1'
    );
    expect(requests[3]!.init.method).toBe('DELETE');
  });

  it('surfaces non-json cloud management errors as CloudBrowserError', async () => {
    const client = new CloudManagementClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'bu_test_key',
      fetch_impl: (async () =>
        ({
          ok: false,
          status: 502,
          text: async () => '<html>bad gateway</html>',
        }) as Response) as typeof fetch,
    });

    await expect(client.list_sessions()).rejects.toEqual(
      expect.objectContaining<Partial<CloudBrowserError>>({
        name: 'CloudBrowserError',
        message: 'Cloud API request failed (502): <html>bad gateway</html>',
      })
    );
  });

  it('times out stalled cloud management requests', async () => {
    let requestSignal: AbortSignal | null = null;
    const client = new CloudManagementClient({
      api_base_url: 'https://api.browser-use.test',
      api_key: 'bu_test_key',
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

    await expect(client.list_tasks()).rejects.toThrow('HTTP request timed out');
    expect(requestSignal?.aborted).toBe(true);
  });
});
