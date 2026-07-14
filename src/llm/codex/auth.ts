import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../../config.js';
import { readBoundedResponseJson } from '../../http-response.js';

export const CODEX_PROVIDER = 'openai-codex';
export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_DEVICE_AUTH_BASE_URL = 'https://auth.openai.com';
export const CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;

const AUTH_STORE_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const MAX_CODEX_AUTH_RESPONSE_BYTES = 1024 * 1024;
const MAX_CODEX_AUTH_ERROR_BYTES = 64 * 1024;
export const MAX_CODEX_AUTH_FILE_BYTES = 1024 * 1024;

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  [key: string]: unknown;
}

interface CodexProviderState {
  tokens?: Partial<CodexTokens>;
  last_refresh?: string | null;
  auth_mode?: string;
  source?: string;
  [key: string]: unknown;
}

interface CodexAuthStore {
  version?: number;
  active_provider?: string;
  providers?: Record<string, CodexProviderState | undefined>;
}

export interface CodexTokenRecord {
  tokens: CodexTokens;
  last_refresh: string | null;
  auth_mode: string | null;
  source: string | null;
}

export interface CodexRuntimeCredentials {
  provider: typeof CODEX_PROVIDER;
  base_url: string;
  api_key: string;
  source: string;
  last_refresh: string | null;
  auth_mode: 'chatgpt';
}

export interface CodexAuthStatus {
  authenticated: boolean;
  auth_store_path: string;
  provider: typeof CODEX_PROVIDER;
  base_url: string;
  source: string | null;
  last_refresh: string | null;
  access_token_expiring: boolean | null;
  error?: {
    code: string;
    message: string;
    relogin_required: boolean;
  };
}

export class CodexAuthError extends Error {
  provider = CODEX_PROVIDER;
  code: string;
  relogin_required: boolean;

  constructor(
    message: string,
    code = 'codex_auth_error',
    reloginRequired = false
  ) {
    super(message);
    this.name = 'CodexAuthError';
    this.code = code;
    this.relogin_required = reloginRequired;
  }
}

interface AuthPathOptions {
  configDir?: string | null;
  authStorePath?: string | null;
}

interface FetchOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export interface RefreshCodexOAuthOptions extends FetchOptions {
  tokenUrl?: string;
  clientId?: string;
}

export interface ResolveCodexRuntimeCredentialsOptions
  extends RefreshCodexOAuthOptions, AuthPathOptions {
  forceRefresh?: boolean;
  refreshIfExpiring?: boolean;
  refreshSkewSeconds?: number;
  lockTimeoutMs?: number;
  baseURL?: string | null;
}

export interface DeviceCodeLoginOptions extends FetchOptions {
  issuer?: string;
  clientId?: string;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString().replace('+00:00', 'Z');

const expandHome = (value: string) => {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

const resolveBaseConfigDir = (configDir?: string | null) =>
  configDir
    ? path.resolve(expandHome(configDir))
    : (CONFIG.BROWSER_USE_CONFIG_DIR ??
      path.join(os.homedir(), '.config', 'browseruse'));

export const getCodexAuthStorePath = (options: AuthPathOptions = {}) =>
  options.authStorePath
    ? path.resolve(expandHome(options.authStorePath))
    : path.join(resolveBaseConfigDir(options.configDir), 'auth.json');

const chmodPrivatePath = async (targetPath: string, mode: number) => {
  if (process.platform === 'win32') {
    return;
  }
  try {
    await fs.chmod(targetPath, mode);
  } catch {
    /* best effort */
  }
};

const ensurePrivateDirectory = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await chmodPrivatePath(dirPath, 0o700);
};

const normalizeStore = (store: CodexAuthStore): CodexAuthStore => ({
  version: AUTH_STORE_VERSION,
  ...store,
  providers:
    store.providers &&
    typeof store.providers === 'object' &&
    !Array.isArray(store.providers)
      ? store.providers
      : {},
});

const readBoundedAuthFile = async (
  filePath: string,
  label: string,
  code: string
): Promise<string> => {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile()) {
    throw new CodexAuthError(`${label} is not a regular file.`, code, true);
  }
  if (stats.size > MAX_CODEX_AUTH_FILE_BYTES) {
    throw new CodexAuthError(
      `${label} exceeds ${MAX_CODEX_AUTH_FILE_BYTES} bytes.`,
      code,
      true
    );
  }
  const raw = await fs.readFile(filePath, 'utf-8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_CODEX_AUTH_FILE_BYTES) {
    throw new CodexAuthError(
      `${label} exceeds ${MAX_CODEX_AUTH_FILE_BYTES} bytes.`,
      code,
      true
    );
  }
  return raw;
};

