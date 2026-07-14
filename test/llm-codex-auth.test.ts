import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAuthError,
  clearCodexTokens,
  codexAccessTokenIsExpiring,
  getCodexAuthStatus,
  getCodexCloudflareHeaders,
  importCodexCliTokens,
  loginCodexDeviceCode,
  readCodexTokens,
  refreshCodexOAuth,
  resolveCodexRuntimeCredentials,
  saveCodexTokens,
} from '../src/llm/codex/auth.js';

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-codex-'));
  tempDirs.push(dir);
  return dir;
};

const b64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const makeJwt = (
  claims: Record<string, unknown> = {
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

const jsonResponse = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

describe('Codex auth store', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it('saves and reads Codex tokens from browser-use auth store only', async () => {
    const configDir = await makeTempDir();
    const codexHome = await makeTempDir();

    await saveCodexTokens(
      { access_token: 'access', refresh_token: 'refresh' },
      { configDir, source: 'test' }
    );

    const record = await readCodexTokens({ configDir });
    expect(record.tokens.access_token).toBe('access');
    expect(record.tokens.refresh_token).toBe('refresh');
    expect(record.source).toBe('test');
    await expect(
      fs.stat(path.join(codexHome, 'auth.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    if (process.platform !== 'win32') {
      expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(configDir, 'auth.json'))).mode & 0o777
      ).toBe(0o600);
    }
  });

  it('reports missing credentials with relogin-required auth error', async () => {
    const configDir = await makeTempDir();

    await expect(readCodexTokens({ configDir })).rejects.toMatchObject({
      code: 'codex_auth_missing',
      relogin_required: true,
    });

    const status = await getCodexAuthStatus({ configDir });
    expect(status.authenticated).toBe(false);
    expect(status.error?.code).toBe('codex_auth_missing');
  });

  it('clears only the browser-use Codex provider state', async () => {
    const configDir = await makeTempDir();
    await saveCodexTokens(
      { access_token: 'access', refresh_token: 'refresh' },
      { configDir }
    );

    await clearCodexTokens({ configDir });

    await expect(readCodexTokens({ configDir })).rejects.toMatchObject({
      code: 'codex_auth_missing',
    });
  });

  it('imports valid Codex CLI tokens without writing to the shared file', async () => {
    const codexHome = await makeTempDir();
    const configDir = await makeTempDir();
    const codexAuthPath = path.join(codexHome, 'auth.json');
    const cliTokens = {
      tokens: {
        access_token: makeJwt(),
        refresh_token: 'cli-refresh',
      },
    };
    await fs.writeFile(codexAuthPath, JSON.stringify(cliTokens), 'utf-8');

    const imported = await importCodexCliTokens({ codexHome });
    expect(imported?.access_token).toBe(cliTokens.tokens.access_token);

    await saveCodexTokens(imported!, { configDir, source: 'codex-cli-import' });
    const sharedAfter = JSON.parse(await fs.readFile(codexAuthPath, 'utf-8'));
    expect(sharedAfter).toEqual(cliTokens);
  });

  it('rejects expired Codex CLI access tokens during import', async () => {
    const codexHome = await makeTempDir();
    await fs.writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: makeJwt({ exp: 1 }),
          refresh_token: 'refresh',
        },
      }),
      'utf-8'
    );

    await expect(importCodexCliTokens({ codexHome })).resolves.toBeNull();
  });

  it('refreshes expiring access tokens under the browser-use lock', async () => {
    const configDir = await makeTempDir();
    await saveCodexTokens(
      { access_token: makeJwt({ exp: 1 }), refresh_token: 'old-refresh' },
      { configDir }
    );
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      })
    );

    const resolved = await resolveCodexRuntimeCredentials({
      configDir,
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(resolved.api_key).toBe('new-access');
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe('https://auth.openai.com/oauth/token');
    expect(String((request?.[1] as RequestInit).body)).toContain(
      'refresh_token=old-refresh'
    );
    expect((request?.[1] as RequestInit).redirect).toBe('error');
    const stored = await readCodexTokens({ configDir });
    expect(stored.tokens.refresh_token).toBe('new-refresh');
  });

  it('maps refresh_token_reused to a relogin-required CodexAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: {
          code: 'refresh_token_reused',
          message: 'already used',
        },
      })
    );

    await expect(
      refreshCodexOAuth('access', 'refresh', {
        fetchImplementation: fetchMock as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: 'refresh_token_reused',
      relogin_required: true,
    });
  });

  it('rejects oversized Codex token refresh responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      })
    );

    await expect(
      refreshCodexOAuth('access', 'refresh', {
        fetchImplementation: fetchMock as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: 'codex_refresh_invalid_json',
      relogin_required: true,
    });
  });

  it('rejects oversized Codex device-code responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      })
    );

    await expect(
      loginCodexDeviceCode({ fetchImplementation: fetchMock as typeof fetch })
    ).rejects.toMatchObject({ code: 'device_code_invalid_response' });
  });

  it('bounds Codex refresh error response bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 401,
        headers: { 'content-length': String(64 * 1024 + 1) },
      })
    );

    await expect(
      refreshCodexOAuth('access', 'refresh', {
        fetchImplementation: fetchMock as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: 'codex_refresh_failed',
      relogin_required: true,
    });
  });

  it('extracts Codex Cloudflare account headers from access-token claims', () => {
    const token = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-test',
      },
    });

    const headers = getCodexCloudflareHeaders(token);

    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers['User-Agent']).toContain('codex_cli_rs');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-test');
    expect(getCodexCloudflareHeaders('not-a-jwt')).not.toHaveProperty(
      'ChatGPT-Account-ID'
    );
  });

  it('detects JWT access token expiry with skew', () => {
    const nowMs = 1_000_000;
    expect(codexAccessTokenIsExpiring(makeJwt({ exp: 1001 }), 5, nowMs)).toBe(
      true
    );
    expect(codexAccessTokenIsExpiring(makeJwt({ exp: 2000 }), 5, nowMs)).toBe(
      false
    );
    expect(codexAccessTokenIsExpiring('opaque-token', 5, nowMs)).toBe(false);
  });

  it('runs the Codex device code flow without persisting tokens', async () => {
    const responses = [
      jsonResponse(200, {
        user_code: 'ABCD-EFGH',
        device_auth_id: 'device-1',
        interval: 1,
      }),
      jsonResponse(403, {}),
      jsonResponse(200, {
        authorization_code: 'auth-code',
        code_verifier: 'verifier',
      }),
      jsonResponse(200, {
        access_token: 'device-access',
        refresh_token: 'device-refresh',
      }),
    ];
    const fetchMock = vi.fn().mockImplementation(async () => responses.shift());
    let now = 0;
    const output: string[] = [];

    const credentials = await loginCodexDeviceCode({
      fetchImplementation: fetchMock as typeof fetch,
      issuer: 'https://auth.test',
      sleep: async () => {
        now += 1000;
      },
      now: () => now,
      maxWaitMs: 10_000,
      stdout: { write: (chunk: string) => output.push(chunk) } as any,
    });

    expect(credentials.tokens.access_token).toBe('device-access');
    expect(output.join('')).toContain('ABCD-EFGH');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://auth.test/api/accounts/deviceauth/usercode',
      'https://auth.test/api/accounts/deviceauth/token',
      'https://auth.test/api/accounts/deviceauth/token',
      'https://auth.test/oauth/token',
    ]);
  });

  it('uses CodexAuthError for missing refresh tokens before network calls', async () => {
    await expect(refreshCodexOAuth('access', '')).rejects.toBeInstanceOf(
      CodexAuthError
    );
  });

  it('does not forward refresh tokens to a redirect target', async () => {
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
    const authServer = createServer((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${targetPort}/steal`,
      });
      response.end();
    });
    const authPort = await listenOnLoopback(authServer);

    try {
      await expect(
        refreshCodexOAuth('access-token', 'refresh-token-secret', {
          tokenUrl: `http://127.0.0.1:${authPort}/oauth/token`,
        })
      ).rejects.toThrow();
      expect(redirectedRequests).toBe(0);
      expect(redirectedBody).toBe('');
    } finally {
      await Promise.all([closeServer(authServer), closeServer(redirectTarget)]);
    }
  });
});
