import { CONFIG } from '../../config.js';
import { DeviceAuthClient } from '../../sync/auth.js';
import { CloudBrowserAuthError, CloudBrowserError } from './views.js';

const stripTrailingSlash = (input: string) => input.replace(/\/+$/, '');

export interface CloudManagementClientOptions {
  api_base_url?: string;
  api_key?: string | null;
  fetch_impl?: typeof fetch;
}

export interface CloudTaskView {
  id: string;
  sessionId: string;
  llm?: string | null;
  task: string;
  status: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  output?: string | null;
  browserUseVersion?: string | null;
  isSuccess?: boolean | null;
  judgement?: string | null;
  judgeVerdict?: boolean | null;
  steps?: Array<Record<string, unknown>>;
  outputFiles?: Array<Record<string, unknown>>;
}

export interface CloudSessionView {
  id: string;
  status: string;
  startedAt: string;
  liveUrl?: string | null;
  finishedAt?: string | null;
  tasks?: CloudTaskView[];
  publicShareUrl?: string | null;
}

export interface CloudProfileView {
  id: string;
  createdAt: string;
  updatedAt: string;
  name?: string | null;
  lastUsedAt?: string | null;
  cookieDomains?: string[] | null;
}

export interface CloudShareView {
  shareToken: string;
  shareUrl: string;
  viewCount: number;
  lastViewedAt?: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  totalItems: number;
  pageNumber: number;
  pageSize: number;
}

export interface CreateTaskRequest {
  task: string;
  llm?: string | null;
  startUrl?: string | null;
  maxSteps?: number | null;
  structuredOutput?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, string> | null;
  secrets?: Record<string, string> | null;
  allowedDomains?: string[] | null;
  opVaultId?: string | null;
  highlightElements?: boolean;
  flashMode?: boolean;
  thinking?: boolean;
  vision?: boolean | 'auto' | null;
  systemPromptExtension?: string | null;
  judge?: boolean;
  judgeGroundTruth?: string | null;
  judgeLlm?: string | null;
  skillIds?: string[] | null;
}

export interface CreateSessionRequest {
  profileId?: string | null;
  proxyCountryCode?: string | null;
  startUrl?: string | null;
  browserScreenWidth?: number | null;
  browserScreenHeight?: number | null;
}

export class CloudManagementClient {
  private readonly api_base_url: string;
  private readonly explicit_api_key: string | null;
  private readonly fetch_impl: typeof fetch;

  constructor(options: CloudManagementClientOptions = {}) {
    this.api_base_url = stripTrailingSlash(
      options.api_base_url ?? CONFIG.BROWSER_USE_CLOUD_API_URL
    );
    this.explicit_api_key = options.api_key ?? null;
    this.fetch_impl = options.fetch_impl ?? fetch;
  }

  private resolve_api_key() {
    if (this.explicit_api_key?.trim()) {
      return this.explicit_api_key.trim();
    }
    if (process.env.BROWSER_USE_API_KEY?.trim()) {
      return process.env.BROWSER_USE_API_KEY.trim();
    }
    const savedToken = new DeviceAuthClient(
      this.api_base_url
    ).api_token?.trim();
    return savedToken || null;
  }

  private auth_headers(extra_headers: Record<string, string> = {}) {
    const api_key = this.resolve_api_key();
    if (!api_key) {
      throw new CloudBrowserAuthError(
        'No authentication token found. Set BROWSER_USE_API_KEY to use cloud APIs.'
      );
    }

    return {
      'X-Browser-Use-API-Key': api_key,
      'Content-Type': 'application/json',
      ...extra_headers,
    };
  }

  private async request_json<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetch_impl(`${this.api_base_url}${path}`, {
      ...init,
      headers: this.auth_headers(init.headers as Record<string, string>),
      redirect: 'error',
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const details =
        payload && typeof payload === 'object'
          ? JSON.stringify(payload)
          : String(payload ?? '');
      if (response.status === 401 || response.status === 403) {
        throw new CloudBrowserAuthError(
          `Cloud API authentication failed (${response.status})`
        );
      }
      throw new CloudBrowserError(
        `Cloud API request failed (${response.status}): ${details}`
      );
    }

    return payload as T;
  }