const readStore = async (authStorePath: string): Promise<CodexAuthStore> => {
  try {
    const raw = await readBoundedAuthFile(
      authStorePath,
      'Codex auth store',
      'codex_auth_store_invalid_file'
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CodexAuthError(
        'Codex auth store contains invalid JSON.',
        'codex_auth_store_invalid_json',
        true
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CodexAuthError(
        'Codex auth store must contain a JSON object.',
        'codex_auth_store_invalid_shape',
        true
      );
    }
    return normalizeStore(parsed as CodexAuthStore);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return normalizeStore({});
    }
    throw error;
  }
};

const writeStore = async (
  authStorePath: string,
  store: CodexAuthStore
): Promise<void> => {
  await ensurePrivateDirectory(path.dirname(authStorePath));
  const tmpPath = `${authStorePath}.${process.pid}.${randomUUID()}.tmp`;
  const serializedStore = JSON.stringify(normalizeStore(store), null, 2);
  if (Buffer.byteLength(serializedStore, 'utf8') > MAX_CODEX_AUTH_FILE_BYTES) {
    throw new CodexAuthError(
      `Codex auth store exceeds ${MAX_CODEX_AUTH_FILE_BYTES} bytes.`,
      'codex_auth_store_too_large'
    );
  }
  await fs.writeFile(tmpPath, serializedStore, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await chmodPrivatePath(tmpPath, 0o600);
  await fs.rename(tmpPath, authStorePath);
  await chmodPrivatePath(authStorePath, 0o600);
};

const waitForLockRetry = async (start: number, timeoutMs: number) => {
  if (Date.now() - start >= timeoutMs) {
    throw new CodexAuthError(
      'Timed out waiting for the Codex auth store lock.',
      'codex_auth_lock_timeout'
    );
  }
  await sleep(50);
};

const withAuthStoreLock = async <T>(
  authStorePath: string,
  callback: () => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS
): Promise<T> => {
  const lockPath = `${authStorePath}.lock`;
  const lockDir = path.dirname(lockPath);
  await ensurePrivateDirectory(lockDir);

  const start = Date.now();
  const staleMs = Math.max(timeoutMs * 2, 30_000);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          created_at: nowIso(),
        })
      );
      await handle.close();
      handle = null;
      break;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'EEXIST') {
        throw error;
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        const statNodeError = statError as NodeJS.ErrnoException;
        if (statNodeError.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      await waitForLockRetry(start, timeoutMs);
    }
  }

  try {
    return await callback();
  } finally {
    try {
      await fs.unlink(lockPath);
    } catch {
      /* best effort */
    }
  }
};

const requireTokenString = (
  value: unknown,
  code: string,
  message: string
): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CodexAuthError(message, code, true);
  }
  return value.trim();
};

export const readCodexTokens = async (
  options: AuthPathOptions = {}
): Promise<CodexTokenRecord> => {
  const authStorePath = getCodexAuthStorePath(options);
  const store = await readStore(authStorePath);
  const state = store.providers?.[CODEX_PROVIDER];

  if (!state) {
    throw new CodexAuthError(
      'No Codex credentials stored. Run `browser-use auth codex login` to authenticate.',
      'codex_auth_missing',
      true
    );
  }

  if (!state.tokens || typeof state.tokens !== 'object') {
    throw new CodexAuthError(
      'Codex auth state is missing tokens. Run `browser-use auth codex login` to re-authenticate.',
      'codex_auth_invalid_shape',
      true
    );
  }

  const accessToken = requireTokenString(
    state.tokens.access_token,
    'codex_auth_missing_access_token',
    'Codex auth is missing access_token. Run `browser-use auth codex login` to re-authenticate.'
  );
  const refreshToken = requireTokenString(
    state.tokens.refresh_token,
    'codex_auth_missing_refresh_token',
    'Codex auth is missing refresh_token. Run `browser-use auth codex login` to re-authenticate.'
  );

  return {
    tokens: {
      ...state.tokens,
      access_token: accessToken,
      refresh_token: refreshToken,
    },
    last_refresh:
      typeof state.last_refresh === 'string' ? state.last_refresh : null,
    auth_mode: typeof state.auth_mode === 'string' ? state.auth_mode : null,
    source: typeof state.source === 'string' ? state.source : null,
  };
};

