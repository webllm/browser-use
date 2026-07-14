import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CloudSkillService,
  MAX_SKILL_EXECUTION_REQUEST_BYTES,
  MAX_SKILL_EXECUTION_RESPONSE_BYTES,
} from '../src/skills/service.js';

const makeSkillItem = (id: string, title = id) => ({
  id,
  title,
  description: `Skill ${title}`,
  status: 'finished',
  parameters: [{ name: 'query', type: 'string', required: true }],
  output_schema: {},
});

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

describe('CloudSkillService alignment', () => {
  it('exposes cached skills through get_skill()', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [makeSkillItem('skill-1', 'Skill One')],
      }),
    }));

    const service = new CloudSkillService({
      skill_ids: ['skill-1'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const skill = await service.get_skill('skill-1');
    expect(skill?.title).toBe('Skill One');
    expect(await service.get_skill('missing')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(firstCall[1]).toMatchObject({ redirect: 'error' });
  });

  it('keeps initialization failure one-shot to avoid retry loops', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });

    const service = new CloudSkillService({
      skill_ids: ['*'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    await expect(service.get_all_skills()).rejects.toThrow('network down');
    await expect(service.get_all_skills()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out stalled skill API requests', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new Error('aborted')),
              { once: true }
            );
          })
      );
      const service = new CloudSkillService({
        skill_ids: ['*'],
        api_key: 'test-key',
        base_url: 'https://api.test',
        fetch_impl: fetchMock as typeof fetch,
        request_timeout_ms: 25,
      });

      const request = service.get_all_skills();
      const expectedRejection = expect(request).rejects.toThrow(
        'HTTP request timed out'
      );
      await vi.advanceTimersByTimeAsync(25);

      await expectedRejection;
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads wildcard skills from only the first page', async () => {
    const pageItems = Array.from({ length: 150 }, (_, index) =>
      makeSkillItem(`skill-${index}`)
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: pageItems }),
    }));

    const service = new CloudSkillService({
      skill_ids: ['*'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const skills = await service.get_all_skills();
    expect(skills).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds skill metadata before building action schemas', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            ...makeSkillItem('skill-1', 'x'.repeat(1_000)),
            description: 'd'.repeat(20_000),
            parameters: [
              { name: '__proto__', type: 'string' },
              ...Array.from({ length: 300 }, (_, index) => ({
                name: `field_${index}`,
                type: 'string',
                description: 'p'.repeat(5_000),
              })),
            ],
          },
        ],
      }),
    }));
    const service = new CloudSkillService({
      skill_ids: ['*'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const [skill] = await service.get_all_skills();
    expect(skill?.title).toHaveLength(512);
    expect(skill?.description).toHaveLength(16 * 1024);
    expect(skill?.parameters).toHaveLength(255);
    expect(skill?.parameters[0]?.description).toHaveLength(4 * 1024);
    expect(skill?.parameters.some((param) => param.name === '__proto__')).toBe(
      false
    );
  });

  it('rejects unbounded requested skill IDs', () => {
    expect(
      () =>
        new CloudSkillService({
          skill_ids: Array(501).fill('skill'),
          api_key: 'test-key',
        })
    ).toThrow(/cannot exceed 500/);
    expect(
      () =>
        new CloudSkillService({
          skill_ids: ['x'.repeat(257)],
          api_key: 'test-key',
        })
    ).toThrow(/between 1 and 256/);
  });

  it('filters explicit skill IDs and excludes unavailable ones', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [makeSkillItem('skill-a'), makeSkillItem('skill-b')],
      }),
    }));

    const service = new CloudSkillService({
      skill_ids: ['skill-a', 'skill-missing'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const skills = await service.get_all_skills();
    expect(skills.map((entry) => entry.id)).toEqual(['skill-a']);
  });

  it('returns python-aligned execute failure envelope with error type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [makeSkillItem('skill-1')],
        }),
      })
      .mockRejectedValueOnce(new Error('boom'));

    const service = new CloudSkillService({
      skill_ids: ['skill-1'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const result = await service.execute_skill({
      skill_id: 'skill-1',
      parameters: { query: 'weather' },
      cookies: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to execute skill: Error: boom');
  });

  it('rejects oversized skill execution responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [makeSkillItem('skill-1')] }),
      })
      .mockResolvedValueOnce(
        new Response('not-read', {
          status: 200,
          headers: {
            'content-length': String(MAX_SKILL_EXECUTION_RESPONSE_BYTES + 1),
          },
        })
      );
    const service = new CloudSkillService({
      skill_ids: ['skill-1'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const result = await service.execute_skill({
      skill_id: 'skill-1',
      parameters: { query: 'weather' },
      cookies: [],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      `maximum size of ${MAX_SKILL_EXECUTION_RESPONSE_BYTES.toLocaleString()} bytes`
    );
  });

  it('rejects oversized skill execution requests before sending them', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            ...makeSkillItem('skill-1'),
            parameters: [
              {
                name: 'query',
                type: 'string',
                required: true,
              },
            ],
          },
        ],
      }),
    });
    const service = new CloudSkillService({
      skill_ids: ['skill-1'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const result = await service.execute_skill({
      skill_id: 'skill-1',
      parameters: {
        query: 'x'.repeat(MAX_SKILL_EXECUTION_REQUEST_BYTES + 1),
      },
      cookies: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Skill execution request exceeds');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not forward cookie parameters to a redirect target', async () => {
    let redirectedRequests = 0;
    let redirectedBody = '';
    const redirectTarget = createServer((request, response) => {
      redirectedRequests += 1;
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        redirectedBody += chunk;
      });
      request.on('end', () => response.end('{}'));
    });
    const targetPort = await listenOnLoopback(redirectTarget);
    const apiServer = createServer((request, response) => {
      if (request.url?.startsWith('/api/v1/skills?')) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            items: [
              {
                ...makeSkillItem('skill-cookie'),
                parameters: [
                  { name: 'query', type: 'string', required: true },
                  {
                    name: 'session_cookie',
                    type: 'cookie',
                    required: true,
                  },
                ],
              },
            ],
          })
        );
        return;
      }
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetPort}/steal`,
      });
      response.end();
    });
    const apiPort = await listenOnLoopback(apiServer);

    try {
      const service = new CloudSkillService({
        skill_ids: ['skill-cookie'],
        api_key: 'top-secret-api-key',
        base_url: `http://127.0.0.1:${apiPort}`,
      });

      const result = await service.execute_skill({
        skill_id: 'skill-cookie',
        parameters: { query: 'weather' },
        cookies: [{ name: 'session_cookie', value: 'cookie-secret' }],
      });

      expect(result.success).toBe(false);
      expect(redirectedRequests).toBe(0);
      expect(redirectedBody).toBe('');
    } finally {
      await Promise.all([closeServer(apiServer), closeServer(redirectTarget)]);
    }
  });
});
