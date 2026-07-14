import axios from 'axios';
import { createLogger } from '../logging-config.js';
import { CONFIG } from '../config.js';
import type { BaseEvent } from '../agent/cloud-events.js';
import { DeviceAuthClient, TEMP_USER_ID } from './auth.js';

const logger = createLogger('browser_use.sync');
export const MAX_SYNC_EVENT_RESPONSE_BYTES = 1024 * 1024;
export const MAX_SYNC_EVENT_REQUEST_BYTES = 80 * 1024 * 1024;

const stripTrailingSlash = (input: string) => input.replace(/\/+$/, '');

export interface CloudSyncOptions {
  baseUrl?: string;
  enableAuth?: boolean;
  allowSessionEventsForAuth?: boolean;
}

const ensureArray = <T>(value: T | T[]): T[] =>
  Array.isArray(value) ? value : [value];

export class CloudSync {
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  public readonly auth_client: DeviceAuthClient;
  private sessionId: string | null = null;
  private allowSessionEventsForAuth: boolean;
  private authFlowActive = false;

  constructor(options: CloudSyncOptions = {}) {
    const enableAuth = options.enableAuth ?? true;
    this.baseUrl = stripTrailingSlash(
      options.baseUrl ?? CONFIG.BROWSER_USE_CLOUD_API_URL
    );
    this.enabled = CONFIG.BROWSER_USE_CLOUD_SYNC && enableAuth;
    this.allowSessionEventsForAuth = options.allowSessionEventsForAuth ?? false;
    this.auth_client = new DeviceAuthClient(this.baseUrl);
  }

  async handle_event(event: BaseEvent) {
    try {
      if (!this.enabled) {
        return;
      }

      if (
        event.event_type === 'CreateAgentSessionEvent' &&
        (event as any)?.id != null
      ) {
        this.sessionId = String((event as any).id);
      }

      if (this.auth_client.is_authenticated) {
        await this.sendEvent(event);
        return;
      }

      if (this.allowSessionEventsForAuth || this.authFlowActive) {
        await this.sendEvent(event);
        if (event.event_type === 'CreateAgentSessionEvent') {
          this.authFlowActive = true;
        }
        return;
      }

      logger.debug(
        `Skipping event ${event.event_type} - user not authenticated`
      );
    } catch (error) {
      logger.error(
        `Failed to handle ${event.event_type}: ${(error as Error).message}`
      );
    }
  }

  private async sendEvent(event: BaseEvent) {
    try {
      const headers: Record<string, string> = {};
      const currentUserId = (event as any).user_id ?? null;

      if (this.auth_client.is_authenticated) {
        if (currentUserId !== TEMP_USER_ID) {
          (event as any).user_id = this.auth_client.user_id;
        }
      } else if (!currentUserId) {
        (event as any).user_id = TEMP_USER_ID;
      }

      Object.assign(headers, this.auth_client.get_headers());
      (event as any).device_id =
        (event as any).device_id ?? this.auth_client.device_id;

      const payload =
        typeof (event as any)?.toJSON === 'function'
          ? (event as any).toJSON()
          : { ...event };
      const events = ensureArray(payload);

      await axios.post(
        `${this.baseUrl}/api/v1/events`,
        {
          events: events.map((entry) => ({
            ...entry,
            device_id: (entry as any).device_id ?? this.auth_client.device_id,
          })),
        },
        {
          headers,
          timeout: 10_000,
          maxRedirects: 0,
          maxContentLength: MAX_SYNC_EVENT_RESPONSE_BYTES,
          maxBodyLength: MAX_SYNC_EVENT_REQUEST_BYTES,
        }
      );
    } catch (error: any) {
      const status = error?.response?.status;
      if (status) {
        logger.debug(
          `Failed to send sync event: POST ${this.baseUrl}/api/v1/events ${status} - ${String(error?.response?.data ?? '')}`
        );
      } else if (error?.code === 'ECONNABORTED') {
        logger.debug(`Event send timed out after 10 seconds: ${event}`);
      } else {
        logger.debug(
          `Unexpected error sending event ${event}: ${typeOfError(error)}`
        );
      }
    }
  }

  set_auth_flow_active() {
    this.authFlowActive = true;
    this.allowSessionEventsForAuth = true;
  }

  // Backward-compatible no-op; auth is no longer background-scheduled here.
  async wait_for_auth() {}

  async authenticate(showInstructions = true) {
    if (!this.enabled) {
      return false;
    }

    if (this.auth_client.is_authenticated) {
      if (showInstructions) {
        logger.info('✅ Already authenticated! Skipping OAuth flow.');
      }
      return true;
    }

    return this.auth_client.authenticate(this.sessionId, showInstructions);
  }
}

const typeOfError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
};