export const saveCodexTokens = async (
  tokens: CodexTokens,
  options: AuthPathOptions & {
    lastRefresh?: string | null;
    source?: string | null;
    lockTimeoutMs?: number;
  } = {}
): Promise<void> => {
  const accessToken = requireTokenString(
    tokens.access_token,
    'codex_auth_missing_access_token',
    'Cannot save Codex auth without access_token.'
  );
  const refreshToken = requireTokenString(
    tokens.refresh_token,
    'codex_auth_missing_refresh_token',
    'Cannot save Codex auth without refresh_token.'
  );
  const authStorePath = getCodexAuthStorePath(options);

  await withAuthStoreLock(
    authStorePath,
    async () => {
      const store = await readStore(authStorePath);
      const providers = store.providers ?? {};
      providers[CODEX_PROVIDER] = {
        ...(providers[CODEX_PROVIDER] ?? {}),
        tokens: {
          ...tokens,
          access_token: accessToken,
          refresh_token: refreshToken,
        },
        last_refresh: options.lastRefresh ?? nowIso(),
        auth_mode: 'chatgpt',
        source: options.source ?? 'browser-use-auth-store',
      };
      await writeStore(authStorePath, {
        ...store,
        version: AUTH_STORE_VERSION,
        active_provider: CODEX_PROVIDER,
        providers,
      });
    },
    options.lockTimeoutMs
  );
};

export const clearCodexTokens = async (
  options: AuthPathOptions & { lockTimeoutMs?: number } = {}
): Promise<void> => {
  const authStorePath = getCodexAuthStorePath(options);
  await withAuthStoreLock(
    authStorePath,
    async () => {
      const store = await readStore(authStorePath);
      const providers = { ...(store.providers ?? {}) };
      delete providers[CODEX_PROVIDER];
      await writeStore(authStorePath, {
        ...store,
        active_provider:
          store.active_provider === CODEX_PROVIDER
            ? undefined
            : store.active_provider,
        providers,
      });
    },
    options.lockTimeoutMs
  );
};

const decodeJwtPayload = (token: string): Record<string, any> | null => {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
};

export const codexAccessTokenIsExpiring = (
  accessToken: string,
  skewSeconds = CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
  nowMs = Date.now()
): boolean => {
  if (!accessToken.trim()) {
    return true;
  }
  const claims = decodeJwtPayload(accessToken);
  if (typeof claims?.exp !== 'number') {
    return false;
  }
  return claims.exp * 1000 <= nowMs + skewSeconds * 1000;
};

export const getCodexCloudflareHeaders = (
  accessToken: string
): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': 'codex_cli_rs/0.0.0 (browser-use)',
    originator: 'codex_cli_rs',
  };
  const claims = decodeJwtPayload(accessToken);
  const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof accountId === 'string' && accountId.trim()) {
    headers['ChatGPT-Account-ID'] = accountId.trim();
  }
  return headers;
};

export const importCodexCliTokens = async (
  options: {
    codexHome?: string | null;
    authPath?: string | null;
    nowMs?: number;
  } = {}
): Promise<CodexTokens | null> => {
  const codexHome =
    options.codexHome ??
    process.env.CODEX_HOME?.trim() ??
    path.join(os.homedir(), '.codex');
  const authPath = options.authPath
    ? path.resolve(expandHome(options.authPath))
    : path.join(path.resolve(expandHome(codexHome)), 'auth.json');

  try {
    const raw = await readBoundedAuthFile(
      authPath,
      'Codex CLI auth file',
      'codex_cli_auth_invalid_file'
    );
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const tokens = parsed?.tokens;
    if (!tokens || typeof tokens !== 'object') {
      return null;
    }
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    if (
      typeof accessToken !== 'string' ||
      !accessToken.trim() ||
      typeof refreshToken !== 'string' ||
      !refreshToken.trim()
    ) {
      return null;
    }
    if (codexAccessTokenIsExpiring(accessToken, 0, options.nowMs)) {
      return null;
    }
    return {
      ...tokens,
      access_token: accessToken.trim(),
      refresh_token: refreshToken.trim(),
    };
  } catch {
    return null;
  }
};

