import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserConnectedEvent,
  BrowserLaunchEvent,
  BrowserStateRequestEvent,
  BrowserStoppedEvent,
  DownloadProgressEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
  NavigationCompleteEvent,
  TabClosedEvent,
  TabCreatedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';
import { getMaxAutoDownloadBytes } from '../download-limits.js';

type CDPSessionLike = {
  send?: (method: string, params?: Record<string, unknown>) => Promise<any>;
  on?: (event: string, listener: (payload: any) => void) => void;
  off?: (event: string, listener: (payload: any) => void) => void;
  detach?: () => Promise<void>;
};

const chmodPrivatePath = (targetPath: string, mode: number) => {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    /* best effort */
  }
};

const ensurePrivateDirectoryIfCreated = (dirPath: string) => {
  const existed = fs.existsSync(dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (!existed) {
    chmodPrivatePath(dirPath, 0o700);
  }
};

type ActiveDownload = {
  url: string;
  suggested_filename: string;
  started_at: string;
  received_bytes: number;
  total_bytes: number;
  state: string;
};

type DownloadStartInfo = {
  guid: string;
  url: string;
  suggested_filename: string;
  auto_download: boolean;
};

type DownloadProgressInfo = {
  guid: string;
  received_bytes: number;
  total_bytes: number;
  state: string;
};

type DownloadCompleteInfo = {
  guid: string | null;
  url: string;
  path: string;
  file_name: string;
  file_size: number;
  file_type: string | null;
  mime_type: string | null;
  auto_download: boolean;
};

export class DownloadsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserConnectedEvent,
    BrowserLaunchEvent,
    BrowserStateRequestEvent,
    BrowserStoppedEvent,
    TabCreatedEvent,
    TabClosedEvent,
    NavigationCompleteEvent,
    DownloadStartedEvent,
    DownloadProgressEvent,
    FileDownloadedEvent,
  ];
  static override EMITS = [
    DownloadStartedEvent,
    DownloadProgressEvent,
    FileDownloadedEvent,
  ];

  private _activeDownloads = new Map<string, ActiveDownload>();
  private _downloadStartCallbacks: Array<(info: DownloadStartInfo) => void> =
    [];
  private _downloadProgressCallbacks: Array<
    (info: DownloadProgressInfo) => void
  > = [];
  private _downloadCompleteCallbacks: Array<
    (info: DownloadCompleteInfo) => void
  > = [];
  private _cdpSession: CDPSessionLike | null = null;
  private _cdpListeners: Array<{
    event: string;
    handler: (payload: any) => void;
  }> = [];
  private _networkDownloads = new Map<
    string,
    {
      guid: string;
      url: string;
      suggested_filename: string;
      mime_type: string | null;
      file_type: string | null;
      auto_download: boolean;
    }
  >();
  private _detectedDownloadUrls = new Set<string>();

  async on_BrowserConnectedEvent() {
    await this._startCdpDownloadMonitoring();
  }

  on_BrowserLaunchEvent() {
    const downloadsPath = this.browser_session.browser_profile.downloads_path;
    if (!downloadsPath) {
      return;
    }
    ensurePrivateDirectoryIfCreated(downloadsPath);
  }

  async on_BrowserStateRequestEvent(event: BrowserStateRequestEvent) {
    const activeTab = this.browser_session.active_tab;
    if (!activeTab?.target_id || !activeTab.url) {
      return;
    }

    await this.event_bus.dispatch(
      new NavigationCompleteEvent({
        target_id: activeTab.target_id,
        url: activeTab.url,
        status: null,
        error_message: null,
        loading_status: null,
        event_parent_id: event.event_id,
      })
    );
  }

  on_BrowserStoppedEvent() {
    this._activeDownloads.clear();
    this._downloadStartCallbacks = [];
    this._downloadProgressCallbacks = [];
    this._downloadCompleteCallbacks = [];
    this._networkDownloads.clear();
    this._detectedDownloadUrls.clear();
    this.runBackground(
      'stop CDP download monitoring',
      this._stopCdpDownloadMonitoring()
    );
  }

  on_TabCreatedEvent() {
    return null;
  }

  on_TabClosedEvent() {
    return null;
  }

  on_NavigationCompleteEvent() {
    return null;
  }

  on_DownloadStartedEvent(event: DownloadStartedEvent) {
    const startInfo: DownloadStartInfo = {
      guid: event.guid,
      url: event.url,
      suggested_filename: event.suggested_filename,
      auto_download: event.auto_download,
    };
    this._activeDownloads.set(event.guid, {
      url: event.url,
      suggested_filename: event.suggested_filename,
      started_at: new Date().toISOString(),
      received_bytes: 0,
      total_bytes: 0,
      state: 'inProgress',
    });

    for (const callback of this._downloadStartCallbacks) {
      try {
        callback(startInfo);
      } catch (error) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Error in download start callback: ${(error as Error).message}`
        );
      }
    }
  }

  on_DownloadProgressEvent(event: DownloadProgressEvent) {
    const existing = this._activeDownloads.get(event.guid);
    if (existing) {
      existing.received_bytes = event.received_bytes;
      existing.total_bytes = event.total_bytes;
      existing.state = event.state;
      if (event.state === 'completed' || event.state === 'canceled') {
        this._activeDownloads.delete(event.guid);
      }
    }

    const progressInfo: DownloadProgressInfo = {
      guid: event.guid,
      received_bytes: event.received_bytes,
      total_bytes: event.total_bytes,
      state: event.state,
    };
    for (const callback of this._downloadProgressCallbacks) {
      try {
        callback(progressInfo);
      } catch (error) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Error in download progress callback: ${(error as Error).message}`
        );
      }
    }
  }

  on_FileDownloadedEvent(event: FileDownloadedEvent) {
    if (event.guid) {
      this._activeDownloads.delete(event.guid);
    }
    this.browser_session.add_downloaded_file(event.path);

    const completeInfo: DownloadCompleteInfo = {
      guid: event.guid,
      url: event.url,
      path: event.path,
      file_name: event.file_name,
      file_size: event.file_size,
      file_type: event.file_type,
      mime_type: event.mime_type,
      auto_download: event.auto_download,
    };
    for (const callback of this._downloadCompleteCallbacks) {
      try {
        callback(completeInfo);
      } catch (error) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Error in download complete callback: ${(error as Error).message}`
        );
      }
    }

    return event.path;
  }

  get_active_downloads() {
    return [...this._activeDownloads.entries()].map(([guid, metadata]) => ({
      guid,
      ...metadata,
    }));
  }

  register_download_callbacks(
    on_start_or_options:
      | ((info: DownloadStartInfo) => void)
      | {
          on_start?: ((info: DownloadStartInfo) => void) | null;
          on_progress?: ((info: DownloadProgressInfo) => void) | null;
          on_complete?: ((info: DownloadCompleteInfo) => void) | null;
        }
      | null = null,
    on_progress: ((info: DownloadProgressInfo) => void) | null = null,
    on_complete: ((info: DownloadCompleteInfo) => void) | null = null
  ) {
    const {
      on_start,
      on_progress: resolvedProgress,
      on_complete: resolvedEnd,
    } = this._normalizeCallbackRegistration(
      on_start_or_options,
      on_progress,
      on_complete
    );
    if (on_start) {
      this._downloadStartCallbacks.push(on_start);
    }
    if (resolvedProgress) {
      this._downloadProgressCallbacks.push(resolvedProgress);
    }
    if (resolvedEnd) {
      this._downloadCompleteCallbacks.push(resolvedEnd);
    }
  }

  unregister_download_callbacks(
    on_start_or_options:
      | ((info: DownloadStartInfo) => void)
      | {
          on_start?: ((info: DownloadStartInfo) => void) | null;
          on_progress?: ((info: DownloadProgressInfo) => void) | null;
          on_complete?: ((info: DownloadCompleteInfo) => void) | null;
        }
      | null = null,
    on_progress: ((info: DownloadProgressInfo) => void) | null = null,
    on_complete: ((info: DownloadCompleteInfo) => void) | null = null
  ) {
    const {
      on_start,
      on_progress: resolvedProgress,
      on_complete: resolvedEnd,
    } = this._normalizeCallbackRegistration(
      on_start_or_options,
      on_progress,
      on_complete
    );
    if (on_start) {
      this._downloadStartCallbacks = this._downloadStartCallbacks.filter(
        (callback) => callback !== on_start
      );
    }
    if (resolvedProgress) {
      this._downloadProgressCallbacks = this._downloadProgressCallbacks.filter(
        (callback) => callback !== resolvedProgress
      );
    }
    if (resolvedEnd) {
      this._downloadCompleteCallbacks = this._downloadCompleteCallbacks.filter(
        (callback) => callback !== resolvedEnd
      );
    }
  }

  protected override onDetached() {
    this._activeDownloads.clear();
    this._downloadStartCallbacks = [];
    this._downloadProgressCallbacks = [];
    this._downloadCompleteCallbacks = [];
    this._networkDownloads.clear();
    this._detectedDownloadUrls.clear();
    this.runBackground(
      'stop CDP download monitoring',
      this._stopCdpDownloadMonitoring()
    );
  }

  private _normalizeCallbackRegistration(
    on_start_or_options:
      | ((info: DownloadStartInfo) => void)
      | {
          on_start?: ((info: DownloadStartInfo) => void) | null;
          on_progress?: ((info: DownloadProgressInfo) => void) | null;
          on_complete?: ((info: DownloadCompleteInfo) => void) | null;
        }
      | null,
    on_progress: ((info: DownloadProgressInfo) => void) | null,
    on_complete: ((info: DownloadCompleteInfo) => void) | null
  ) {
    if (
      on_start_or_options &&
      typeof on_start_or_options === 'object' &&
      !Array.isArray(on_start_or_options)
    ) {
      return {
        on_start: on_start_or_options.on_start ?? null,
        on_progress: on_start_or_options.on_progress ?? null,
        on_complete: on_start_or_options.on_complete ?? null,
      };
    }

    return {
      on_start:
        typeof on_start_or_options === 'function' ? on_start_or_options : null,
      on_progress,
      on_complete,
    };
  }

  private async _startCdpDownloadMonitoring() {
    if (this._cdpSession) {
      return;
    }
    if (!this.browser_session.browser_context?.newCDPSession) {
      return;
    }

    try {
      const session = (await this.browser_session.get_or_create_cdp_session(
        null
      )) as CDPSessionLike;
      const maxBytes = getMaxAutoDownloadBytes();
      await session.send?.('Network.enable', {
        maxResourceBufferSize: maxBytes,
        maxTotalBufferSize: Math.min(Number.MAX_SAFE_INTEGER, maxBytes * 2),
      });
      this._cdpSession = session;

      const onResponseReceived = (payload: any) => {
        this.runBackground(
          'handle network response',
          this._handleNetworkResponse(payload)
        );
      };
      const onLoadingFinished = (payload: any) => {
        this.runBackground(
          'handle loading finished',
          this._handleNetworkLoadingFinished(payload)
        );
      };

      session.on?.('Network.responseReceived', onResponseReceived);
      session.on?.('Network.loadingFinished', onLoadingFinished);
      this._cdpListeners = [
        {
          event: 'Network.responseReceived',
          handler: onResponseReceived,
        },
        {
          event: 'Network.loadingFinished',
          handler: onLoadingFinished,
        },
      ];
    } catch (error) {
      this.browser_session.logger.debug(
        `[DownloadsWatchdog] CDP download monitoring unavailable: ${(error as Error).message}`
      );
      await this._stopCdpDownloadMonitoring();
    }
  }

  private async _stopCdpDownloadMonitoring() {
    if (!this._cdpSession) {
      return;
    }

    for (const listener of this._cdpListeners) {
      this._cdpSession.off?.(listener.event, listener.handler);
    }
    this._cdpListeners = [];
    try {
      await this._cdpSession.detach?.();
    } catch {
      // Ignore detach errors during shutdown.
    } finally {
      this._cdpSession = null;
    }
  }

  private _getUrlDenialReason(url: string): string | null {
    const session = this.browser_session as any;
    if (typeof session._get_url_access_denial_reason === 'function') {
      try {
        return session._get_url_access_denial_reason(url);
      } catch {
        return 'blocked';
      }
    }

    if (typeof session._is_url_allowed === 'function') {
      try {
        return session._is_url_allowed(url) ? null : 'blocked';
      } catch {
        return 'blocked';
      }
    }

    return null;
  }

  private async _handleNetworkResponse(payload: any) {
    const requestId = String(payload?.requestId ?? '');
    if (!requestId) {
      return;
    }
    const response = payload?.response ?? {};
    const url = String(response?.url ?? '').trim();
    if (!url || this._detectedDownloadUrls.has(url)) {
      return;
    }

    const headers = this._normalizeHeaders(response?.headers);
    const mimeType =
      typeof response?.mimeType === 'string'
        ? response.mimeType.toLowerCase()
        : '';
    const contentDisposition = headers['content-disposition'] ?? '';
    const isPdf =
      mimeType.includes('application/pdf') || /\.pdf(?:$|\?)/i.test(url);
    const isAttachment = /attachment/i.test(contentDisposition);
    const isBinary = mimeType.includes('application/octet-stream');

    if (!isPdf && !isAttachment && !isBinary) {
      return;
    }

    const denialReason = this._getUrlDenialReason(url);
    if (denialReason) {
      this._detectedDownloadUrls.add(url);
      this.browser_session.logger.warning(
        `[DownloadsWatchdog] Blocked downloadable network response by domain policy: ${denialReason}`
      );
      return;
    }

    this._detectedDownloadUrls.add(url);

    const suggestedFilename = this._resolveSuggestedFilename(
      contentDisposition,
      url
    );
    const guid = `cdp-${requestId}`;
    const autoDownload = isPdf && this.browser_session.auto_download_pdfs();
    const fileType = this._inferFileType(suggestedFilename, mimeType);

    this._networkDownloads.set(requestId, {
      guid,
      url,
      suggested_filename: suggestedFilename,
      mime_type: mimeType || null,
      file_type: fileType,
      auto_download: autoDownload,
    });

    await this.event_bus.dispatch(
      new DownloadStartedEvent({
        guid,
        url,
        suggested_filename: suggestedFilename,
        auto_download: autoDownload,
      })
    );
  }

  private async _handleNetworkLoadingFinished(payload: any) {
    const requestId = String(payload?.requestId ?? '');
    if (!requestId) {
      return;
    }

    const metadata = this._networkDownloads.get(requestId);
    if (!metadata) {
      return;
    }
    this._networkDownloads.delete(requestId);

    const encodedDataLength =
      typeof payload?.encodedDataLength === 'number'
        ? Math.max(0, Math.floor(payload.encodedDataLength))
        : 0;

    await this.event_bus.dispatch(
      new DownloadProgressEvent({
        guid: metadata.guid,
        received_bytes: encodedDataLength,
        total_bytes: encodedDataLength,
        state: 'completed',
      })
    );

    if (
      !metadata.auto_download ||
      !metadata.mime_type?.includes('application/pdf')
    ) {
      return;
    }

    const downloadsPath = this.browser_session.browser_profile.downloads_path;
    if (!downloadsPath || !this._cdpSession?.send) {
      return;
    }

    const maxBytes = getMaxAutoDownloadBytes();
    if (encodedDataLength > maxBytes) {
      this.browser_session.logger.warning(
        `[DownloadsWatchdog] Refusing PDF auto-download larger than ${maxBytes} bytes`
      );
      return;
    }

    try {
      const responseBody = await this._cdpSession.send(
        'Network.getResponseBody',
        {
          requestId,
        }
      );
      const body =
        typeof responseBody?.body === 'string' ? responseBody.body : '';
      if (!body) {
        return;
      }

      const estimatedBodySize = responseBody?.base64Encoded
        ? Math.floor((body.trim().length * 3) / 4)
        : Buffer.byteLength(body, 'utf8');
      if (estimatedBodySize > maxBytes) {
        this.browser_session.logger.warning(
          `[DownloadsWatchdog] Refusing PDF auto-download larger than ${maxBytes} bytes`
        );
        return;
      }

      ensurePrivateDirectoryIfCreated(downloadsPath);
      const uniqueFilename = await this._getUniqueFilename(
        downloadsPath,
        metadata.suggested_filename
      );
      const filePath = path.join(downloadsPath, uniqueFilename);
      if (!this._isPathContained(filePath, downloadsPath)) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Refusing to write download outside downloads_path: ${filePath}`
        );
        return;
      }
      const content = responseBody?.base64Encoded
        ? Buffer.from(body, 'base64')
        : Buffer.from(body, 'utf8');
      if (content.length === 0 || content.length > maxBytes) {
        this.browser_session.logger.warning(
          `[DownloadsWatchdog] Refusing PDF auto-download larger than ${maxBytes} bytes`
        );
        return;
      }
      fs.writeFileSync(filePath, content, { mode: 0o600 });
      chmodPrivatePath(filePath, 0o600);

      await this.event_bus.dispatch(
        new FileDownloadedEvent({
          guid: metadata.guid,
          url: metadata.url,
          path: filePath,
          file_name: uniqueFilename,
          file_size: content.length,
          file_type: metadata.file_type,
          mime_type: metadata.mime_type,
          auto_download: true,
        })
      );
    } catch (error) {
      this.browser_session.logger.debug(
        `[DownloadsWatchdog] Failed to materialize CDP download body: ${(error as Error).message}`
      );
    }
  }

  private _normalizeHeaders(input: unknown): Record<string, string> {
    if (!input || typeof input !== 'object') {
      return {};
    }

    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ])
    );
  }

  private _resolveSuggestedFilename(contentDisposition: string, url: string) {
    const filenameMatch =
      /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(
        contentDisposition
      );
    const fromHeader = filenameMatch?.[1] || filenameMatch?.[2] || '';
    const candidate = this._decodeFilenameCandidate(fromHeader).trim();
    if (candidate) {
      return this._sanitizeFilename(candidate);
    }

    try {
      const parsed = new URL(url);
      const basename = path.basename(parsed.pathname);
      if (basename) {
        return this._sanitizeFilename(basename);
      }
    } catch {
      // Ignore URL parsing errors and fallback below.
    }

    return 'download';
  }

  private _decodeFilenameCandidate(filename: string) {
    if (!filename) {
      return '';
    }
    try {
      return decodeURIComponent(filename);
    } catch {
      return filename;
    }
  }

  private _sanitizeFilename(filename: string) {
    const basename = filename
      .replace(/\0/g, '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.trim();
    if (!basename || basename === '.' || basename === '..') {
      return 'download';
    }
    const sanitized = basename
      .replace(/[:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return sanitized || 'download';
  }

  private _inferFileType(filename: string, mimeType: string) {
    const ext = path.extname(filename).replace('.', '').toLowerCase();
    if (ext) {
      return ext;
    }
    if (mimeType.includes('pdf')) {
      return 'pdf';
    }
    return null;
  }

  private async _getUniqueFilename(directory: string, filename: string) {
    const safeFilename = this._sanitizeFilename(filename);
    const ext = path.extname(safeFilename);
    const basename = ext ? safeFilename.slice(0, -ext.length) : safeFilename;
    let candidate = safeFilename || 'download';
    let counter = 1;
    while (fs.existsSync(path.join(directory, candidate))) {
      candidate = `${basename || 'download'}_${counter}${ext}`;
      counter += 1;
    }
    return candidate;
  }

  private _isPathContained(filePath: string, directory: string) {
    const realDirectory = this._realPathForMissingPath(directory);
    const realFilePath = this._realPathForMissingPath(filePath);
    const relative = path.relative(realDirectory, realFilePath);
    return (
      relative === '' ||
      (relative !== '' &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative))
    );
  }

  private _realPathForMissingPath(inputPath: string) {
    const resolvedPath = path.resolve(inputPath);
    if (fs.existsSync(resolvedPath)) {
      return fs.realpathSync.native(resolvedPath);
    }

    const missingParts: string[] = [];
    let existingParent = resolvedPath;
    while (!fs.existsSync(existingParent)) {
      const parent = path.dirname(existingParent);
      if (parent === existingParent) {
        return resolvedPath;
      }
      missingParts.unshift(path.basename(existingParent));
      existingParent = parent;
    }

    return path.join(fs.realpathSync.native(existingParent), ...missingParts);
  }
}
