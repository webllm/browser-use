import fs from 'node:fs';
import { readBoundedResponseJson } from '../http-response.js';

const MAX_CDP_VERSION_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CDP_PROBE_TIMEOUT_MS = 1_000;
const MAX_DEVTOOLS_ACTIVE_PORT_BYTES = 4 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface DevToolsActivePort {
  port: number;
  browserPath: string;
}

export const readDevToolsActivePort = (
  activePortPath: string
): DevToolsActivePort | null => {
  try {
    const stats = fs.lstatSync(activePortPath);
    if (!stats.isFile() || stats.size > MAX_DEVTOOLS_ACTIVE_PORT_BYTES) {
      return null;
    }
    const raw = fs.readFileSync(activePortPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_DEVTOOLS_ACTIVE_PORT_BYTES) {
      return null;
    }
    const [portText, rawBrowserPath] = raw.split(/\r?\n/, 2);
    const browserPath = rawBrowserPath ?? '';
    if (!/^\d+$/.test(portText ?? '')) {
      return null;
    }
    const port = Number(portText);
    if (
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !/^\/devtools\/browser\/[^/\s]+$/.test(browserPath)
    ) {
      return null;
    }
    return { port, browserPath };
  } catch {
    return null;
  }
};

const isExpectedLocalWebSocketUrl = (value: unknown, port: number) => {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'ws:' &&
      LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()) &&
      Number(url.port) === port &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/devtools/browser/')
    );
  } catch {
    return false;
  }
};

export const discoverLocalCdpWebSocketUrl = async (options: {
  port: number;
  host?: '127.0.0.1' | 'localhost';
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}): Promise<string | null> => {
  const { port } = options;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  const host = options.host === 'localhost' ? 'localhost' : '127.0.0.1';
  const requestedTimeout = options.timeoutMs ?? DEFAULT_CDP_PROBE_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.floor(requestedTimeout))
    : DEFAULT_CDP_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | null = null;
  try {
    response = await (options.fetchImplementation ?? fetch)(
      `http://${host}:${port}/json/version`,
      {
        signal: controller.signal,
        redirect: 'error',
      }
    );
    if (!response.ok) {
      return null;
    }
    const payload = await readBoundedResponseJson(
      response,
      MAX_CDP_VERSION_RESPONSE_BYTES
    );
    const webSocketDebuggerUrl =
      payload && typeof payload === 'object'
        ? (payload as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
        : null;
    return isExpectedLocalWebSocketUrl(webSocketDebuggerUrl, port)
      ? (webSocketDebuggerUrl as string)
      : null;
  } catch {
    return null;
  } finally {
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => undefined);
    }
    clearTimeout(timeout);
  }
};