const fetchWithTimeout = async <T>(
  url: string,
  init: RequestInit,
  options: FetchOptions,
  consume: (response: Response) => Promise<T>
): Promise<T> => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  const onUpstreamAbort = () => controller.abort();
  if (upstreamSignal?.aborted) {
    controller.abort();
  } else {
    upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true });
  }
  let response: Response | null = null;
  try {
    response = await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });
    return await consume(response);
  } finally {
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => undefined);
    }
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
  }
};

const readCodexAuthJson = async (
  response: Response,
  code: string,
  message: string,
  reloginRequired = false
): Promise<any> => {
  try {
    return await readBoundedResponseJson(
      response,
      MAX_CODEX_AUTH_RESPONSE_BYTES
    );
  } catch {
    throw new CodexAuthError(message, code, reloginRequired);
  }
};

const parseErrorPayload = async (
  response: Response
): Promise<{ code: string; message: string; reloginRequired: boolean }> => {
  let code = 'codex_refresh_failed';
  let message = `Codex token refresh failed with status ${response.status}.`;
  let reloginRequired = false;

  try {
    const payload = (await readBoundedResponseJson(
      response,
      MAX_CODEX_AUTH_ERROR_BYTES
    )) as any;
    const error = payload?.error;
    if (error && typeof error === 'object') {
      const nestedCode = error.code ?? error.type;
      if (typeof nestedCode === 'string' && nestedCode.trim()) {
        code = nestedCode.trim();
      }
      if (typeof error.message === 'string' && error.message.trim()) {
        message = `Codex token refresh failed: ${error.message.trim()}`;
      }
    } else if (typeof error === 'string' && error.trim()) {
      code = error.trim();
      const description = payload.error_description ?? payload.message;
      if (typeof description === 'string' && description.trim()) {
        message = `Codex token refresh failed: ${description.trim()}`;
      }
    }
  } catch {
    /* keep generic message */
  }

  if (['invalid_grant', 'invalid_token', 'invalid_request'].includes(code)) {
    reloginRequired = true;
  }
  if (code === 'refresh_token_reused') {
    message =
      'Codex refresh token was already consumed by another client. Run `browser-use auth codex login --force` to create a fresh browser-use session.';
    reloginRequired = true;
  }
  if (
    (response.status === 401 || response.status === 403) &&
    !reloginRequired
  ) {
    reloginRequired = true;
  }

  return { code, message, reloginRequired };
};

export const refreshCodexOAuth = async (
  accessToken: string,
  refreshToken: string,
  options: RefreshCodexOAuthOptions = {}
): Promise<CodexTokens & { last_refresh: string }> => {
  void accessToken;
  const cleanRefreshToken = requireTokenString(
    refreshToken,
    'codex_auth_missing_refresh_token',
    'Codex auth is missing refresh_token. Run `browser-use auth codex login` to re-authenticate.'
  );

  return fetchWithTimeout(
    options.tokenUrl ?? CODEX_OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cleanRefreshToken,
        client_id: options.clientId ?? CODEX_OAUTH_CLIENT_ID,
      }),
    },
    options,
    async (response) => {
      if (!response.ok) {
        const parsed = await parseErrorPayload(response);
        throw new CodexAuthError(
          parsed.message,
          parsed.code,
          parsed.reloginRequired
        );
      }

      const payload = await readCodexAuthJson(
        response,
        'codex_refresh_invalid_json',
        'Codex token refresh returned invalid or oversized JSON.',
        true
      );
      const refreshedAccessToken = requireTokenString(
        payload?.access_token,
        'codex_refresh_missing_access_token',
        'Codex token refresh response was missing access_token.'
      );
      const nextRefreshToken =
        typeof payload?.refresh_token === 'string' &&
        payload.refresh_token.trim()
          ? payload.refresh_token.trim()
          : cleanRefreshToken;

      return {
        access_token: refreshedAccessToken,
        refresh_token: nextRefreshToken,
        last_refresh: nowIso(),
      };
    }
  );
};

const resolveCodexBaseURL = (baseURL?: string | null) =>
  (baseURL ?? process.env.BROWSER_USE_CODEX_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '') || DEFAULT_CODEX_BASE_URL;

