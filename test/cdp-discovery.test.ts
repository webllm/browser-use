import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverLocalCdpWebSocketUrl,
  readDevToolsActivePort,
} from '../src/browser/cdp-discovery.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const createTemporaryDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-cdp-'));
  temporaryDirectories.push(directory);
  return directory;
};

describe('DevToolsActivePort reads', () => {
  it('reads a valid bounded regular file', () => {
    const directory = createTemporaryDirectory();
    const activePortPath = path.join(directory, 'DevToolsActivePort');
    fs.writeFileSync(
      activePortPath,
      '9222\n/devtools/browser/browser-id\n',
      'utf8'
    );

    expect(readDevToolsActivePort(activePortPath)).toEqual({
      port: 9222,
      browserPath: '/devtools/browser/browser-id',
    });
  });

  it('does not follow a replacement symlink while opening the file', () => {
    if (process.platform === 'win32') return;
    const directory = createTemporaryDirectory();
    const activePortPath = path.join(directory, 'DevToolsActivePort');
    const replacementPath = path.join(directory, 'replacement');
    fs.writeFileSync(activePortPath, '9222\n/devtools/browser/original\n');
    fs.writeFileSync(replacementPath, '9333\n/devtools/browser/replacement\n');
    const originalOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementationOnce((...args) => {
      fs.rmSync(activePortPath);
      fs.symlinkSync(replacementPath, activePortPath);
      return originalOpenSync(...args);
    });

    expect(readDevToolsActivePort(activePortPath)).toBeNull();
  });

  it('rejects files that grow beyond the read limit', () => {
    const directory = createTemporaryDirectory();
    const activePortPath = path.join(directory, 'DevToolsActivePort');
    fs.writeFileSync(activePortPath, 'x'.repeat(4 * 1024 + 1));

    expect(readDevToolsActivePort(activePortPath)).toBeNull();
  });
});

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
