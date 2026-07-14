import path from 'node:path';
import { PostHog } from 'posthog-node';
import { createLogger } from '../logging-config.js';
import { CONFIG } from '../config.js';
import { getOrCreatePrivateDeviceId } from '../private-state.js';
import { uuid7str } from '../utils.js';
import type { BaseTelemetryEvent } from './views.js';

const logger = createLogger('browser_use.telemetry');

const POSTHOG_EVENT_SETTINGS = {
  process_person_profile: true,
};

export class ProductTelemetry {
  private client: PostHog | null = null;
  private debugLogging: boolean;
  private userIdFile: string;
  private cachedUserId: string | null = null;

  constructor() {
    this.debugLogging = CONFIG.BROWSER_USE_LOGGING_LEVEL === 'debug';
    this.userIdFile = path.join(CONFIG.BROWSER_USE_CONFIG_DIR, 'device_id');

    if (!CONFIG.ANONYMIZED_TELEMETRY) {
      logger.debug('Telemetry disabled');
      return;
    }

    try {
      this.client = new PostHog(
        'phc_F8JMNjW1i2KbGUTaW1unnDdLSPCoyc52SGRU0JecaUh',
        {
          host: 'https://eu.i.posthog.com',
          disableGeoip: false,
          // Raw exception messages/stacks can contain tasks, URLs, and secrets.
          // Only send the explicitly structured and redacted events below.
          enableExceptionAutocapture: false,
        }
      );
    } catch (error) {
      logger.error(
        `Failed to initialize PostHog client: ${(error as Error).message}`
      );
      this.client = null;
    }
  }

  capture(event: BaseTelemetryEvent) {
    if (!this.client) {
      return;
    }
    try {
      this.client.capture({
        distinctId: this.userId,
        event: event.name,
        properties: {
          ...event.properties(),
          ...POSTHOG_EVENT_SETTINGS,
        },
      });
    } catch (error) {
      logger.error(
        `Failed to send telemetry event ${event.name}: ${(error as Error).message}`
      );
    }
  }

  flush() {
    if (!this.client) {
      return;
    }
    try {
      this.client.flush();
      logger.debug('PostHog client telemetry queue flushed.');
    } catch (error) {
      logger.error(
        `Failed to flush PostHog client: ${(error as Error).message}`
      );
    }
  }

  get userId() {
    if (this.cachedUserId) {
      return this.cachedUserId;
    }

    try {
      this.cachedUserId = getOrCreatePrivateDeviceId(this.userIdFile, uuid7str);
    } catch {
      this.cachedUserId = uuid7str();
    }
    return this.cachedUserId;
  }
}

export const productTelemetry = new ProductTelemetry();
