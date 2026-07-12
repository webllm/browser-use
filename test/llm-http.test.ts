import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ChatOpenAI } from '../src/llm/openai/chat.js';
import { ChatGoogle } from '../src/llm/google/chat.js';
import { UserMessage } from '../src/llm/messages.js';
import {
  createNoRedirectFetch,
  rejectRedirectsInFetchOptions,
} from '../src/llm/http.js';

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

describe('LLM HTTP redirect safety', () => {
  it('forces redirect rejection in fetch options and custom fetches', async () => {
    expect(
      rejectRedirectsInFetchOptions({
        cache: 'no-store',
        redirect: 'follow',
      })
    ).toEqual({ cache: 'no-store', redirect: 'error' });

    const customFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}')
    );
    const safeFetch = createNoRedirectFetch(customFetch);
    await safeFetch('https://example.test', {
      cache: 'no-store',
      redirect: 'follow',
    });

    expect(customFetch).toHaveBeenCalledWith(
      'https://example.test',
      expect.objectContaining({
        cache: 'no-store',
        redirect: 'error',
      })
    );
  });

  it('does not forward OpenAI-compatible prompts to a redirect target', async () => {
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
    const apiServer = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetPort}/steal`,
      });
      response.end();
    });
    const apiPort = await listenOnLoopback(apiServer);

    try {
      const llm = new ChatOpenAI({
        apiKey: 'top-secret-api-key',
        baseURL: `http://127.0.0.1:${apiPort}/v1`,
        maxRetries: 0,
      });

      await expect(
        llm.ainvoke([new UserMessage('prompt-secret')])
      ).rejects.toThrow();
      expect(redirectedRequests).toBe(0);
      expect(redirectedBody).toBe('');
    } finally {
      await Promise.all([closeServer(apiServer), closeServer(redirectTarget)]);
    }
  });

  it('does not forward Google prompts to a redirect target', async () => {
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
    const apiServer = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetPort}/steal`,
      });
      response.end();
    });
    const apiPort = await listenOnLoopback(apiServer);

    try {
      const llm = new ChatGoogle({
        apiKey: 'top-secret-api-key',
        httpOptions: {
          baseUrl: `http://127.0.0.1:${apiPort}`,
        },
        maxRetries: 1,
      });

      await expect(
        llm.ainvoke([new UserMessage('prompt-secret')])
      ).rejects.toThrow();
      expect(redirectedRequests).toBe(0);
      expect(redirectedBody).toBe('');
    } finally {
      await Promise.all([closeServer(apiServer), closeServer(redirectTarget)]);
    }
  });
});