  private build_query(
    params: Record<string, string | number | null | undefined>
  ) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value).length > 0) {
        query.set(key, String(value));
      }
    }
    const rendered = query.toString();
    return rendered ? `?${rendered}` : '';
  }

  async list_tasks(
    options: {
      pageSize?: number;
      pageNumber?: number;
      sessionId?: string | null;
      filterBy?: string | null;
      after?: string | null;
      before?: string | null;
    } = {}
  ) {
    return await this.request_json<PaginatedResponse<CloudTaskView>>(
      `/api/v2/tasks${this.build_query(options)}`,
      { method: 'GET' }
    );
  }

  async create_task(request: CreateTaskRequest) {
    return await this.request_json<{ id: string; sessionId: string }>(
      '/api/v2/tasks',
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    );
  }

  async get_task(task_id: string) {
    return await this.request_json<CloudTaskView>(
      `/api/v2/tasks/${encodeURIComponent(task_id)}`,
      { method: 'GET' }
    );
  }

  async update_task(task_id: string, action: 'stop' | 'stop_task_and_session') {
    return await this.request_json<CloudTaskView>(
      `/api/v2/tasks/${encodeURIComponent(task_id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      }
    );
  }

  async get_task_logs(task_id: string) {
    return await this.request_json<{ downloadUrl: string }>(
      `/api/v2/tasks/${encodeURIComponent(task_id)}/logs`,
      { method: 'GET' }
    );
  }

  async list_sessions(
    options: {
      pageSize?: number;
      pageNumber?: number;
      filterBy?: string | null;
    } = {}
  ) {
    return await this.request_json<PaginatedResponse<CloudSessionView>>(
      `/api/v2/sessions${this.build_query(options)}`,
      { method: 'GET' }
    );
  }

  async create_session(request: CreateSessionRequest) {
    return await this.request_json<CloudSessionView>('/api/v2/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async get_session(session_id: string) {
    return await this.request_json<CloudSessionView>(
      `/api/v2/sessions/${encodeURIComponent(session_id)}`,
      { method: 'GET' }
    );
  }

  async update_session(session_id: string, action: 'stop') {
    return await this.request_json<CloudSessionView>(
      `/api/v2/sessions/${encodeURIComponent(session_id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      }
    );
  }

  async delete_session(session_id: string) {
    await this.request_json<unknown>(
      `/api/v2/sessions/${encodeURIComponent(session_id)}`,
      { method: 'DELETE' }
    );
  }

  async create_session_public_share(session_id: string) {
    return await this.request_json<CloudShareView>(
      `/api/v2/sessions/${encodeURIComponent(session_id)}/public-share`,
      { method: 'POST' }
    );
  }

  async delete_session_public_share(session_id: string) {
    await this.request_json<unknown>(
      `/api/v2/sessions/${encodeURIComponent(session_id)}/public-share`,
      { method: 'DELETE' }
    );
  }

  async list_profiles(
    options: { pageSize?: number; pageNumber?: number } = {}
  ) {
    return await this.request_json<PaginatedResponse<CloudProfileView>>(
      `/api/v2/profiles${this.build_query(options)}`,
      { method: 'GET' }
    );
  }

  async create_profile(request: { name?: string | null } = {}) {
    return await this.request_json<CloudProfileView>('/api/v2/profiles', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async get_profile(profile_id: string) {
    return await this.request_json<CloudProfileView>(
      `/api/v2/profiles/${encodeURIComponent(profile_id)}`,
      { method: 'GET' }
    );
  }

  async update_profile(
    profile_id: string,
    request: { name?: string | null } = {}
  ) {
    return await this.request_json<CloudProfileView>(
      `/api/v2/profiles/${encodeURIComponent(profile_id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(request),
      }
    );
  }

  async delete_profile(profile_id: string) {
    await this.request_json<unknown>(
      `/api/v2/profiles/${encodeURIComponent(profile_id)}`,
      { method: 'DELETE' }
    );
  }
}
