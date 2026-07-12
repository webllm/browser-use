import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserConnectedEvent,
  BrowserStopEvent,
  LoadStorageStateEvent,
  SaveStorageStateEvent,
  StorageStateLoadedEvent,
  StorageStateSavedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

type StorageStatePayload = {
  cookies?: unknown[];
  origins?: unknown[];
};

type OriginStorageEntry = {
  name?: unknown;
  value?: unknown;
};

type OriginState = {
  origin?: unknown;
  localStorage?: OriginStorageEntry[];
  sessionStorage?: OriginStorageEntry[];
};

const chmodPrivateFile = (filePath: string) => {
  if (process.platform === 'win32') {
    return;
  }
  fs.chmodSync(filePath, 0o600);
};

const ensurePrivateDirectoryIfCreated = (dirPath: string) => {
  const existed = fs.existsSync(dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (!existed && process.platform !== 'win32') {
    fs.chmodSync(dirPath, 0o700);
  }
};

const redactUrlForLogging = (url: string | null | undefined) => {
  const raw = String(url ?? '');
  if (!raw) {
    return raw;
  }
  if (/^data:/i.test(raw)) {
    return 'data:<redacted>';
  }

  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    const [withoutHash] = parsed.href.split('#', 1);
    const [withoutQuery] = withoutHash.split('?', 1);
    return `${withoutQuery}${parsed.search ? '?<redacted>' : ''}${
      parsed.hash ? '#<redacted>' : ''
    }`;
  } catch {
    const queryIndex = raw.indexOf('?');
    const hashIndex = raw.indexOf('#');
    const firstSensitiveIndex = [queryIndex, hashIndex]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (firstSensitiveIndex === undefined) {
      return raw;
    }
    return `${raw.slice(0, firstSensitiveIndex)}${
      queryIndex >= 0 ? '?<redacted>' : ''
    }${hashIndex >= 0 ? '#<redacted>' : ''}`;
  }
};

