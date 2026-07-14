import { CONFIG } from '../../config.js';
import { createLogger } from '../../logging-config.js';
import { DeviceAuthClient } from '../../sync/auth.js';
import {
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  readBoundedResponseText,
  runWithHttpTimeout,
} from '../../http-response.js';
import {
  CloudBrowserAuthError,
  CloudBrowserError,
  CloudBrowserResponse,
  type CloudBrowserResponsePayload,
  type CreateBrowserRequest,
  MAX_PAID_USER_SESSION_TIMEOUT,
} from './views.js';

const logger = createLogger('browser_use.browser.cloud');

const stripTrailingSlash = (input: string) => input.replace(/\/+$/, '');

const normalizeTimeout = (timeout: number | null | undefined) => {
  if (timeout == null) {
    return null;
  }
  const integerTimeout = Math.floor(timeout);
  if (!Number.isFinite(integerTimeout) || integerTimeout < 1) {
    return null;
  }
  return Math.min(integerTimeout, MAX_PAID_USER_SESSION_TIMEOUT);
};

export interface CloudBrowserClientOptions {
  api_base_url?: string;
  api_key?: string | null;
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
}

export class CloudBrowserClient {
  private readonly api_base_url: string;
  private readonly explicit_api_key: string | null;
  private readonly fetch_impl: typeof fetch;
  private readonly request_timeout_ms: number;

  public current_session_id: string | null = null;

  constructor(options: CloudBrowserClientOptions = {}) {
    this.api_base_url = stripTrailingSlash(
      options.api_base_url ?? CONFIG.BROWSER_USE_CLOUD_API_URL
    );
    this.explicit_api_key = options.api_key ?? null;
    this.fetch_impl = options.fetch_impl ?? fetch;
    this.request_timeout_ms =
      options.request_timeout_ms ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  }

  private _resolve_api_key() {
    if (this.explicit_api_key && this.explicit_api_key.trim()) {
      return this.explicit_api_key.trim();
    }

    const fromEnv = process.env.BROWSER_USE_API_KEY?.trim();
    if (fromEnv) {
      return fromEnv;
    }

    const authClient = new DeviceAuthClient(this.api_base_url);
    const fromAuthConfig = authClient.api_token?.trim();
    if (fromAuthConfig) {
      return fromAuthConfig;
    }

    return null;
  }

  private _auth_headers(extra_headers: Record<string, string> = {}) {
    const api_key = this._resolve_api_key();
    if (!api_key) {
      throw new CloudBrowserAuthError(
        'No authentication token found. Set BROWSER_USE_API_KEY to use cloud browser.'
      );
    }

    return {
      'X-Browser-Use-API-Key': api_key,
      'Content-Type': 'application/json',
      ...extra_headers,
    };
  }

  private _create_request_body(request: CreateBrowserRequest) {
    const profile_id = request.cloud_profile_id ?? request.profile_id ?? null;
    const has_cloud_proxy =
      Object.prototype.hasOwnProperty.call(
        request,
        'cloud_proxy_country_code'
      ) && request.cloud_proxy_country_code !== undefined;
    const has_legacy_proxy =
      Object.prototype.hasOwnProperty.call(request, 'proxy_country_code') &&
      request.proxy_country_code !== undefined;
    const has_proxy_country_code = has_cloud_proxy || has_legacy_proxy;
    const proxy_country_code = has_cloud_proxy
      ? request.cloud_proxy_country_code
      : request.proxy_country_code;
    const timeout = normalizeTimeout(
      request.cloud_timeout ?? request.timeout ?? null
    );

    return {
      ...(profile_id ? { profile_id: String(profile_id) } : {}),
      ...(has_proxy_country_code
        ? {
            proxy_country_code:
              proxy_country_code === null ? null : String(proxy_country_code),
          }
        : {}),
      ...(timeout ? { timeout } : {}),
    };
  }

  private async _request_json<T>(
    path: string,
    init: RequestInit,
    extra_headers: Record<string, string> = {}
  ): Promise<T> {
    return await runWithHttpTimeout(
      async (signal) => {
        const response = await this.fetch_impl(`${this.api_base_url}${path}`, {
          ...init,
          headers: this._auth_headers(extra_headers),
          redirect: 'error',
          signal,
        });

        const text = await readBoundedResponseText(response);
        let payload: unknown = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = text;
          }
        }

        if (!response.ok) {
          const errorDetails =
            payload && typeof payload === 'object'
              ? JSON.stringify(payload)
              : String(payload ?? '');
          if (response.status === 401 || response.status === 403) {
            throw new CloudBrowserAuthError(
              `Cloud browser authentication failed (${response.status})`
            );
          }
          throw new CloudBrowserError(
            `Cloud browser request failed (${response.status}): ${errorDetails.slice(0, 8192)}`
          );
        }

        return payload as T;
      },
      this.request_timeout_ms,
      init.signal
    );
  }

  async create_browser(
    request: CreateBrowserRequest,
    extra_headers: Record<string, string> = {}
  ) {
    logger.info('🌤️ Creating cloud browser instance...');

    const payload = await this._request_json<CloudBrowserResponsePayload>(
      '/api/v2/browsers',
      {
        method: 'POST',
        body: JSON.stringify(this._create_request_body(request)),
      },
      extra_headers
    );

    const browser_response = new CloudBrowserResponse(payload);
    this.current_session_id = browser_response.id;
    logger.info(`🌤️ Cloud browser created: ${browser_response.id}`);
    return browser_response;
  }

  async stop_browser(
    session_id: string | null = null,
    extra_headers: Record<string, string> = {}
  ) {
    const target_session_id = session_id ?? this.current_session_id;
    if (!target_session_id) {
      throw new CloudBrowserError(
        'No session ID provided and no active cloud browser session found'
      );
    }

    const payload = await this._request_json<CloudBrowserResponsePayload>(
      `/api/v2/browsers/${encodeURIComponent(target_session_id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'stop' }),
      },
      extra_headers
    );

    const browser_response = new CloudBrowserResponse(payload);
    if (browser_response.id === this.current_session_id) {
      this.current_session_id = null;
    }
    logger.info(`🌤️ Cloud browser stopped: ${browser_response.id}`);
    return browser_response;
  }

  async close() {
    if (!this.current_session_id) {
      return;
    }
    try {
      await this.stop_browser(this.current_session_id);
    } catch (error) {
      logger.debug(
        `Failed to stop cloud browser during close: ${(error as Error).message}`
      );
    }
  }
}