export const resolveCodexRuntimeCredentials = async (
  options: ResolveCodexRuntimeCredentialsOptions = {}
): Promise<CodexRuntimeCredentials> => {
  const authStorePath = getCodexAuthStorePath(options);
  const refreshIfExpiring = options.refreshIfExpiring ?? true;
  const refreshSkewSeconds =
    options.refreshSkewSeconds ?? CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  let record = await readCodexTokens(options);
  let tokens = { ...record.tokens };
  let shouldRefresh = Boolean(options.forceRefresh);
  if (!shouldRefresh && refreshIfExpiring) {
    shouldRefresh = codexAccessTokenIsExpiring(
      tokens.access_token,
      refreshSkewSeconds
    );
  }

  if (shouldRefresh) {
    await withAuthStoreLock(
      authStorePath,
      async () => {
        record = await readCodexTokens({ authStorePath });
        tokens = { ...record.tokens };
        let stillShouldRefresh = Boolean(options.forceRefresh);
        if (!stillShouldRefresh && refreshIfExpiring) {
          stillShouldRefresh = codexAccessTokenIsExpiring(
            tokens.access_token,
            refreshSkewSeconds
          );
        }
        if (!stillShouldRefresh) {
          return;
        }
        const refreshed = await refreshCodexOAuth(
          tokens.access_token,
          tokens.refresh_token,
          options
        );
        tokens = {
          ...tokens,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
        };
        const store = await readStore(authStorePath);
        const providers = store.providers ?? {};
        providers[CODEX_PROVIDER] = {
          ...(providers[CODEX_PROVIDER] ?? {}),
          tokens,
          last_refresh: refreshed.last_refresh,
          auth_mode: 'chatgpt',
          source: providers[CODEX_PROVIDER]?.source ?? 'browser-use-auth-store',
        };
        await writeStore(authStorePath, {
          ...store,
          version: AUTH_STORE_VERSION,
          active_provider: CODEX_PROVIDER,
          providers,
        });
        record = {
          ...record,
          tokens,
          last_refresh: refreshed.last_refresh,
        };
      },
      lockTimeoutMs
    );
  }

  return {
    provider: CODEX_PROVIDER,
    base_url: resolveCodexBaseURL(options.baseURL),
    api_key: tokens.access_token,
    source: record.source ?? 'browser-use-auth-store',
    last_refresh: record.last_refresh,
    auth_mode: 'chatgpt',
  };
};

export const getCodexAuthStatus = async (
  options: AuthPathOptions & { baseURL?: string | null } = {}
): Promise<CodexAuthStatus> => {
  const authStorePath = getCodexAuthStorePath(options);
  try {
    const record = await readCodexTokens(options);
    return {
      authenticated: true,
      auth_store_path: authStorePath,
      provider: CODEX_PROVIDER,
      base_url: resolveCodexBaseURL(options.baseURL),
      source: record.source,
      last_refresh: record.last_refresh,
      access_token_expiring: codexAccessTokenIsExpiring(
        record.tokens.access_token
      ),
    };
  } catch (error) {
    if (error instanceof CodexAuthError) {
      return {
        authenticated: false,
        auth_store_path: authStorePath,
        provider: CODEX_PROVIDER,
        base_url: resolveCodexBaseURL(options.baseURL),
        source: null,
        last_refresh: null,
        access_token_expiring: null,
        error: {
          code: error.code,
          message: error.message,
          relogin_required: error.relogin_required,
        },
      };
    }
    throw error;
  }
};

export const saveImportedCodexCliTokens = async (
  options: AuthPathOptions & {
    codexHome?: string | null;
    codexAuthPath?: string | null;
    lockTimeoutMs?: number;
  } = {}
): Promise<boolean> => {
  const tokens = await importCodexCliTokens({
    codexHome: options.codexHome,
    authPath: options.codexAuthPath,
  });
  if (!tokens) {
    return false;
  }
  await saveCodexTokens(tokens, {
    ...options,
    source: 'codex-cli-import',
    lockTimeoutMs: options.lockTimeoutMs,
  });
  return true;
};