const sameOrigin = (left: string, right: string) => {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

const writePrivateFile = (filePath: string, contents: string) => {
  fs.writeFileSync(filePath, contents, { encoding: 'utf-8', mode: 0o600 });
  chmodPrivateFile(filePath);
};

export class StorageStateWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserConnectedEvent,
    BrowserStopEvent,
    SaveStorageStateEvent,
    LoadStorageStateEvent,
  ];

  static override EMITS = [StorageStateSavedEvent, StorageStateLoadedEvent];
  private _monitorInterval: NodeJS.Timeout | null = null;
  private _autoSaveIntervalMs = 30_000;
  private _monitoring = false;
  private _lastSavedSnapshot: string | null = null;

  async on_BrowserConnectedEvent() {
    this._startMonitoring();
    await this.event_bus.dispatch(new LoadStorageStateEvent());
  }

  async on_BrowserStopEvent() {
    this._stopMonitoring();
    await this.event_bus.dispatch(new SaveStorageStateEvent());
  }

  async on_SaveStorageStateEvent(event: SaveStorageStateEvent) {
    const targetPath = this._resolveStoragePath(event.path);
    if (!targetPath) {
      return;
    }

    const browserContext = this.browser_session.browser_context;
    if (!browserContext?.storageState) {
      this.browser_session.logger.debug(
        '[StorageStateWatchdog] Browser context unavailable for save'
      );
      return;
    }

    const storageState = (await browserContext.storageState()) as
      | StorageStatePayload
      | null
      | undefined;
    const normalized = storageState ?? {};
    const snapshot = this._filterStorageStateForSave({
      cookies: Array.isArray(normalized.cookies) ? normalized.cookies : [],
      origins: Array.isArray(normalized.origins) ? normalized.origins : [],
    });
    this._lastSavedSnapshot = this._snapshotStorageState(snapshot);

    const dirPath = path.dirname(targetPath);
    ensurePrivateDirectoryIfCreated(dirPath);

    const tempPath = `${targetPath}.tmp`;
    writePrivateFile(tempPath, JSON.stringify(snapshot, null, 2));

    if (fs.existsSync(targetPath)) {
      const backupPath = `${targetPath}.bak`;
      try {
        fs.renameSync(targetPath, backupPath);
        chmodPrivateFile(backupPath);
      } catch {
        // Ignore backup failures and continue with atomic swap.
      }
    }

    fs.renameSync(tempPath, targetPath);
    chmodPrivateFile(targetPath);

    await this.event_bus.dispatch(
      new StorageStateSavedEvent({
        path: targetPath,
        cookies_count: Array.isArray(snapshot.cookies)
          ? snapshot.cookies.length
          : 0,
        origins_count: Array.isArray(snapshot.origins)
          ? snapshot.origins.length
          : 0,
      })
    );
  }

  async on_LoadStorageStateEvent(event: LoadStorageStateEvent) {
    const targetPath = this._resolveStoragePath(event.path);
    if (!targetPath || !fs.existsSync(targetPath)) {
      return;
    }

    const browserContext = this.browser_session.browser_context;
    if (!browserContext) {
      this.browser_session.logger.debug(
        '[StorageStateWatchdog] Browser context unavailable for load'
      );
      return;
    }

    const raw = fs.readFileSync(targetPath, 'utf-8');
    const parsed = JSON.parse(raw) as StorageStatePayload;
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const origins = Array.isArray(parsed.origins) ? parsed.origins : [];
    this._lastSavedSnapshot = this._snapshotStorageState({
      cookies,
      origins,
    });

    const allowedCookies = this._filterCookies(cookies);
    if (
      allowedCookies.length > 0 &&
      typeof browserContext.addCookies === 'function'
    ) {
      await browserContext.addCookies(allowedCookies as any[]);
    }

    const originsLoaded =
      origins.length > 0
        ? await this._applyOriginsStorage(origins as OriginState[])
        : 0;

    await this.event_bus.dispatch(
      new StorageStateLoadedEvent({
        path: targetPath,
        cookies_count: allowedCookies.length,
        origins_count: originsLoaded,
      })
    );
  }

  protected override onDetached() {
    this._stopMonitoring();
  }

  private _resolveStoragePath(pathFromEvent: string | null): string | null {
    if (typeof pathFromEvent === 'string' && pathFromEvent.trim().length > 0) {
      return path.resolve(pathFromEvent);
    }

    const configured =
      this.browser_session.browser_profile.config.storage_state;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return path.resolve(configured);
    }

    const cookiesFile = this.browser_session.browser_profile.cookies_file;
    if (typeof cookiesFile === 'string' && cookiesFile.trim().length > 0) {
      return path.resolve(cookiesFile);
    }

    return null;
  }

  private _startMonitoring() {
    if (this._monitorInterval) {
      return;
    }
    if (!this._resolveStoragePath(null)) {
      return;
    }
    this._monitorInterval = setInterval(() => {
      void this._checkAndAutoSave().catch((error) => {
        this.browser_session.logger.debug(
          `[StorageStateWatchdog] Auto-save monitor failed: ${(error as Error).message}`
        );
      });
    }, this._autoSaveIntervalMs);
  }

  private _stopMonitoring() {
    if (!this._monitorInterval) {
      return;
    }
    clearInterval(this._monitorInterval);
    this._monitorInterval = null;
  }

  private async _checkAndAutoSave() {
    if (this._monitoring) {
      return;
    }

    const browserContext = this.browser_session.browser_context;
    if (!browserContext?.storageState) {
      return;
    }

    this._monitoring = true;
    try {
      const storageState = (await browserContext.storageState()) as
        | StorageStatePayload
        | null
        | undefined;
      const normalized = storageState ?? {};
      const snapshot = this._snapshotStorageState(
        this._filterStorageStateForSave({
          cookies: Array.isArray(normalized.cookies) ? normalized.cookies : [],
          origins: Array.isArray(normalized.origins) ? normalized.origins : [],
        })
      );
      if (snapshot === this._lastSavedSnapshot) {
        return;
      }
      await this.event_bus.dispatch(new SaveStorageStateEvent());
    } finally {
      this._monitoring = false;
    }
  }

  private _snapshotStorageState(state: StorageStatePayload) {
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const origins = Array.isArray(state.origins) ? state.origins : [];
    return JSON.stringify({
      cookies,
      origins,
    });
  }

  private _filterStorageStateForSave(
    state: StorageStatePayload
  ): StorageStatePayload {
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const origins = Array.isArray(state.origins) ? state.origins : [];
    if (!this._hasUrlAccessRestrictions()) {
      return { cookies, origins };
    }

    return {
      cookies: this._filterCookies(cookies),
      origins: this._filterOrigins(origins),
    };
  }

  private _hasUrlAccessRestrictions() {
    const profile = this.browser_session.browser_profile;
    const hasEntries = (value: unknown) =>
      Array.isArray(value)
        ? value.length > 0
        : value instanceof Set && value.size > 0;

    return (
      hasEntries(profile.allowed_domains) ||
      hasEntries(profile.prohibited_domains) ||
      Boolean(profile.block_ip_addresses)
    );
  }

  private async _applyOriginsStorage(origins: OriginState[]) {
    const browserContext = this.browser_session.browser_context as {
      newPage?: () => Promise<{
        goto?: (
          url: string,
          options?: Record<string, unknown>
        ) => Promise<unknown>;
        url?: () => string;
        evaluate?: (
          fn: (payload: {
            localStorageEntries: Array<{ name: string; value: string }>;
            sessionStorageEntries: Array<{ name: string; value: string }>;
          }) => void,
          arg: {
            localStorageEntries: Array<{ name: string; value: string }>;
            sessionStorageEntries: Array<{ name: string; value: string }>;
          }
        ) => Promise<unknown>;
        close?: () => Promise<unknown>;
      }>;
    } | null;

    if (!browserContext?.newPage) {
      return 0;
    }

    let loadedCount = 0;
    for (const originState of origins) {
      const origin =
        typeof originState?.origin === 'string'
          ? originState.origin.trim()
          : '';
      if (!origin || !/^https?:\/\//i.test(origin)) {
        continue;
      }
      const denialReason = this._getOriginDenialReason(origin);
      if (denialReason) {
        this.browser_session.logger.warning(
          `[StorageStateWatchdog] Skipping storage origin ${redactUrlForLogging(
            origin
          )}: ${denialReason}`
        );
        continue;
      }

      const localStorageEntries = this._normalizeStorageEntries(
        originState?.localStorage
      );
      const sessionStorageEntries = this._normalizeStorageEntries(
        originState?.sessionStorage
      );
      if (
        localStorageEntries.length === 0 &&
        sessionStorageEntries.length === 0
      ) {
        continue;
      }

      let page: {
        goto?: (
          url: string,
          options?: Record<string, unknown>
        ) => Promise<unknown>;
        url?: () => string;
        evaluate?: (
          fn: (payload: {
            localStorageEntries: Array<{ name: string; value: string }>;
            sessionStorageEntries: Array<{ name: string; value: string }>;
          }) => void,
          arg: {
            localStorageEntries: Array<{ name: string; value: string }>;
            sessionStorageEntries: Array<{ name: string; value: string }>;
          }
        ) => Promise<unknown>;
        close?: () => Promise<unknown>;
      } | null = null;

      try {
        page = await browserContext.newPage();
        await page.goto?.(origin, {
          waitUntil: 'domcontentloaded',
          timeout: 5_000,
        });
        const finalUrl = typeof page.url === 'function' ? page.url() : origin;
        const finalDenialReason = this._getOriginDenialReason(finalUrl);
        if (finalDenialReason) {
          this.browser_session.logger.warning(
            `[StorageStateWatchdog] Skipping storage origin ${redactUrlForLogging(
              origin
            )} after redirect to blocked URL: ${finalDenialReason}`
          );
          try {
            await page.goto?.('about:blank', {
              waitUntil: 'load',
              timeout: 5_000,
            });
          } catch {
            // The temporary page is closed below; resetting first is best effort.
          }
          continue;
        }
        if (!sameOrigin(origin, finalUrl)) {
          this.browser_session.logger.warning(
            `[StorageStateWatchdog] Skipping storage origin ${redactUrlForLogging(
              origin
            )} after redirect to a different origin`
          );
          try {
            await page.goto?.('about:blank', {
              waitUntil: 'load',
              timeout: 5_000,
            });
          } catch {
            // The temporary page is closed below; resetting first is best effort.
          }
          continue;
        }
        await page.evaluate?.(
          (payload) => {
            for (const entry of payload.localStorageEntries) {
              window.localStorage.setItem(entry.name, entry.value);
            }
            for (const entry of payload.sessionStorageEntries) {
              window.sessionStorage.setItem(entry.name, entry.value);
            }
          },
          {
            localStorageEntries,
            sessionStorageEntries,
          }
        );
        loadedCount += 1;
      } catch (error) {
        this.browser_session.logger.debug(
          `[StorageStateWatchdog] Failed to apply origin storage for ${redactUrlForLogging(
            origin
          )}: ${(error as Error).message}`
        );
      } finally {
        try {
          await page?.close?.();
        } catch {
          // Ignore cleanup errors.
        }
      }
    }
    return loadedCount;
  }

  private _getOriginDenialReason(origin: string): string | null {
    const session = this.browser_session as any;
    if (typeof session._get_url_access_denial_reason === 'function') {
      try {
        return session._get_url_access_denial_reason(origin);
      } catch {
        return 'blocked';
      }
    }

    if (typeof session._is_url_allowed === 'function') {
      try {
        return session._is_url_allowed(origin) ? null : 'blocked';
      } catch {
        return 'blocked';
      }
    }

    return null;
  }

  private _filterCookies(cookies: unknown[]) {
    return cookies.filter((cookie) => {
      const denialReason = this._getCookieDenialReason(cookie);
      if (!denialReason) {
        return true;
      }
      const cookieName =
        cookie && typeof cookie === 'object' && 'name' in cookie
          ? String((cookie as any).name ?? '')
          : '';
      this.browser_session.logger.warning(
        `[StorageStateWatchdog] Skipping storage cookie ${cookieName || '<unnamed>'}: ${denialReason}`
      );
      return false;
    });
  }

  private _filterOrigins(origins: unknown[]) {
    return origins.filter((originState) => {
      const origin =
        originState &&
        typeof originState === 'object' &&
        'origin' in originState &&
        typeof (originState as any).origin === 'string'
          ? (originState as any).origin.trim()
          : '';
      const denialReason = origin
        ? this._getOriginDenialReason(origin)
        : 'invalid_url';
      if (!denialReason) {
        return true;
      }
      this.browser_session.logger.warning(
        `[StorageStateWatchdog] Skipping saved storage origin ${
          origin ? redactUrlForLogging(origin) : '<invalid>'
        }: ${denialReason}`
      );
      return false;
    });
  }

  private _getCookieDenialReason(cookie: unknown): string | null {
    const session = this.browser_session as any;
    if (typeof session._get_cookie_access_denial_reason === 'function') {
      try {
        return session._get_cookie_access_denial_reason(cookie);
      } catch {
        return 'blocked';
      }
    }

    if (!cookie || typeof cookie !== 'object') {
      return null;
    }
    const cookieLike = cookie as { url?: unknown; domain?: unknown };
    const explicitUrl =
      typeof cookieLike.url === 'string' ? cookieLike.url.trim() : '';
    if (explicitUrl) {
      return this._getOriginDenialReason(explicitUrl);
    }

    const rawDomain =
      typeof cookieLike.domain === 'string' ? cookieLike.domain.trim() : '';
    const host = rawDomain.replace(/^\./, '');
    if (!host) {
      return null;
    }
    return this._getOriginDenialReason(`https://${host}`);
  }

  private _normalizeStorageEntries(entries: unknown) {
    if (!Array.isArray(entries)) {
      return [] as Array<{ name: string; value: string }>;
    }

    const normalized: Array<{ name: string; value: string }> = [];
    for (const entry of entries) {
      const name =
        entry && typeof entry === 'object' && 'name' in entry
          ? String((entry as any).name ?? '')
          : '';
      if (!name) {
        continue;
      }
      const value =
        entry && typeof entry === 'object' && 'value' in entry
          ? String((entry as any).value ?? '')
          : '';
      normalized.push({
        name,
        value,
      });
    }
    return normalized;
  }
}
