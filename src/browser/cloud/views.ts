export type ProxyCountryCode =
  | 'us'
  | 'uk'
  | 'fr'
  | 'it'
  | 'jp'
  | 'au'
  | 'de'
  | 'fi'
  | 'ca'
  | 'in'
  | string;

export const MAX_FREE_USER_SESSION_TIMEOUT = 15;
export const MAX_PAID_USER_SESSION_TIMEOUT = 240;

export interface CreateBrowserRequest {
  cloud_profile_id?: string | null;
  cloud_proxy_country_code?: ProxyCountryCode | null;
  cloud_timeout?: number | null;
  profile_id?: string | null;
  proxy_country_code?: ProxyCountryCode | null;
  timeout?: number | null;
}

export interface CloudBrowserResponsePayload {
  id: string;
  status: string;
  liveUrl?: string;
  live_url?: string;
  cdpUrl?: string;
  cdp_url?: string;
  timeoutAt?: string;
  timeout_at?: string;
  startedAt?: string;
  started_at?: string;
  finishedAt?: string | null;
  finished_at?: string | null;
}

export class CloudBrowserResponse {
  id: string;
  status: string;
  liveUrl: string;
  cdpUrl: string;
  timeoutAt: string;
  startedAt: string;
  finishedAt: string | null;

  constructor(payload: CloudBrowserResponsePayload) {
    if (!payload?.id || !payload?.status) {
      throw new CloudBrowserError(
        'Invalid cloud browser response: missing id or status'
      );
    }

    this.id = String(payload.id);
    this.status = String(payload.status);
    this.liveUrl = String(payload.liveUrl ?? payload.live_url ?? '');
    this.cdpUrl = String(payload.cdpUrl ?? payload.cdp_url ?? '');
    this.timeoutAt = String(payload.timeoutAt ?? payload.timeout_at ?? '');
    this.startedAt = String(payload.startedAt ?? payload.started_at ?? '');
    this.finishedAt = payload.finishedAt ?? payload.finished_at ?? null;
  }
}

export class CloudBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudBrowserError';
  }
}

export class CloudBrowserAuthError extends CloudBrowserError {
  constructor(message: string) {
    super(message);
    this.name = 'CloudBrowserAuthError';
  }
}

/**
 * The API key is valid but not scoped for the requested API version.
 */
export class CloudBrowserMissingScopeError extends CloudBrowserAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'CloudBrowserMissingScopeError';
  }
}