export const loginCodexDeviceCode = async (
  options: DeviceCodeLoginOptions = {}
): Promise<{
  tokens: CodexTokens;
  base_url: string;
  last_refresh: string;
  auth_mode: 'chatgpt';
  source: 'device-code';
}> => {
  const issuer = (options.issuer ?? CODEX_DEVICE_AUTH_BASE_URL).replace(
    /\/+$/,
    ''
  );
  const clientId = options.clientId ?? CODEX_OAUTH_CLIENT_ID;
  const output = options.stdout ?? process.stdout;
  const sleepImpl = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? 15 * 60 * 1000;

  const deviceData = await fetchWithTimeout(
    `${issuer}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
    },
    options,
    async (response) => {
      if (!response.ok) {
        throw new CodexAuthError(
          `Device code request returned status ${response.status}.`,
          'device_code_request_error'
        );
      }
      return readCodexAuthJson(
        response,
        'device_code_invalid_response',
        'Device code request returned invalid or oversized JSON.'
      );
    }
  );
  const userCode = deviceData?.user_code;
  const deviceAuthId = deviceData?.device_auth_id;
  const parsedPollInterval = Number.parseInt(
    String(deviceData?.interval ?? '5'),
    10
  );
  const pollIntervalMs =
    Number.isFinite(parsedPollInterval) && parsedPollInterval > 0
      ? Math.max(3_000, parsedPollInterval * 1000)
      : 5_000;

  if (
    typeof userCode !== 'string' ||
    !userCode.trim() ||
    typeof deviceAuthId !== 'string' ||
    !deviceAuthId.trim()
  ) {
    throw new CodexAuthError(
      'Device code response missing required fields.',
      'device_code_incomplete'
    );
  }

  output.write('To continue, follow these steps:\n\n');
  output.write(
    `  1. Open this URL in your browser:\n     ${issuer}/codex/device\n\n`
  );
  output.write(`  2. Enter this code:\n     ${userCode}\n\n`);
  output.write('Waiting for sign-in... (press Ctrl+C to cancel)\n');

  const start = now();
  let authorizationCode: string | null = null;
  let codeVerifier: string | null = null;

  while (now() - start < maxWaitMs) {
    await sleepImpl(pollIntervalMs);
    const pollResult = await fetchWithTimeout(
      `${issuer}/api/accounts/deviceauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }),
      },
      options,
      async (response) => ({
        ok: response.ok,
        status: response.status,
        payload: response.ok
          ? await readCodexAuthJson(
              response,
              'device_code_poll_invalid_response',
              'Device auth polling returned invalid or oversized JSON.'
            )
          : null,
      })
    );

    if (pollResult.ok) {
      const payload = pollResult.payload;
      authorizationCode =
        typeof payload?.authorization_code === 'string'
          ? payload.authorization_code
          : null;
      codeVerifier =
        typeof payload?.code_verifier === 'string'
          ? payload.code_verifier
          : null;
      break;
    }
    if (pollResult.status === 403 || pollResult.status === 404) {
      continue;
    }
    throw new CodexAuthError(
      `Device auth polling returned status ${pollResult.status}.`,
      'device_code_poll_error'
    );
  }

  if (!authorizationCode || !codeVerifier) {
    throw new CodexAuthError(
      'Login timed out before authorization completed.',
      'device_code_timeout',
      true
    );
  }

  return fetchWithTimeout(
    options.issuer ? `${issuer}/oauth/token` : CODEX_OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: `${issuer}/deviceauth/callback`,
        client_id: clientId,
        code_verifier: codeVerifier,
      }),
    },
    options,
    async (response) => {
      if (!response.ok) {
        throw new CodexAuthError(
          `Token exchange returned status ${response.status}.`,
          'token_exchange_error',
          response.status === 401 || response.status === 403
        );
      }

      const tokenPayload = await readCodexAuthJson(
        response,
        'token_exchange_invalid_response',
        'Token exchange returned invalid or oversized JSON.',
        true
      );
      const accessToken = requireTokenString(
        tokenPayload?.access_token,
        'token_exchange_no_access_token',
        'Token exchange did not return an access_token.'
      );
      const refreshToken = requireTokenString(
        tokenPayload?.refresh_token,
        'token_exchange_no_refresh_token',
        'Token exchange did not return a refresh_token.'
      );

      return {
        tokens: {
          ...tokenPayload,
          access_token: accessToken,
          refresh_token: refreshToken,
        },
        base_url: resolveCodexBaseURL(),
        last_refresh: nowIso(),
        auth_mode: 'chatgpt' as const,
        source: 'device-code' as const,
      };
    }
  );
};

export const loginAndSaveCodexDeviceCode = async (
  options: DeviceCodeLoginOptions &
    AuthPathOptions & { lockTimeoutMs?: number } = {}
) => {
  const credentials = await loginCodexDeviceCode(options);
  await saveCodexTokens(credentials.tokens, {
    ...options,
    lastRefresh: credentials.last_refresh,
    source: credentials.source,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  return credentials;
};
