import { createLogger } from '../logging-config.js';
import {
  BrowserCreatedData,
  ErrorData,
  LogData,
  ResultData,
  SandboxError,
  SSEEvent,
  SSEEventType,
} from './views.js';

const logger = createLogger('browser_use.sandbox');

const defaultServerUrl = 'https://sandbox.api.browser-use.com/sandbox-stream';

const maybeInvoke = async <T>(
  callback: ((data: T) => void | Promise<void>) | undefined,
  data: T
) => {
  if (!callback) {
    return;
  }
  await callback(data);
};

const parseSSEChunks = async (
  response: Response,
  onEvent: (event: SSEEvent) => Promise<void>
) => {
  const processLine = async (line: string) => {
    if (!line.startsWith('data:')) {
      return;
    }
    const jsonPayload = line.slice(5).trim();
    if (!jsonPayload) {
      return;
    }
    try {
      await onEvent(SSEEvent.from_json(jsonPayload));
    } catch {
      // Ignore malformed SSE entries.
    }
  };

  if (!response.body) {
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      await processLine(line);
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      await processLine(line);
    }
  }
  if (buffer) {
    await processLine(buffer);
  }
};

export interface SandboxOptions {
  api_key?: string | null;
  server_url?: string | null;
  log_level?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | string;
  quiet?: boolean;
  headers?: Record<string, string>;
  cloud_profile_id?: string | null;
  cloud_proxy_country_code?: string | null;
  cloud_timeout?: number | null;
  fetch_impl?: typeof fetch;
  on_browser_created?: (event: BrowserCreatedData) => void | Promise<void>;
  on_instance_ready?: () => void | Promise<void>;
  on_log?: (event: LogData) => void | Promise<void>;
  on_result?: (event: ResultData) => void | Promise<void>;
  on_error?: (event: ErrorData) => void | Promise<void>;
}

const shouldUseRemoteSandbox = (options: SandboxOptions) =>
  Boolean(
    options.server_url ||
    options.api_key ||
    options.cloud_profile_id ||
    options.cloud_proxy_country_code ||
    options.cloud_timeout
  );

export const sandbox =
  (options: SandboxOptions = {}) =>
  <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult> | TResult
  ) =>
  async (...args: TArgs): Promise<TResult> => {
    const remoteMode = shouldUseRemoteSandbox(options);
    if (!remoteMode) {
      return await fn(...args);
    }

    const apiKey =
      options.api_key?.trim() || process.env.BROWSER_USE_API_KEY?.trim();
    if (!apiKey) {
      throw new SandboxError(
        'BROWSER_USE_API_KEY is required for remote sandbox execution'
      );
    }

    const fetch_impl = options.fetch_impl ?? fetch;
    const server_url = options.server_url ?? defaultServerUrl;
    const payload: Record<string, unknown> = {
      code: Buffer.from(String(fn)).toString('base64'),
      args: Buffer.from(JSON.stringify(args)).toString('base64'),
      env: {
        LOG_LEVEL: String(options.log_level ?? 'INFO').toUpperCase(),
      },
    };

    if (options.cloud_profile_id != null) {
      payload.cloud_profile_id = options.cloud_profile_id;
    }
    if (options.cloud_proxy_country_code != null) {
      payload.cloud_proxy_country_code = options.cloud_proxy_country_code;
    }
    if (options.cloud_timeout != null) {
      payload.cloud_timeout = options.cloud_timeout;
    }

    const response = await fetch_impl(server_url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new SandboxError(
        `Sandbox request failed with status ${response.status}`
      );
    }

    let executionResult: TResult | null = null;
    let hasResult = false;

    await parseSSEChunks(response, async (event) => {
      if (
        event.type === SSEEventType.BROWSER_CREATED &&
        event.data instanceof BrowserCreatedData
      ) {
        await maybeInvoke(options.on_browser_created, event.data);
        if (!options.quiet && event.data.live_url) {
          logger.info(`🔗 Live URL: ${event.data.live_url}`);
        }
        return;
      }

      if (event.type === SSEEventType.INSTANCE_READY) {
        await maybeInvoke(options.on_instance_ready, undefined);
        return;
      }

      if (event.type === SSEEventType.LOG && event.data instanceof LogData) {
        await maybeInvoke(options.on_log, event.data);
        if (!options.quiet) {
          logger.info(event.data.message);
        }
        return;
      }

      if (
        event.type === SSEEventType.RESULT &&
        event.data instanceof ResultData
      ) {
        await maybeInvoke(options.on_result, event.data);
        if (!event.data.execution_response.success) {
          throw new SandboxError(
            `Execution failed: ${event.data.execution_response.error ?? 'unknown error'}`
          );
        }
        executionResult = event.data.execution_response.result as TResult;
        hasResult = true;
        return;
      }

      if (
        event.type === SSEEventType.ERROR &&
        event.data instanceof ErrorData
      ) {
        await maybeInvoke(options.on_error, event.data);
        throw new SandboxError(
          `Execution failed: ${event.data.error || 'unknown error'}`
        );
      }
    });

    if (!hasResult) {
      throw new SandboxError('No result received from sandbox execution');
    }
    return executionResult as TResult;
  };

export { SandboxError };
