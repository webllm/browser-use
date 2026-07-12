import fs from 'node:fs';
import path from 'node:path';
import axios, { type AxiosInstance } from 'axios';
import { CONFIG } from '../config.js';
import { createLogger } from '../logging-config.js';
import { uuid7str } from '../utils.js';

export const TEMP_USER_ID = '99999999-9999-9999-9999-999999999999';

const logger = createLogger('browser_use.sync.auth');

interface CloudAuthConfigData {
  api_token: string | null;
  user_id: string | null;
  authorized_at: string | null;
}

const CONFIG_DIR = () =>
  CONFIG.BROWSER_USE_CONFIG_DIR ?? path.join(process.cwd(), '.browseruse');
const DEVICE_ID_PATH = () => path.join(CONFIG_DIR(), 'device_id');
const CLOUD_AUTH_PATH = () => path.join(CONFIG_DIR(), 'cloud_auth.json');

const ensureDir = () => {
  fs.mkdirSync(CONFIG_DIR(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(CONFIG_DIR(), 0o700);
    } catch {
      /* noop */
    }
  }
};

const writePrivateFile = (filePath: string, contents: string) => {
  fs.writeFileSync(filePath, contents, { encoding: 'utf-8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* noop */
    }
  }
};

const loadAuthConfig = (): CloudAuthConfigData => {
  try {
    const contents = fs.readFileSync(CLOUD_AUTH_PATH(), 'utf-8');
    const parsed = JSON.parse(contents);
    return {
      api_token: parsed.api_token ?? null,
      user_id: parsed.user_id ?? null,
      authorized_at: parsed.authorized_at ?? null,
    };
  } catch {
    return { api_token: null, user_id: null, authorized_at: null };
  }
};

const saveAuthConfig = (config: CloudAuthConfigData) => {
  ensureDir();
  writePrivateFile(CLOUD_AUTH_PATH(), JSON.stringify(config, null, 2));
};

export const load_cloud_auth_config = (): CloudAuthConfigData =>
  loadAuthConfig();

export const save_cloud_api_token = (
  api_token: string,
  user_id: string | null = TEMP_USER_ID
) => {
  const normalized = api_token.trim();
  if (!normalized) {
    throw new Error('API token cannot be empty');
  }

  saveAuthConfig({
    api_token: normalized,
    user_id,
    authorized_at: new Date().toISOString(),
  });
};

const getOrCreateDeviceId = () => {
  ensureDir();
  try {
    const existing = fs.readFileSync(DEVICE_ID_PATH(), 'utf-8').trim();
    if (existing) {
      return existing;
    }
  } catch {
    /* continue */
  }

  const deviceId = uuid7str();
  writePrivateFile(DEVICE_ID_PATH(), deviceId);
  return deviceId;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stripTrailingSlash = (input: string) => input.replace(/\/+$/, '');

const terminalWidth = () => Math.max((process.stdout?.columns ?? 80) - 40, 20);

export class DeviceAuthClient {
  private readonly baseUrl: string;
  private readonly clientId = 'library';
  private readonly scope = 'read write';
  private readonly httpClient?: AxiosInstance;
  private authConfig: CloudAuthConfigData;
  private _deviceId: string;

  constructor(baseUrl?: string, httpClient?: AxiosInstance) {
    this.baseUrl = stripTrailingSlash(
      baseUrl ?? CONFIG.BROWSER_USE_CLOUD_API_URL
    );
    this.httpClient = httpClient;
    this.authConfig = loadAuthConfig();
    this._deviceId = getOrCreateDeviceId();
  }

  get device_id() {
    return this._deviceId;
  }

  get is_authenticated() {
    return Boolean(this.authConfig.api_token && this.authConfig.user_id);
  }

  get api_token() {
    return this.authConfig.api_token;
  }

  get user_id() {
    return this.authConfig.user_id ?? TEMP_USER_ID;
  }

  private get client() {
    return this.httpClient ?? axios;
  }

  private buildUrl(pathname: string) {
    return `${this.baseUrl}${pathname}`;
  }

  private async postForm(
    pathname: string,
    data: Record<string, string | number | undefined>
  ) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        form.append(key, String(value));
      }
    }
    return this.client.post(this.buildUrl(pathname), form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
    });
  }

  async start_device_authorization(agent_session_id?: string | null) {
    const response = await this.postForm('/api/v1/oauth/device/authorize', {
      client_id: this.clientId,
      scope: this.scope,
      agent_session_id: agent_session_id ?? '',
      device_id: this.device_id,
    });
    return response.data as Record<string, any>;
  }

  async poll_for_token(device_code: string, interval = 3, timeout = 1800) {
    const started = Date.now();
    let delay = interval;
    while (Date.now() - started < timeout * 1000) {
      try {
        const response = await this.postForm('/api/v1/oauth/device/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code,
          client_id: this.clientId,
        });
        const data = response.data as Record<string, any>;
        if (data.error === 'authorization_pending') {
          await sleep(delay * 1000);
          continue;
        }
        if (data.error === 'slow_down') {
          delay = data.interval ?? delay * 2;
          await sleep(delay * 1000);
          continue;
        }
        if (data.error) {
          logger.warning(`Device token error: ${data.error}`);
          return null;
        }
        if (data.access_token) {
          return data;
        }
      } catch (error: any) {
        const status = error?.response?.status;
        const payload = error?.response?.data;
        if (
          status === 400 &&
          payload?.error &&
          ['authorization_pending', 'slow_down'].includes(payload.error)
        ) {
          if (payload.error === 'slow_down') {
            delay = payload.interval ?? delay * 2;
          }
          await sleep(delay * 1000);
          continue;
        }
        logger.debug(`Error polling for token: ${error?.message ?? error}`);
        return null;
      }
      await sleep(delay * 1000);
    }
    return null;
  }

  async authenticate(
    agent_session_id?: string | null,
    show_instructions = true
  ) {
    try {
      const deviceAuth =
        await this.start_device_authorization(agent_session_id);
      const frontendBase =
        CONFIG.BROWSER_USE_CLOUD_UI_URL ||
        this.baseUrl.replace('//api.', '//cloud.');
      const replaceHost = (value: string) =>
        value?.replace(this.baseUrl, frontendBase);
      const verificationUri = replaceHost(deviceAuth.verification_uri);
      const verificationUriComplete = replaceHost(
        deviceAuth.verification_uri_complete
      );

      if (show_instructions && CONFIG.BROWSER_USE_CLOUD_SYNC) {
        const divider = '─'.repeat(terminalWidth());
        logger.info(divider);
        logger.info('🌐  View the details of this run in Browser Use Cloud:');
        logger.info(`    👉  ${verificationUriComplete}`);
        logger.info(divider + '\n');
      }

      const tokenData = await this.poll_for_token(
        deviceAuth.device_code,
        deviceAuth.interval ?? 5
      );
      if (tokenData?.access_token) {
        this.authConfig = {
          api_token: tokenData.access_token,
          user_id: tokenData.user_id ?? this.user_id,
          authorized_at: new Date().toISOString(),
        };
        saveAuthConfig(this.authConfig);
        if (show_instructions) {
          logger.debug('✅ Authentication successful, cloud sync enabled.');
        }
        return true;
      }
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) {
        logger.warning('Cloud sync authentication endpoint not found (404).');
      } else {
        logger.warning(`Cloud sync auth error: ${error?.message ?? error}`);
      }
    }
    if (show_instructions) {
      logger.debug(`❌ Sync authentication failed for ${this.baseUrl}`);
    }
    return false;
  }

  get_headers() {
    return this.api_token ? { Authorization: `Bearer ${this.api_token}` } : {};
  }

  clear_auth() {
    this.authConfig = { api_token: null, user_id: null, authorized_at: null };
    try {
      fs.unlinkSync(CLOUD_AUTH_PATH());
    } catch {
      /* noop */
    }
  }
}
