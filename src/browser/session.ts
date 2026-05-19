import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
} from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logging-config.js';
import { match_url_with_domain_pattern, uuid7str } from '../utils.js';
import {
  EventBus,
  type EventDispatchOptions,
  type EventPayload,
} from '../event-bus.js';
import {
  async_playwright,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from './types.js';
import {
  BrowserProfile,
  CHROME_DOCKER_ARGS,
  type BrowserProfileOptions,
  DEFAULT_BROWSER_PROFILE,
} from './profile.js';
import {
  BrowserStateSummary,
  type NetworkRequest,
  type TabInfo,
  BrowserError,
  URLNotAllowedError,
} from './views.js';
import {
  AgentFocusChangedEvent,
  BrowserConnectedEvent,
  BrowserErrorEvent,
  BrowserLaunchEvent,
  BrowserReconnectedEvent,
  BrowserReconnectingEvent,
  BrowserStartEvent,
  BrowserStoppedEvent,
  BrowserStopEvent,
  DialogOpenedEvent,
  DownloadProgressEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
  TabClosedEvent,
  TabCreatedEvent,
  type WaitUntilState,
} from './events.js';
import { DOMElementNode, DOMState, type SelectorMap } from '../dom/views.js';
import { normalize_url } from './utils.js';
import { DomService } from '../dom/service.js';
import {
  showDVDScreensaver,
  showSpinner,
  withDVDScreensaver,
} from './dvd-screensaver.js';
import { SessionManager } from './session-manager.js';
import { AboutBlankWatchdog } from './watchdogs/aboutblank-watchdog.js';
import {
  CaptchaWatchdog,
  type CaptchaWaitResult,
} from './watchdogs/captcha-watchdog.js';
import { CDPSessionWatchdog } from './watchdogs/cdp-session-watchdog.js';
import { CrashWatchdog } from './watchdogs/crash-watchdog.js';
import { DefaultActionWatchdog } from './watchdogs/default-action-watchdog.js';
import { DOMWatchdog } from './watchdogs/dom-watchdog.js';
import { DownloadsWatchdog } from './watchdogs/downloads-watchdog.js';
import { HarRecordingWatchdog } from './watchdogs/har-recording-watchdog.js';
import { LocalBrowserWatchdog } from './watchdogs/local-browser-watchdog.js';
import { PermissionsWatchdog } from './watchdogs/permissions-watchdog.js';
import { PopupsWatchdog } from './watchdogs/popups-watchdog.js';
import { RecordingWatchdog } from './watchdogs/recording-watchdog.js';
import { ScreenshotWatchdog } from './watchdogs/screenshot-watchdog.js';
import { SecurityWatchdog } from './watchdogs/security-watchdog.js';
import { StorageStateWatchdog } from './watchdogs/storage-state-watchdog.js';
import type { BaseWatchdog } from './watchdogs/base.js';

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_OPTION_KEY_OVERRIDES: Record<string, string> = {
  extra_http_headers: 'extraHTTPHeaders',
};
const EMPTY_DOM_RETRY_DELAY_MS = 250;
const REMOTE_RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const;
const REMOTE_RECONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

type SystemChromeVariant =
  | 'chrome'
  | 'chrome-canary'
  | 'chrome-beta'
  | 'chrome-unstable'
  | 'chromium';

type BrowserEventEmitterLike = Browser & {
  on?: (event: string, listener: (...args: any[]) => void) => void;
  off?: (event: string, listener: (...args: any[]) => void) => void;
  removeListener?: (event: string, listener: (...args: any[]) => void) => void;
  isConnected?: () => boolean;
};

export interface BrowserSessionInit {
  id?: string;
  browser_profile?: BrowserProfile;
  profile?: Partial<BrowserProfileOptions>;
  browser?: Browser | null;
  browser_context?: BrowserContext | null;
  page?: Page | null;
  title?: string | null;
  url?: string | null;
  wss_url?: string | null;
  cdp_url?: string | null;
  browser_pid?: number | null;
  playwright?: unknown;
  downloaded_files?: string[];
  closed_popup_messages?: string[];
}

export interface ChromeProfileInfo {
  directory: string;
  name: string;
  email?: string;
}

const cloneBrowserProfileConfig = (profile: BrowserProfile) =>
  typeof structuredClone === 'function'
    ? structuredClone(profile.config)
    : JSON.parse(JSON.stringify(profile.config));

const detectSystemChromeVariant = (
  executablePath: string | null | undefined
): SystemChromeVariant => {
  const normalizedPath = String(executablePath ?? '')
    .trim()
    .toLowerCase();
  if (!normalizedPath) {
    return 'chrome';
  }
  if (normalizedPath.includes('chromium')) {
    return 'chromium';
  }
  if (
    normalizedPath.includes('chrome canary') ||
    normalizedPath.includes('chrome sxs')
  ) {
    return 'chrome-canary';
  }
  if (normalizedPath.includes('google-chrome-beta')) {
    return 'chrome-beta';
  }
  if (normalizedPath.includes('google-chrome-unstable')) {
    return 'chrome-unstable';
  }
  return 'chrome';
};

export const systemChrome = {
  findExecutable(): string | null {
    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ];
      return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    }

    if (process.platform === 'linux') {
      const commands = [
        'google-chrome',
        'google-chrome-stable',
        'google-chrome-beta',
        'google-chrome-unstable',
        'chromium',
        'chromium-browser',
      ];
      for (const command of commands) {
        try {
          const resolved = execFileSync('which', [command], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (resolved) {
            return resolved;
          }
        } catch {
          // Ignore missing commands and try the next candidate.
        }
      }
      return null;
    }

    if (process.platform === 'win32') {
      const candidates = [
        path.join(
          process.env.ProgramFiles ?? 'C:\\Program Files',
          'Google',
          'Chrome',
          'Application',
          'chrome.exe'
        ),
        path.join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Google',
          'Chrome',
          'Application',
          'chrome.exe'
        ),
        path.join(
          process.env.LOCALAPPDATA ?? '',
          'Google',
          'Chrome',
          'Application',
          'chrome.exe'
        ),
        path.join(
          process.env.LOCALAPPDATA ?? '',
          'Google',
          'Chrome SxS',
          'Application',
          'chrome.exe'
        ),
        path.join(
          process.env.LOCALAPPDATA ?? '',
          'Chromium',
          'Application',
          'chrome.exe'
        ),
        path.join(
          process.env.ProgramFiles ?? 'C:\\Program Files',
          'Chromium',
          'Application',
          'chrome.exe'
        ),
        path.join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Chromium',
          'Application',
          'chrome.exe'
        ),
      ];
      return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    }

    return null;
  },

  getUserDataDir(
    executablePath: string | null = systemChrome.findExecutable()
  ): string | null {
    const variant = detectSystemChromeVariant(executablePath);
    if (process.platform === 'darwin') {
      const applicationSupportDir = path.join(
        os.homedir(),
        'Library',
        'Application Support'
      );
      if (variant === 'chromium') {
        return path.join(applicationSupportDir, 'Chromium');
      }
      if (variant === 'chrome-canary') {
        return path.join(applicationSupportDir, 'Google', 'Chrome Canary');
      }
      return path.join(applicationSupportDir, 'Google', 'Chrome');
    }
    if (process.platform === 'linux') {
      if (variant === 'chromium') {
        return path.join(os.homedir(), '.config', 'chromium');
      }
      if (variant === 'chrome-beta') {
        return path.join(os.homedir(), '.config', 'google-chrome-beta');
      }
      if (variant === 'chrome-unstable') {
        return path.join(os.homedir(), '.config', 'google-chrome-unstable');
      }
      return path.join(os.homedir(), '.config', 'google-chrome');
    }
    if (process.platform === 'win32') {
      const localAppData =
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
      if (variant === 'chromium') {
        return path.join(localAppData, 'Chromium', 'User Data');
      }
      if (variant === 'chrome-canary') {
        return path.join(localAppData, 'Google', 'Chrome SxS', 'User Data');
      }
      return path.join(localAppData, 'Google', 'Chrome', 'User Data');
    }
    return null;
  },

  listProfiles(userDataDir: string | null = systemChrome.getUserDataDir()) {
    if (!userDataDir) {
      return [] as ChromeProfileInfo[];
    }

    const localStatePath = path.join(userDataDir, 'Local State');
    if (!fs.existsSync(localStatePath)) {
      return [] as ChromeProfileInfo[];
    }

    try {
      const raw = fs.readFileSync(localStatePath, 'utf8');
      const localState = JSON.parse(raw) as {
        profile?: {
          info_cache?: Record<string, { name?: string; user_name?: string }>;
        };
      };
      const infoCache = localState.profile?.info_cache ?? {};
      return Object.entries(infoCache)
        .map(([directory, info]) => ({
          directory,
          name: info?.name || directory,
          email: info?.user_name || '',
        }))
        .sort((left, right) => left.directory.localeCompare(right.directory));
    } catch {
      return [] as ChromeProfileInfo[];
    }
  },
};

export interface BrowserSessionFromSystemChromeInit extends Omit<
  BrowserSessionInit,
  'browser_profile' | 'profile'
> {
  browser_profile?: BrowserProfile;
  profile?: Partial<BrowserProfileOptions>;
  profile_directory?: string | null;
}

const createEmptyDomState = (): DOMState => {
  const root = new DOMElementNode(true, null, 'html', '/html[1]', {}, []);
  return new DOMState(root, {} as SelectorMap);
};

/**
 * Cached clickable elements hashes for the last state
 * Used to reduce token usage by tracking which elements are new
 */
interface CachedClickableElementHashes {
  url: string;
  hashes: Set<string>;
}

export interface BrowserStateOptions {
  cache_clickable_elements_hashes?: boolean;
  include_screenshot?: boolean;
  include_recent_events?: boolean;
  signal?: AbortSignal | null;
}

export interface BrowserActionOptions {
  signal?: AbortSignal | null;
  clear?: boolean;
}

export interface BrowserNavigationOptions extends BrowserActionOptions {
  wait_until?: WaitUntilState;
  timeout_ms?: number | null;
}

interface RecentBrowserEvent {
  event_type: string;
  timestamp: string;
  url?: string;
  error_message?: string;
  page_id?: number;
  tab_id?: string;
}

export class BrowserSession {
  readonly id: string;
  readonly browser_profile: BrowserProfile;
  readonly event_bus: EventBus;
  readonly session_manager: SessionManager;
  browser: Browser | null;
  browser_context: BrowserContext | null;
  agent_current_page: Page | null;
  human_current_page: Page | null;
  initialized = false;
  wss_url: string | null;
  cdp_url: string | null;
  browser_pid: number | null;
  playwright: unknown;
  private cachedBrowserState: BrowserStateSummary | null = null;
  private _cachedClickableElementHashes: CachedClickableElementHashes | null =
    null;
  private currentUrl: string;
  private currentTitle: string;
  private _logger: ReturnType<typeof createLogger> | null = null;
  private _tabCounter = 0;
  private _tabs: TabInfo[] = [];
  private currentTabIndex = 0;
  private historyStack: string[] = [];
  downloaded_files: string[] = [];
  llm_screenshot_size: [number, number] | null = null;
  _original_viewport_size: [number, number] | null = null;
  private ownsBrowserResources = true;
  private _autoDownloadPdfs = true;
  private tabPages = new Map<number, Page | null>();
  private currentPageLoadingStatus: string | null = null;
  private _subprocess: ChildProcess | null = null;
  private _childProcesses: Set<number> = new Set();
  private attachedAgentId: string | null = null;
  private attachedSharedAgentIds: Set<string> = new Set();
  private _stoppingPromise: Promise<void> | null = null;
  private _closedPopupMessages: string[] = [];
  private _dialogHandlersAttached = new WeakSet<Page>();
  private readonly _maxClosedPopupMessages = 20;
  private _recentEvents: RecentBrowserEvent[] = [];
  private readonly _maxRecentEvents = 100;
  private _watchdogs: Set<BaseWatchdog> = new Set();
  private _defaultWatchdogsAttached = false;
  private _captchaWatchdog: CaptchaWatchdog | null = null;
  readonly RECONNECT_WAIT_TIMEOUT = 54;
  private _reconnecting = false;
  private _reconnectTask: Promise<void> | null = null;
  private _reconnectWaitPromise: Promise<void> = Promise.resolve();
  private _resolveReconnectWait: (() => void) | null = null;
  private _intentionalStop = false;
  private _disconnectAwareBrowser: BrowserEventEmitterLike | null = null;
  private _browserDisconnectHandler: (() => void) | null = null;

  constructor(init: BrowserSessionInit = {}) {
    const sourceProfileConfig = init.browser_profile
      ? cloneBrowserProfileConfig(init.browser_profile)
      : (init.profile ?? {});
    this.browser_profile = new BrowserProfile(sourceProfileConfig);
    this.id = init.id ?? uuid7str();
    this.event_bus = new EventBus(`BrowserSession_${this.id.slice(-4)}`);
    this.session_manager = new SessionManager();
    this.browser = init.browser ?? null;
    this.browser_context = init.browser_context ?? null;
    this.agent_current_page = init.page ?? null;
    this.human_current_page = init.page ?? null;
    this.currentUrl = normalize_url(init.url ?? 'about:blank');
    this.currentTitle = init.title ?? '';
    this.wss_url = init.wss_url ?? null;
    this.cdp_url = init.cdp_url ?? null;
    this.browser_pid = init.browser_pid ?? null;
    this.playwright = init.playwright ?? null;
    this.downloaded_files = Array.isArray(init.downloaded_files)
      ? [...init.downloaded_files]
      : [];
    this._closedPopupMessages = Array.isArray(init.closed_popup_messages)
      ? [...init.closed_popup_messages]
      : [];
    if (typeof (init as any)?.auto_download_pdfs === 'boolean') {
      this._autoDownloadPdfs = Boolean((init as any).auto_download_pdfs);
    }
    const initialPageId = this._tabCounter++;
    this._tabs = [
      this._createTabInfo({
        page_id: initialPageId,
        url: this.currentUrl,
        title: this.currentTitle || this.currentUrl,
      }),
    ];
    this.historyStack.push(this.currentUrl);
    this.ownsBrowserResources = this._determineOwnership();
    this.tabPages.set(this._tabs[0].page_id, this.agent_current_page ?? null);
    this._syncSessionManagerFromTabs();
    this._attachDialogHandler(this.agent_current_page);
    this._recordRecentEvent('session_initialized', { url: this.currentUrl });
  }

  static from_system_chrome(
    init: BrowserSessionFromSystemChromeInit = {}
  ): BrowserSession {
    const executablePath = systemChrome.findExecutable();
    if (!executablePath) {
      throw new Error(
        'Chrome not found. Please install Chrome or use BrowserSession with an explicit executable_path.\n' +
          'Expected locations:\n' +
          '  macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n' +
          '  Linux: /usr/bin/google-chrome or /usr/bin/chromium\n' +
          '  Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      );
    }

    const userDataDir = systemChrome.getUserDataDir(executablePath);
    if (!userDataDir) {
      throw new Error(
        'Could not detect Chrome profile directory for your platform.\n' +
          'Expected locations:\n' +
          '  macOS: ~/Library/Application Support/Google/Chrome\n' +
          '  Linux: ~/.config/google-chrome\n' +
          '  Windows: %LocalAppData%\\Google\\Chrome\\User Data'
      );
    }

    const availableProfiles = systemChrome.listProfiles(userDataDir);
    const selectedProfileDirectory =
      init.profile_directory ?? availableProfiles[0]?.directory ?? 'Default';

    if (typeof init.profile_directory === 'undefined' && availableProfiles[0]) {
      createLogger('browser_use.browser.session').info(
        `Auto-selected Chrome profile: ${availableProfiles[0].name} (${availableProfiles[0].directory})`
      );
    }

    const sourceProfileConfig = init.browser_profile
      ? cloneBrowserProfileConfig(init.browser_profile)
      : (init.profile ?? {});
    const {
      browser_profile: _browserProfile,
      profile: _profile,
      profile_directory: _profileDirectory,
      ...sessionInit
    } = init;

    return new BrowserSession({
      ...sessionInit,
      browser_profile: new BrowserProfile({
        ...sourceProfileConfig,
        executable_path: executablePath,
        user_data_dir: userDataDir,
        profile_directory: selectedProfileDirectory,
      }),
    });
  }

  static list_chrome_profiles(): ChromeProfileInfo[] {
    const executablePath = systemChrome.findExecutable();
    const userDataDir = systemChrome.getUserDataDir(executablePath);
    return systemChrome.listProfiles(userDataDir);
  }

  attach_watchdog(watchdog: BaseWatchdog) {
    if (this._watchdogs.has(watchdog)) {
      return;
    }
    watchdog.attach_to_session();
    this._watchdogs.add(watchdog);
    if (watchdog instanceof CaptchaWatchdog) {
      this._captchaWatchdog = watchdog;
    }
  }

  attach_watchdogs(watchdogs: BaseWatchdog[]) {
    for (const watchdog of watchdogs) {
      this.attach_watchdog(watchdog);
    }
  }

  detach_watchdog(watchdog: BaseWatchdog) {
    if (!this._watchdogs.has(watchdog)) {
      return;
    }
    watchdog.detach_from_session();
    this._watchdogs.delete(watchdog);
    if (watchdog === this._captchaWatchdog) {
      this._captchaWatchdog = null;
    }
  }

  detach_all_watchdogs() {
    for (const watchdog of [...this._watchdogs]) {
      this.detach_watchdog(watchdog);
    }
    this._defaultWatchdogsAttached = false;
    this._captchaWatchdog = null;
  }

  get_watchdogs() {
    return [...this._watchdogs];
  }

  async dispatch_browser_event<TEvent extends EventPayload>(
    event: TEvent,
    options: Omit<EventDispatchOptions, 'throw_on_error'> = {}
  ) {
    return this.event_bus.dispatch_or_throw(event, options);
  }

  async launch() {
    this.attach_default_watchdogs();
    const dispatchResult = await this.dispatch_browser_event(
      new BrowserLaunchEvent()
    );
    const eventResult = dispatchResult.event.event_result as
      | { cdp_url?: string | null }
      | null
      | undefined;
    return {
      cdp_url:
        eventResult?.cdp_url ?? this.cdp_url ?? this.wss_url ?? 'playwright',
    };
  }

  attach_default_watchdogs() {
    if (this._defaultWatchdogsAttached) {
      return;
    }
    const watchdogs: BaseWatchdog[] = [
      new LocalBrowserWatchdog({ browser_session: this }),
      new CDPSessionWatchdog({ browser_session: this }),
      new CrashWatchdog({ browser_session: this }),
      new AboutBlankWatchdog({ browser_session: this }),
      new PermissionsWatchdog({ browser_session: this }),
      new PopupsWatchdog({ browser_session: this }),
      new SecurityWatchdog({ browser_session: this }),
      new DOMWatchdog({ browser_session: this }),
      new ScreenshotWatchdog({ browser_session: this }),
      new RecordingWatchdog({ browser_session: this }),
      new DownloadsWatchdog({ browser_session: this }),
      new StorageStateWatchdog({ browser_session: this }),
      new DefaultActionWatchdog({ browser_session: this }),
    ];

    if (this.browser_profile.config.captcha_solver) {
      this._captchaWatchdog = new CaptchaWatchdog({ browser_session: this });
      watchdogs.push(this._captchaWatchdog);
    }

    const configuredHarPath = this.browser_profile.config.record_har_path;
    if (
      typeof configuredHarPath === 'string' &&
      configuredHarPath.trim().length > 0
    ) {
      watchdogs.push(new HarRecordingWatchdog({ browser_session: this }));
    }

    this.attach_watchdogs(watchdogs);
    this._defaultWatchdogsAttached = true;
  }

  async wait_if_captcha_solving(
    timeoutSeconds?: number
  ): Promise<CaptchaWaitResult | null> {
    return (
      this._captchaWatchdog?.wait_if_captcha_solving(timeoutSeconds) ?? null
    );
  }

  private _formatTabId(pageId: number): string {
    const normalized =
      Number.isFinite(pageId) && pageId >= 0 ? Math.floor(pageId) : 0;
    return String(normalized).padStart(4, '0').slice(-4);
  }

  private _createTabInfo({
    page_id,
    url,
    title,
    parent_page_id = null,
  }: {
    page_id: number;
    url: string;
    title: string;
    parent_page_id?: number | null;
  }): TabInfo {
    return {
      page_id,
      tab_id: this._formatTabId(page_id),
      target_id: this._buildSyntheticTargetId(page_id),
      url,
      title,
      parent_page_id,
    };
  }

  private _buildSyntheticTargetId(pageId: number) {
    return `tab_${this.id.slice(-4)}_${this._formatTabId(pageId)}`;
  }

  private _syncSessionManagerFromTabs() {
    this.session_manager.sync_tabs(
      this._tabs,
      this.currentTabIndex,
      (page_id) => this._buildSyntheticTargetId(page_id)
    );
  }

  async get_or_create_cdp_session(page: Page | null = null): Promise<any> {
    if (!this.browser_context?.newCDPSession) {
      throw new Error(
        'CDP sessions are not available for this browser context'
      );
    }

    const targetPage = page ?? (await this.get_current_page());
    if (!targetPage) {
      throw new Error('No active page available to create CDP session');
    }

    return this.browser_context.newCDPSession(targetPage);
  }

  private async _waitForStableNetwork(
    page: Page,
    signal: AbortSignal | null = null
  ) {
    const pendingRequests = new Set<any>();
    let lastActivity = Date.now() / 1000;

    // Relevant resource types that indicate page loading progress
    const relevantResourceTypes = new Set([
      'document',
      'stylesheet',
      'image',
      'font',
      'script',
      'iframe',
    ]);
    const ignoredResourceTypes = new Set([
      'websocket',
      'media',
      'eventsource',
      'manifest',
      'other',
    ]);

    // Expanded URL pattern filters - more comprehensive blocking
    const ignoredUrlPatterns = [
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      'push-notifications',
      'onesignal',
      'pushwoosh',
      'heartbeat',
      'ping',
      'alive',
      'webrtc',
      'rtmp://',
      'wss://',
      'cloudfront.net/assets',
      'fastly.net',
    ];

    // Content types that should be filtered
    const relevantContentTypes = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'application/x-javascript',
      'text/javascript',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'font/woff',
      'font/woff2',
      'application/font-woff',
      'application/font-woff2',
    ]);

    // Streaming media content types to ignore
    const streamingContentTypes = new Set([
      'video/',
      'audio/',
      'application/octet-stream',
      'application/x-mpegurl',
      'application/vnd.apple.mpegurl',
    ]);

    // Max response size to track (5MB)
    const maxResponseSize = 5 * 1024 * 1024;

    const onRequest = (request: any) => {
      const resourceType = request.resourceType?.() ?? request.resourceType;
      if (!resourceType || !relevantResourceTypes.has(resourceType)) {
        return;
      }
      if (ignoredResourceTypes.has(resourceType)) {
        return;
      }

      const url =
        request.url?.().toLowerCase?.() ?? request.url?.toLowerCase?.() ?? '';

      // Filter data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter by URL patterns
      if (
        ignoredUrlPatterns.some((pattern) =>
          url.includes(pattern.toLowerCase())
        )
      ) {
        return;
      }

      // Filter prefetch requests
      const headers = request.headers?.() ?? request.headers ?? {};
      const purpose = headers['purpose'] || headers['sec-fetch-dest'];
      if (purpose === 'prefetch' || headers['x-moz'] === 'prefetch') {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now() / 1000;
    };

    const onResponse = async (response: any) => {
      const request = response.request?.() ?? response.request;
      if (!pendingRequests.has(request)) {
        return;
      }

      try {
        // Check Content-Type header
        const headers = response.headers?.() ?? response.headers ?? {};
        const contentType =
          headers['content-type'] || headers['Content-Type'] || '';

        // Filter streaming media
        if (streamingContentTypes.has(contentType.split(';')[0].trim())) {
          pendingRequests.delete(request);
          return;
        }

        // Check if content type is relevant
        const baseContentType = contentType.split(';')[0].trim();
        const isRelevant = Array.from(relevantContentTypes).some(
          (ct) =>
            baseContentType.startsWith(ct) || ct.startsWith(baseContentType)
        );

        if (contentType && !isRelevant) {
          // Unknown content type, still track but log it
          this.logger.debug(
            `Tracking unknown content type: ${baseContentType}`
          );
        }

        // Check response size (if available)
        const contentLength =
          headers['content-length'] || headers['Content-Length'];
        if (contentLength && parseInt(contentLength, 10) > maxResponseSize) {
          this.logger.debug(
            `Skipping large response (${contentLength} bytes): ${request.url?.().substring?.(0, 50) ?? ''}`
          );
          pendingRequests.delete(request);
          return;
        }
      } catch (error) {
        // If header inspection fails, still process the response
        this.logger.debug(
          `Error inspecting response headers: ${(error as Error).message}`
        );
      }

      pendingRequests.delete(request);
      lastActivity = Date.now() / 1000;
    };

    const waitForIdle = async () => {
      const startTime = Date.now() / 1000;
      while (true) {
        this._throwIfAborted(signal);
        await this._waitWithAbort(100, signal);
        this._throwIfAborted(signal);
        const now = Date.now() / 1000;
        if (
          pendingRequests.size === 0 &&
          now - lastActivity >=
            (this.browser_profile.wait_for_network_idle_page_load_time ?? 0.5)
        ) {
          this.currentPageLoadingStatus = null;
          break;
        }
        if (
          now - startTime >
          (this.browser_profile.maximum_wait_page_load_time ?? 5)
        ) {
          this.currentPageLoadingStatus = `Page loading was aborted after ${this.browser_profile.maximum_wait_page_load_time ?? 5}s with ${pendingRequests.size} pending network requests. You may want to use the wait action to allow more time for the page to fully load.`;
          break;
        }
      }
    };

    if (typeof page?.on === 'function' && typeof page?.off === 'function') {
      page.on('request', onRequest);
      page.on('response', onResponse);
      try {
        await waitForIdle();
      } finally {
        page.off('request', onRequest);
        page.off('response', onResponse);
      }
    } else {
      this.currentPageLoadingStatus = null;
    }
  }

  private _setActivePage(page: Page | null) {
    const currentTab = this._tabs[this.currentTabIndex];
    if (currentTab) {
      this.tabPages.set(currentTab.page_id, page ?? null);
      this.session_manager.set_focused_target(currentTab.target_id ?? null);
    }
    this._attachDialogHandler(page);
    this.agent_current_page = page ?? null;
  }

  private async _syncCurrentTabFromPage(page: Page | null) {
    if (!page) {
      return;
    }

    let resolvedUrl: string | null = null;
    try {
      const rawUrl = page.url();
      if (typeof rawUrl === 'string' && rawUrl.trim()) {
        resolvedUrl = normalize_url(rawUrl);
        this.currentUrl = resolvedUrl;
      }
    } catch {
      // Ignore transient URL read failures.
    }

    let resolvedTitle: string | null = null;
    if (typeof page.title === 'function') {
      try {
        const title = await page.title();
        if (typeof title === 'string' && title.trim()) {
          resolvedTitle = title;
        }
      } catch {
        // Ignore transient title read failures.
      }
    }
    if (!resolvedTitle) {
      resolvedTitle = resolvedUrl ?? this.currentTitle ?? this.currentUrl;
    }
    this.currentTitle = resolvedTitle;

    const currentTab = this._tabs[this.currentTabIndex];
    if (currentTab) {
      if (resolvedUrl) {
        currentTab.url = resolvedUrl;
      }
      currentTab.title = resolvedTitle;
      this._syncSessionManagerFromTabs();
    }
  }

  private _syncTabsWithBrowserPages() {
    const pages = this.browser_context?.pages?.() ?? [];
    if (!pages.length) {
      return;
    }

    const nextTabs: TabInfo[] = [];
    const nextTabPages = new Map<number, Page | null>();
    const usedPageIds = new Set<number>();
    const knownPageMappings = Array.from(this.tabPages.entries());

    for (const page of pages) {
      this._attachDialogHandler(page ?? null);

      let pageId: number | null = null;
      for (const [candidateId, candidatePage] of knownPageMappings) {
        if (candidatePage === page && !usedPageIds.has(candidateId)) {
          pageId = candidateId;
          break;
        }
      }

      if (pageId === null) {
        pageId = this._tabCounter++;
      }
      usedPageIds.add(pageId);

      const existingTab = this._tabs.find((tab) => tab.page_id === pageId);
      const tab = existingTab
        ? { ...existingTab }
        : this._createTabInfo({
            page_id: pageId,
            url: 'about:blank',
            title: 'about:blank',
          });

      try {
        const rawUrl = page.url();
        if (typeof rawUrl === 'string' && rawUrl.trim()) {
          tab.url = normalize_url(rawUrl);
        }
      } catch {
        // Keep existing tab url when page url is not readable.
      }
      if (!existingTab || !tab.title || tab.title === 'about:blank') {
        tab.title = tab.url;
      }

      nextTabs.push(tab);
      nextTabPages.set(pageId, page);
    }

    if (!nextTabs.length) {
      return;
    }

    this._tabs = nextTabs;
    this.tabPages = nextTabPages;

    const activePage =
      this.agent_current_page && pages.includes(this.agent_current_page)
        ? this.agent_current_page
        : (pages[0] ?? null);
    if (activePage) {
      const activeIndex = this._tabs.findIndex(
        (tab) => this.tabPages.get(tab.page_id) === activePage
      );
      if (activeIndex !== -1) {
        this.currentTabIndex = activeIndex;
      }
    }

    if (this.currentTabIndex < 0 || this.currentTabIndex >= this._tabs.length) {
      this.currentTabIndex = Math.max(0, this._tabs.length - 1);
    }

    const activeTab = this._tabs[this.currentTabIndex] ?? null;
    if (activeTab) {
      this.currentUrl = activeTab.url;
      this.currentTitle = activeTab.title || activeTab.url;
      this.agent_current_page = this.tabPages.get(activeTab.page_id) ?? null;
      this.human_current_page =
        this.human_current_page ?? this.agent_current_page;
    }
    this._syncSessionManagerFromTabs();
  }

  private _captureClosedPopupMessage(dialogType: string, message: string) {
    const normalizedType = String(dialogType || 'alert').trim() || 'alert';
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      return;
    }

    const formatted = `[${normalizedType}] ${normalizedMessage}`;
    this._closedPopupMessages.push(formatted);
    if (this._closedPopupMessages.length > this._maxClosedPopupMessages) {
      this._closedPopupMessages.splice(
        0,
        this._closedPopupMessages.length - this._maxClosedPopupMessages
      );
    }
  }

  private _getClosedPopupMessagesSnapshot() {
    return [...this._closedPopupMessages];
  }

  private _recordRecentEvent(
    event_type: string,
    details: Partial<Omit<RecentBrowserEvent, 'event_type' | 'timestamp'>> = {}
  ) {
    const event: RecentBrowserEvent = {
      event_type: String(event_type || 'unknown').trim() || 'unknown',
      timestamp: new Date().toISOString(),
    };
    if (typeof details.url === 'string' && details.url.trim()) {
      event.url = details.url.trim();
    }
    if (
      typeof details.error_message === 'string' &&
      details.error_message.trim()
    ) {
      event.error_message = details.error_message.trim();
    }
    if (
      typeof details.page_id === 'number' &&
      Number.isFinite(details.page_id)
    ) {
      event.page_id = details.page_id;
    }
    if (typeof details.tab_id === 'string' && details.tab_id.trim()) {
      event.tab_id = details.tab_id.trim();
    }

    this._recentEvents.push(event);
    if (this._recentEvents.length > this._maxRecentEvents) {
      this._recentEvents.splice(
        0,
        this._recentEvents.length - this._maxRecentEvents
      );
    }
  }

  private _getRecentEventsSummary(limit = 10): string | null {
    if (!this._recentEvents.length || limit <= 0) {
      return null;
    }
    const events = this._recentEvents.slice(-limit);
    return JSON.stringify(events);
  }

  private _attachDialogHandler(page: Page | null) {
    if (!page || this._dialogHandlersAttached.has(page)) {
      return;
    }

    const pageWithEvents = page as unknown as {
      on?: (event: string, handler: (...args: any[]) => void) => void;
    };
    if (typeof pageWithEvents.on !== 'function') {
      return;
    }

    const handler = async (dialog: any) => {
      try {
        const dialogType =
          typeof dialog?.type === 'function' ? dialog.type() : 'alert';
        const message =
          typeof dialog?.message === 'function' ? dialog.message() : '';
        try {
          await this.event_bus.dispatch(
            new DialogOpenedEvent({
              dialog_type: dialogType,
              message: String(message ?? ''),
              url: this.currentUrl ?? 'about:blank',
              frame_id: null,
            })
          );
        } catch (error) {
          this.logger.debug(
            `Failed to dispatch DialogOpenedEvent: ${(error as Error).message}`
          );
        }
        this._captureClosedPopupMessage(dialogType, message);
        this._recordRecentEvent('javascript_dialog_closed', {
          url: this.currentUrl,
          error_message: message
            ? `[${dialogType}] ${String(message).trim()}`
            : `[${dialogType}]`,
        });

        const shouldAccept =
          dialogType === 'alert' ||
          dialogType === 'confirm' ||
          dialogType === 'beforeunload';
        if (shouldAccept && typeof dialog?.accept === 'function') {
          await dialog.accept();
        } else if (typeof dialog?.dismiss === 'function') {
          await dialog.dismiss();
        }
      } catch (error) {
        this.logger.debug(
          `Failed to auto-handle JavaScript dialog: ${(error as Error).message}`
        );
      }
    };

    pageWithEvents.on('dialog', handler);
    this._dialogHandlersAttached.add(page);
  }

  private async _getPendingNetworkRequests(
    page: Page | null
  ): Promise<NetworkRequest[]> {
    if (!page || typeof page.evaluate !== 'function') {
      return [];
    }

    try {
      const pending = await page.evaluate(() => {
        const perf = (window as any).performance;
        if (!perf?.getEntriesByType) {
          return [];
        }

        const entries = perf.getEntriesByType('resource');
        const now = perf.now?.() ?? Date.now();
        const blockedPatterns = [
          'doubleclick',
          'analytics',
          'tracking',
          'metrics',
          'telemetry',
          'facebook.net',
          'hotjar',
          'clarity',
          'mixpanel',
          'segment',
          '/beacon/',
          '/collector/',
          '/telemetry/',
        ];
        const pendingRequests: Array<{
          url: string;
          method: string;
          loading_duration_ms: number;
          resource_type: string | null;
        }> = [];

        for (const entry of entries) {
          const responseEnd =
            typeof (entry as any).responseEnd === 'number'
              ? (entry as any).responseEnd
              : 0;
          if (responseEnd !== 0) {
            continue;
          }

          const url = String((entry as any).name ?? '');
          if (!url || url.startsWith('data:') || url.length > 500) {
            continue;
          }
          const lower = url.toLowerCase();
          if (blockedPatterns.some((pattern) => lower.includes(pattern))) {
            continue;
          }

          const startTime =
            typeof (entry as any).startTime === 'number'
              ? (entry as any).startTime
              : now;
          const loadingDuration = Math.max(0, now - startTime);
          if (loadingDuration > 10000) {
            continue;
          }

          const resourceType = String(
            (entry as any).initiatorType ?? ''
          ).toLowerCase();
          if (
            (resourceType === 'img' ||
              resourceType === 'image' ||
              resourceType === 'font') &&
            loadingDuration > 3000
          ) {
            continue;
          }

          pendingRequests.push({
            url,
            method: 'GET',
            loading_duration_ms: Math.round(loadingDuration),
            resource_type: resourceType || null,
          });

          if (pendingRequests.length >= 20) {
            break;
          }
        }

        return pendingRequests;
      });

      return Array.isArray(pending)
        ? pending.map((entry) => ({
            url: String((entry as any).url ?? ''),
            method:
              typeof (entry as any).method === 'string'
                ? (entry as any).method
                : 'GET',
            loading_duration_ms:
              typeof (entry as any).loading_duration_ms === 'number'
                ? (entry as any).loading_duration_ms
                : 0,
            resource_type:
              typeof (entry as any).resource_type === 'string'
                ? (entry as any).resource_type
                : null,
          }))
        : [];
    } catch (error) {
      this.logger.debug(
        `Failed to gather pending network requests: ${(error as Error).message}`
      );
      return [];
    }
  }

  get tabs() {
    return this._tabs.slice();
  }

  get active_tab_index() {
    return this.currentTabIndex;
  }

  get active_tab() {
    return this._tabs[this.currentTabIndex] ?? null;
  }

  describe() {
    return this.toString();
  }

  get _owns_browser_resources(): boolean {
    return this.ownsBrowserResources;
  }

  get is_stopping(): boolean {
    return this._stoppingPromise !== null;
  }

  get is_reconnecting(): boolean {
    return this._reconnecting;
  }

  get should_gate_watchdog_events(): boolean {
    return Boolean(
      this.initialized ||
      this.browser ||
      this.browser_context ||
      this.cdp_url ||
      this.wss_url ||
      this._reconnecting
    );
  }

  get is_cdp_connected(): boolean {
    try {
      if (this.browser) {
        const browser = this.browser as BrowserEventEmitterLike;
        if (
          typeof browser.isConnected === 'function' &&
          !browser.isConnected()
        ) {
          return false;
        }
      }

      if (this.browser_context) {
        const contextBrowser = (this.browser_context as any).browser?.();
        if (
          contextBrowser &&
          typeof contextBrowser.isConnected === 'function' &&
          !contextBrowser.isConnected()
        ) {
          return false;
        }
        return true;
      }

      return Boolean(this.browser);
    } catch {
      return false;
    }
  }

  async wait_for_reconnect(
    timeoutSeconds: number = this.RECONNECT_WAIT_TIMEOUT
  ) {
    if (!this._reconnecting) {
      return;
    }

    const timeoutMs =
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : this.RECONNECT_WAIT_TIMEOUT * 1000;

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this._reconnectWaitPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Reconnection wait timed out after ${Math.round(timeoutMs / 1000)}s`
              )
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  claim_agent(
    agentId: string,
    mode: 'exclusive' | 'shared' = 'exclusive'
  ): boolean {
    if (!agentId) {
      return false;
    }

    if (mode === 'shared') {
      if (
        this.attachedAgentId &&
        this.attachedAgentId !== agentId &&
        this.attachedSharedAgentIds.size === 0
      ) {
        return false;
      }

      if (this.attachedSharedAgentIds.size === 0 && this.attachedAgentId) {
        this.attachedSharedAgentIds.add(this.attachedAgentId);
      }
      this.attachedSharedAgentIds.add(agentId);
      this.attachedAgentId = this.attachedAgentId ?? agentId;
      return true;
    }

    if (this.attachedSharedAgentIds.size > 0) {
      if (
        this.attachedSharedAgentIds.size === 1 &&
        this.attachedSharedAgentIds.has(agentId)
      ) {
        this.attachedSharedAgentIds.clear();
        this.attachedAgentId = agentId;
        return true;
      }
      return false;
    }

    if (this.attachedAgentId && this.attachedAgentId !== agentId) {
      return false;
    }
    this.attachedAgentId = agentId;
    return true;
  }

  claimAgent(
    agentId: string,
    mode: 'exclusive' | 'shared' = 'exclusive'
  ): boolean {
    return this.claim_agent(agentId, mode);
  }

  release_agent(agentId?: string): boolean {
    if (this.attachedSharedAgentIds.size > 0) {
      if (!agentId) {
        this.attachedSharedAgentIds.clear();
        this.attachedAgentId = null;
        return true;
      }

      if (!this.attachedSharedAgentIds.has(agentId)) {
        return false;
      }

      this.attachedSharedAgentIds.delete(agentId);
      if (this.attachedSharedAgentIds.size === 0) {
        this.attachedAgentId = null;
      } else if (this.attachedAgentId === agentId) {
        const [nextOwner] = this.attachedSharedAgentIds;
        this.attachedAgentId = nextOwner ?? null;
      }
      return true;
    }

    if (!this.attachedAgentId) {
      return true;
    }
    if (agentId && this.attachedAgentId !== agentId) {
      return false;
    }
    this.attachedAgentId = null;
    return true;
  }

  releaseAgent(agentId?: string): boolean {
    return this.release_agent(agentId);
  }

  get_attached_agent_id(): string | null {
    return this.attachedAgentId;
  }

  getAttachedAgentId(): string | null {
    return this.get_attached_agent_id();
  }

  get_attached_agent_ids(): string[] {
    if (this.attachedSharedAgentIds.size > 0) {
      return Array.from(this.attachedSharedAgentIds);
    }
    return this.attachedAgentId ? [this.attachedAgentId] : [];
  }

  getAttachedAgentIds(): string[] {
    return this.get_attached_agent_ids();
  }

  private _determineOwnership() {
    if (
      this.cdp_url ||
      this.wss_url ||
      this.browser ||
      this.browser_context ||
      this.browser_pid
    ) {
      return false;
    }
    return true;
  }

  private _createAbortError(reason?: unknown): Error {
    if (reason instanceof Error) {
      return reason;
    }
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    return error;
  }

  private _isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return (
      error.name === 'AbortError' ||
      /abort|aborted|interrupted/i.test(error.message)
    );
  }

  private _throwIfAborted(signal: AbortSignal | null = null) {
    if (signal?.aborted) {
      throw this._createAbortError(signal.reason);
    }
  }

  private async _waitWithAbort(
    timeoutMs: number,
    signal: AbortSignal | null = null
  ) {
    if (timeoutMs <= 0) {
      this._throwIfAborted(signal);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timeout);
        cleanup();
        reject(this._createAbortError(signal?.reason));
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private async _withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | null = null
  ): Promise<T> {
    if (!signal) {
      return promise;
    }
    this._throwIfAborted(signal);

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(this._createAbortError(signal.reason));
      };

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      promise
        .then((result) => {
          cleanup();
          resolve(result);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
    });
  }

  private _toPlaywrightOptions(value: unknown): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      const converted = value
        .map((item) => this._toPlaywrightOptions(item))
        .filter((item) => item !== undefined);
      return converted;
    }
    if (
      typeof value !== 'object' ||
      value instanceof Date ||
      Buffer.isBuffer(value)
    ) {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [rawKey, rawVal] of Object.entries(
      value as Record<string, unknown>
    )) {
      const convertedValue = this._toPlaywrightOptions(rawVal);
      if (convertedValue === undefined) {
        continue;
      }
      const normalizedKey =
        PLAYWRIGHT_OPTION_KEY_OVERRIDES[rawKey] ??
        rawKey.replace(/_([a-z])/g, (_, letter: string) =>
          letter.toUpperCase()
        );
      result[normalizedKey] = convertedValue;
    }
    return result;
  }

  async set_extra_headers(headers: Record<string, string>): Promise<void> {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers)
        .map(([key, value]) => [String(key).trim(), String(value)])
        .filter(([key]) => key.length > 0)
    );

    if (
      !this.browser_context ||
      Object.keys(normalizedHeaders).length === 0 ||
      typeof (this.browser_context as any).setExtraHTTPHeaders !== 'function'
    ) {
      return;
    }

    await (this.browser_context as any).setExtraHTTPHeaders(normalizedHeaders);
  }

  private async _applyConfiguredExtraHttpHeaders(): Promise<void> {
    const configuredHeaders = this.browser_profile.config.extra_http_headers;
    if (!configuredHeaders || Object.keys(configuredHeaders).length === 0) {
      return;
    }

    await this.set_extra_headers(configuredHeaders);
  }

  private _usesRemoteBrowserConnection() {
    return Boolean(this.cdp_url || this.wss_url);
  }

  private async _connectToConfiguredBrowser(playwright: any) {
    const connectOptions = this._toPlaywrightOptions(
      this.browser_profile.kwargs_for_connect()
    ) as Record<string, unknown> | undefined;

    if (this.cdp_url) {
      return await playwright.chromium.connectOverCDP(
        this.cdp_url,
        connectOptions ?? {}
      );
    }

    if (this.wss_url) {
      return await playwright.chromium.connect(
        this.wss_url,
        connectOptions ?? {}
      );
    }

    throw new Error(
      'Cannot connect to a remote browser without cdp_url or wss_url'
    );
  }

  private async _ensureBrowserContextFromBrowser(browser: Browser | null) {
    const existingContexts =
      (typeof browser?.contexts === 'function' ? browser.contexts() : []) ?? [];
    if (existingContexts.length > 0) {
      return existingContexts[0] ?? null;
    }
    if (typeof browser?.newContext === 'function') {
      const contextOptions = this._toPlaywrightOptions(
        this.browser_profile.kwargs_for_new_context()
      );
      return await browser.newContext(
        (contextOptions as Record<string, unknown>) ?? {}
      );
    }
    return null;
  }

  private _beginReconnectWait() {
    this._reconnectWaitPromise = new Promise<void>((resolve) => {
      this._resolveReconnectWait = resolve;
    });
  }

  private _endReconnectWait() {
    this._resolveReconnectWait?.();
    this._resolveReconnectWait = null;
    this._reconnectWaitPromise = Promise.resolve();
  }

  private _detachRemoteDisconnectHandler() {
    if (!this._disconnectAwareBrowser || !this._browserDisconnectHandler) {
      this._disconnectAwareBrowser = null;
      this._browserDisconnectHandler = null;
      return;
    }

    if (typeof this._disconnectAwareBrowser.off === 'function') {
      this._disconnectAwareBrowser.off(
        'disconnected',
        this._browserDisconnectHandler
      );
    } else if (
      typeof this._disconnectAwareBrowser.removeListener === 'function'
    ) {
      this._disconnectAwareBrowser.removeListener(
        'disconnected',
        this._browserDisconnectHandler
      );
    }

    this._disconnectAwareBrowser = null;
    this._browserDisconnectHandler = null;
  }

  private _attachRemoteDisconnectHandler(browser: Browser | null) {
    this._detachRemoteDisconnectHandler();

    if (!this._usesRemoteBrowserConnection()) {
      return;
    }

    const browserWithEvents = browser as BrowserEventEmitterLike | null;
    if (!browserWithEvents || typeof browserWithEvents.on !== 'function') {
      return;
    }

    const onDisconnected = () => {
      this._handleUnexpectedRemoteDisconnect();
    };

    browserWithEvents.on('disconnected', onDisconnected);
    this._disconnectAwareBrowser = browserWithEvents;
    this._browserDisconnectHandler = onDisconnected;
  }

  private _handleUnexpectedRemoteDisconnect() {
    if (
      this._intentionalStop ||
      this._reconnecting ||
      !this._usesRemoteBrowserConnection()
    ) {
      return;
    }

    this.logger.warning(
      'Remote browser connection closed unexpectedly; attempting to reconnect'
    );
    this._recordRecentEvent('browser_disconnected', {
      url: this.currentUrl,
    });

    const reconnectTask = this._auto_reconnect();
    this._reconnectTask = reconnectTask;
    void reconnectTask.finally(() => {
      if (this._reconnectTask === reconnectTask) {
        this._reconnectTask = null;
      }
    });
  }

  private async _restorePagesAfterReconnect(
    preferredUrl: string | null,
    preferredTabIndex: number
  ) {
    if (!this.browser_context) {
      this.agent_current_page = null;
      this.human_current_page = null;
      return;
    }

    let pages = this.browser_context.pages?.() ?? [];
    if (!pages.length && typeof this.browser_context.newPage === 'function') {
      const createdPage = await this.browser_context.newPage();
      if (createdPage) {
        pages = this.browser_context.pages?.() ?? [createdPage];
      }
    }

    this.tabPages = new Map();
    this.agent_current_page = null;
    this.human_current_page = null;
    this._syncTabsWithBrowserPages();

    if (!pages.length) {
      this.currentTabIndex = 0;
      this.currentUrl = normalize_url(preferredUrl ?? 'about:blank');
      this.currentTitle = this.currentUrl;
      if (!this._tabs.length) {
        this._tabs = [
          this._createTabInfo({
            page_id: this._tabCounter++,
            url: this.currentUrl,
            title: this.currentTitle,
          }),
        ];
      }
      this._syncSessionManagerFromTabs();
      return;
    }

    const normalizedPreferredUrl =
      typeof preferredUrl === 'string' && preferredUrl.trim().length > 0
        ? normalize_url(preferredUrl)
        : null;
    const pageByUrl =
      normalizedPreferredUrl == null
        ? null
        : (pages.find((page) => {
            try {
              return normalize_url(page.url()) === normalizedPreferredUrl;
            } catch {
              return false;
            }
          }) ?? null);
    const clampedIndex =
      preferredTabIndex >= 0 && preferredTabIndex < pages.length
        ? preferredTabIndex
        : 0;
    const nextPage = pageByUrl ?? pages[clampedIndex] ?? pages[0] ?? null;
    const nextTabIndex = nextPage
      ? this._tabs.findIndex(
          (tab) => this.tabPages.get(tab.page_id) === nextPage
        )
      : -1;

    if (nextTabIndex >= 0) {
      this.currentTabIndex = nextTabIndex;
    }

    this._setActivePage(nextPage);
    this.human_current_page = nextPage;
    await this._syncCurrentTabFromPage(nextPage);
  }

  async reconnect(
    options: {
      preferred_url?: string | null;
      preferred_tab_index?: number;
    } = {}
  ): Promise<void> {
    if (!this._usesRemoteBrowserConnection()) {
      throw new Error('Cannot reconnect without a remote browser connection');
    }

    const preferredUrl =
      typeof options.preferred_url === 'string'
        ? options.preferred_url
        : this.currentUrl;
    const preferredTabIndex =
      typeof options.preferred_tab_index === 'number'
        ? options.preferred_tab_index
        : this.currentTabIndex;

    this._detachRemoteDisconnectHandler();
    this.cachedBrowserState = null;
    this.currentPageLoadingStatus = null;
    this.browser = null;
    this.browser_context = null;
    this.agent_current_page = null;
    this.human_current_page = null;
    this._dialogHandlersAttached = new WeakSet<Page>();
    this.session_manager.clear();

    const playwright = (this.playwright as any) ?? (await async_playwright());
    this.playwright = playwright;
    this.browser = await this._connectToConfiguredBrowser(playwright);
    this.ownsBrowserResources = false;
    this.browser_context = await this._ensureBrowserContextFromBrowser(
      this.browser
    );

    await this._applyConfiguredExtraHttpHeaders();
    await this._restorePagesAfterReconnect(preferredUrl, preferredTabIndex);
    this._attachRemoteDisconnectHandler(this.browser);
    this.initialized = true;
    this._recordRecentEvent('browser_reconnected', {
      url: this.currentUrl,
    });
  }

  private async _auto_reconnect(maxAttempts: number = 3) {
    if (this._reconnecting || !this._usesRemoteBrowserConnection()) {
      return;
    }

    this._reconnecting = true;
    this._beginReconnectWait();
    const startTime = Date.now();
    const preferredUrl = this.currentUrl;
    const preferredTabIndex = this.currentTabIndex;

    try {
      await this.event_bus.dispatch(
        new BrowserStoppedEvent({
          reason: 'connection_lost',
        })
      );

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this._intentionalStop) {
          return;
        }

        await this.event_bus.dispatch(
          new BrowserReconnectingEvent({
            cdp_url: this.cdp_url ?? this.wss_url ?? 'remote',
            attempt,
            max_attempts: maxAttempts,
          })
        );

        try {
          await Promise.race([
            this.reconnect({
              preferred_url: preferredUrl,
              preferred_tab_index: preferredTabIndex,
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(
                  new Error(
                    `Reconnect attempt timed out after ${Math.round(
                      REMOTE_RECONNECT_ATTEMPT_TIMEOUT_MS / 1000
                    )}s`
                  )
                );
              }, REMOTE_RECONNECT_ATTEMPT_TIMEOUT_MS);
            }),
          ]);

          if (this._intentionalStop) {
            return;
          }

          await this.event_bus.dispatch(
            new BrowserConnectedEvent({
              cdp_url: this.cdp_url ?? this.wss_url ?? 'remote',
            })
          );
          await this.event_bus.dispatch(
            new BrowserReconnectedEvent({
              cdp_url: this.cdp_url ?? this.wss_url ?? 'remote',
              attempt,
              downtime_seconds: (Date.now() - startTime) / 1000,
            })
          );
          return;
        } catch (error) {
          this.logger.warning(
            `Reconnect attempt ${attempt}/${maxAttempts} failed: ${(error as Error).message}`
          );
          if (attempt >= maxAttempts) {
            break;
          }

          const delayMs =
            REMOTE_RECONNECT_DELAYS_MS[attempt - 1] ??
            REMOTE_RECONNECT_DELAYS_MS[REMOTE_RECONNECT_DELAYS_MS.length - 1];
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'ReconnectionFailed',
          message: `Failed to reconnect after ${maxAttempts} attempts (${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
          details: {
            cdp_url: this.cdp_url ?? this.wss_url ?? 'remote',
            max_attempts: maxAttempts,
          },
        })
      );
    } finally {
      this._reconnecting = false;
      this._endReconnectWait();
    }
  }

  private _isSandboxLaunchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      /no usable sandbox/i.test(message) ||
      /chromium sandboxing failed/i.test(message) ||
      /zygote_host_impl_linux\.cc/i.test(message)
    );
  }

  private _createNoSandboxLaunchOptions(
    launchOptions: Record<string, unknown>
  ): Record<string, unknown> {
    const rawArgs = Array.isArray(launchOptions.args)
      ? launchOptions.args.filter(
          (arg): arg is string => typeof arg === 'string'
        )
      : [];
    const mergedArgs = [...rawArgs];
    for (const arg of CHROME_DOCKER_ARGS) {
      if (!mergedArgs.includes(arg)) {
        mergedArgs.push(arg);
      }
    }

    return {
      ...launchOptions,
      chromiumSandbox: false,
      args: mergedArgs,
    };
  }

  private async _launchChromiumWithSandboxFallback(
    playwright: any,
    launchOptions: Record<string, unknown>
  ): Promise<Browser> {
    try {
      return await playwright.chromium.launch(launchOptions);
    } catch (error) {
      const sandboxEnabled = this.browser_profile.config.chromium_sandbox;
      if (!sandboxEnabled || !this._isSandboxLaunchError(error)) {
        throw error;
      }

      this.logger.warning(
        'Chromium sandbox is unavailable in this environment. Retrying launch with chromium_sandbox=false (--no-sandbox).'
      );
      const fallbackOptions = this._createNoSandboxLaunchOptions(launchOptions);
      return await playwright.chromium.launch(fallbackOptions);
    }
  }

  private _connectionDescriptor() {
    const source =
      this.cdp_url ||
      this.wss_url ||
      (this.browser_pid ? String(this.browser_pid) : 'playwright');
    const tail = source.split('/').pop() ?? source;
    const port = tail.includes(':') ? tail.split(':').pop() : tail;
    return `${this.id.slice(-4)}:${port}`;
  }

  toString() {
    const ownershipFlag = this.ownsBrowserResources ? '#' : '©';
    return `BrowserSession🆂 ${this._connectionDescriptor()} ${ownershipFlag}${String(this.id).slice(-2)}`;
  }

  get logger() {
    if (!this._logger) {
      this._logger = createLogger(
        `browser_use.browser.session.${this.id.slice(-4)}`
      );
    }
    return this._logger;
  }

  async start() {
    this.attach_default_watchdogs();
    this._intentionalStop = false;

    if (this.initialized) {
      return this;
    }

    await this.event_bus.dispatch(
      new BrowserStartEvent({
        cdp_url: this.cdp_url,
      })
    );

    const ensurePage = async () => {
      const current = this.agent_current_page;
      if (current && !(current as any).isClosed?.()) {
        this._setActivePage(current);
        return;
      }

      const existingPages =
        (typeof this.browser_context?.pages === 'function'
          ? this.browser_context.pages()
          : []) ?? [];
      const firstOpenPage =
        existingPages.find((page) => !(page as any).isClosed?.()) ?? null;

      if (firstOpenPage) {
        this._setActivePage(firstOpenPage);
        return;
      }

      if (typeof this.browser_context?.newPage === 'function') {
        const created = await this.browser_context.newPage();
        this._setActivePage(created ?? null);
        return;
      }

      this._setActivePage(null);
    };

    if (!this.browser_context) {
      if (!this.browser) {
        const playwright =
          (this.playwright as any) ?? (await async_playwright());
        this.playwright = playwright;

        if (this.cdp_url) {
          this.browser = await this._connectToConfiguredBrowser(playwright);
          this.ownsBrowserResources = false;
        } else if (this.wss_url) {
          this.browser = await this._connectToConfiguredBrowser(playwright);
          this.ownsBrowserResources = false;
        } else {
          const launchOptions = this._toPlaywrightOptions(
            await this.browser_profile.kwargs_for_launch()
          );
          this.browser = await this._launchChromiumWithSandboxFallback(
            playwright,
            (launchOptions as Record<string, unknown>) ?? {}
          );
          this.ownsBrowserResources = true;

          const processGetter = (this.browser as any)?.process;
          if (typeof processGetter === 'function') {
            const processRef = processGetter.call(this.browser) as
              | { pid?: number }
              | undefined;
            if (typeof processRef?.pid === 'number') {
              this.browser_pid = processRef.pid;
            }
          }
        }
      }

      const existingContexts =
        (typeof this.browser?.contexts === 'function'
          ? this.browser.contexts()
          : []) ?? [];
      if (existingContexts.length > 0) {
        this.browser_context = existingContexts[0] ?? null;
      } else {
        this.browser_context = await this._ensureBrowserContextFromBrowser(
          this.browser
        );
      }
    }

    await this._applyConfiguredExtraHttpHeaders();
    await ensurePage();
    if (
      !this.human_current_page ||
      (this.human_current_page as any).isClosed?.()
    ) {
      this.human_current_page = this.agent_current_page;
    }

    const activePage = await this.get_current_page();
    if (activePage) {
      try {
        this.currentUrl = normalize_url(activePage.url());
      } catch {
        // Ignore url read errors from transient pages.
      }
      if (typeof activePage.title === 'function') {
        try {
          this.currentTitle = await activePage.title();
        } catch {
          // Ignore title read errors from transient pages.
        }
      }
    }

    this.initialized = true;
    this._recordRecentEvent('browser_started', { url: this.currentUrl });
    this.logger.debug(
      `Started ${this.describe()} with profile ${this.browser_profile.toString()}`
    );
    this._attachRemoteDisconnectHandler(this.browser);
    await this.event_bus.dispatch(
      new BrowserConnectedEvent({
        cdp_url: this.cdp_url ?? this.wss_url ?? 'playwright',
      })
    );
    return this;
  }

  /**
   * Setup browser session by connecting to an existing browser process via PID
   * Useful for debugging or connecting to manually launched browsers
   * @param browserPid - Process ID of the browser to connect to
   * @param cdpUrl - Optional CDP URL (will be discovered if not provided)
   */
  async setupBrowserViaBrowserPid(
    browserPid: number,
    cdpUrl?: string
  ): Promise<void> {
    this.logger.info(`Connecting to existing browser with PID ${browserPid}`);

    this.browser_pid = browserPid;

    // If CDP URL not provided, try to discover it
    if (!cdpUrl) {
      cdpUrl = (await this._discoverCdpUrl(browserPid)) ?? undefined;
    }

    if (!cdpUrl) {
      throw new Error(
        `Could not discover CDP URL for browser PID ${browserPid}`
      );
    }

    this.cdp_url = cdpUrl;
    this.logger.info(`Discovered CDP URL: ${cdpUrl}`);

    // Connect to browser via CDP
    try {
      const playwright = await import('playwright');
      const browser = await this._connectToConfiguredBrowser(playwright);

      this.browser = browser as any;
      this.playwright = playwright;

      // Get or create context
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        this.browser_context = contexts[0] as any;
      } else {
        this.browser_context = (await browser.newContext()) as any;
      }

      await this._applyConfiguredExtraHttpHeaders();

      // Get or create page
      if (!this.browser_context) {
        throw new Error('Browser context not available');
      }
      const pages = this.browser_context.pages();
      if (pages.length > 0) {
        this.agent_current_page = pages[0] as any;
        this.human_current_page = pages[0] as any;
      } else {
        const page = await this.browser_context.newPage();
        this.agent_current_page = page as any;
        this.human_current_page = page as any;
      }

      // We don't own this browser since we're connecting to existing one
      this.ownsBrowserResources = false;
      this._attachRemoteDisconnectHandler(this.browser);

      this.initialized = true;
      this.logger.info(`Successfully connected to browser PID ${browserPid}`);
    } catch (error) {
      throw new Error(
        `Failed to connect to browser PID ${browserPid}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  /**
   * Discover CDP URL from browser PID
   * Tries common ports and checks for debugging endpoints
   */
  private async _discoverCdpUrl(browserPid: number): Promise<string | null> {
    const commonPorts = [9222, 9223, 9224, 9225];

    for (const port of commonPorts) {
      try {
        const response = await fetch(`http://localhost:${port}/json/version`);
        if (response.ok) {
          const data = await response.json();
          if (data.webSocketDebuggerUrl) {
            this.logger.debug(`Found CDP endpoint on port ${port}`);
            return data.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Port not accessible, try next
        continue;
      }
    }

    this.logger.warning(
      `Could not discover CDP URL for PID ${browserPid} on common ports`
    );
    return null;
  }

  private async _shutdown_browser_session() {
    this.initialized = false;
    this._intentionalStop = true;
    this._reconnecting = false;
    this._endReconnectWait();
    this._reconnectTask = null;
    this._detachRemoteDisconnectHandler();
    this.attachedAgentId = null;
    this.attachedSharedAgentIds.clear();

    const closeWithTimeout = async (
      label: string,
      operation: Promise<unknown>,
      timeoutMs = 3000
    ) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      try {
        await Promise.race([operation, timeoutPromise]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    };

    if (this.ownsBrowserResources) {
      if (typeof this.browser_context?.close === 'function') {
        try {
          await closeWithTimeout(
            'Closing browser context',
            this.browser_context.close()
          );
        } catch (error) {
          this.logger.debug(
            `Failed to close browser context: ${(error as Error).message}`
          );
        }
      }

      if (typeof this.browser?.close === 'function') {
        try {
          await closeWithTimeout(
            'Closing browser instance',
            this.browser.close()
          );
        } catch (error) {
          this.logger.debug(
            `Failed to close browser instance: ${(error as Error).message}`
          );
        }
      }
    }

    // Kill child processes first
    await this._killChildProcesses();

    // If we own the browser resources, terminate the browser process
    if (this.ownsBrowserResources && this.browser_pid) {
      await this._terminateBrowserProcess();
    }

    this.browser = null;
    this.browser_context = null;
    this.agent_current_page = null;
    this.human_current_page = null;
    this.browser_pid = null;
    this.cdp_url = null;
    this.wss_url = null;
    this.playwright = null;
    this.cachedBrowserState = null;
    this._tabs = [];
    this.session_manager.clear();
    this.downloaded_files = [];
    this._closedPopupMessages = [];
    this._dialogHandlersAttached = new WeakSet<Page>();
    this._recentEvents = [];
  }

  async close() {
    await this.stop();
  }

  async get_browser_state_with_recovery(options: BrowserStateOptions = {}) {
    const signal = options.signal ?? null;
    const includeRecentEvents = options.include_recent_events ?? false;
    this._throwIfAborted(signal);

    if (!this.initialized) {
      await this._withAbort(this.start(), signal);
    }
    const page = await this._withAbort(this.get_current_page(), signal);
    this._throwIfAborted(signal);
    this.cachedBrowserState = null;
    let domState: DOMState;

    if (!page) {
      domState = createEmptyDomState();
    } else {
      try {
        const domService = new DomService(page, this.logger);
        domState = await this._withAbort(
          domService.get_clickable_elements(
            this.browser_profile.highlight_elements,
            -1,
            this.browser_profile.viewport_expansion
          ),
          signal
        );
      } catch (error) {
        if (this._isAbortError(error)) {
          throw error;
        }
        this.logger.debug(
          `Failed to build DOM tree: ${(error as Error).message}`
        );
        domState = createEmptyDomState();
      }

      const liveUrl =
        typeof page.url === 'function'
          ? normalize_url(page.url())
          : this.currentUrl;
      const shouldRetryEmptyDom =
        Object.keys(domState.selector_map).length === 0 &&
        !this._is_new_tab_page(liveUrl) &&
        !liveUrl.toLowerCase().endsWith('.pdf');

      if (shouldRetryEmptyDom) {
        this.logger.debug(`Empty DOM detected for ${liveUrl}; retrying once`);
        await this._waitWithAbort(EMPTY_DOM_RETRY_DELAY_MS, signal);

        try {
          const retryDomService = new DomService(page, this.logger);
          const retriedDomState = await this._withAbort(
            retryDomService.get_clickable_elements(
              this.browser_profile.highlight_elements,
              -1,
              this.browser_profile.viewport_expansion
            ),
            signal
          );
          if (Object.keys(retriedDomState.selector_map).length > 0) {
            domState = retriedDomState;
          }
        } catch (error) {
          if (this._isAbortError(error)) {
            throw error;
          }
          this.logger.debug(
            `Retry after empty DOM failed: ${(error as Error).message}`
          );
        }
      }
    }

    let screenshot: string | null = null;
    if (options.include_screenshot && page?.screenshot) {
      try {
        const image = await this._withAbort(
          page.screenshot({
            type: 'png',
            fullPage: true,
          }),
          signal
        );
        screenshot =
          typeof image === 'string'
            ? image
            : Buffer.from(image).toString('base64');
      } catch (error) {
        if (this._isAbortError(error)) {
          throw error;
        }
        this.logger.debug(
          `Failed to capture screenshot: ${(error as Error).message}`
        );
      }
    }

    let pageInfo = null;
    let pixelsAbove = 0;
    let pixelsBelow = 0;
    if (page) {
      try {
        const metrics = await this._withAbort(
          page.evaluate(() => {
            const doc = document.documentElement;
            const body = document.body;
            const width = Math.max(
              doc?.scrollWidth ?? 0,
              body?.scrollWidth ?? 0,
              doc?.clientWidth ?? 0
            );
            const height = Math.max(
              doc?.scrollHeight ?? 0,
              body?.scrollHeight ?? 0,
              doc?.clientHeight ?? 0
            );
            return {
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              pageWidth: width,
              pageHeight: height,
            };
          }),
          signal
        );
        pixelsAbove = Math.max(metrics.scrollY ?? 0, 0);
        const viewportHeight = metrics.viewportHeight ?? 0;
        const viewportWidth = metrics.viewportWidth ?? 0;
        pixelsBelow = Math.max(
          (metrics.pageHeight ?? 0) - (metrics.scrollY + viewportHeight),
          0
        );
        const pixelsLeft = Math.max(metrics.scrollX ?? 0, 0);
        const pixelsRight = Math.max(
          (metrics.pageWidth ?? 0) - (metrics.scrollX + viewportWidth),
          0
        );
        pageInfo = {
          viewport_width: viewportWidth,
          viewport_height: viewportHeight,
          page_width: metrics.pageWidth ?? viewportWidth,
          page_height: metrics.pageHeight ?? viewportHeight,
          scroll_x: metrics.scrollX ?? 0,
          scroll_y: metrics.scrollY ?? 0,
          pixels_above: pixelsAbove,
          pixels_below: pixelsBelow,
          pixels_left: pixelsLeft,
          pixels_right: pixelsRight,
        };
      } catch (error) {
        if (this._isAbortError(error)) {
          throw error;
        }
        this.logger.debug(
          `Failed to compute page metrics: ${(error as Error).message}`
        );
      }
    }

    const pendingNetworkRequests = await this._getPendingNetworkRequests(page);
    if (page) {
      await this._syncCurrentTabFromPage(page);
    }
    if (
      pageInfo &&
      Number.isFinite(pageInfo.viewport_width) &&
      Number.isFinite(pageInfo.viewport_height)
    ) {
      this._original_viewport_size = [
        Math.floor(pageInfo.viewport_width),
        Math.floor(pageInfo.viewport_height),
      ];
    }
    const paginationButtons = DomService.detect_pagination_buttons(
      domState.selector_map
    );
    const summary = new BrowserStateSummary(domState, {
      url: this.currentUrl,
      title: this.currentTitle || this.currentUrl,
      tabs: this._buildTabs(),
      screenshot,
      page_info: pageInfo,
      pixels_above: pixelsAbove,
      pixels_below: pixelsBelow,
      browser_errors: this.currentPageLoadingStatus
        ? [this.currentPageLoadingStatus]
        : [],
      is_pdf_viewer: Boolean(this.currentUrl?.toLowerCase().endsWith('.pdf')),
      loading_status: this.currentPageLoadingStatus,
      recent_events: includeRecentEvents
        ? this._getRecentEventsSummary()
        : null,
      pending_network_requests: pendingNetworkRequests,
      pagination_buttons: paginationButtons,
      closed_popup_messages: this._getClosedPopupMessagesSnapshot(),
    });

    // Implement clickable element hash caching to detect new elements
    if (options.cache_clickable_elements_hashes && page) {
      const currentUrl = page.url();
      const currentHashes = this._computeElementHashes(domState.selector_map);

      // Mark new elements if we have cached hashes for this URL
      if (
        this._cachedClickableElementHashes &&
        this._cachedClickableElementHashes.url === currentUrl
      ) {
        this._markNewElements(
          domState.selector_map,
          this._cachedClickableElementHashes.hashes
        );
      }

      // Update cache with current hashes
      this._cachedClickableElementHashes = {
        url: currentUrl,
        hashes: currentHashes,
      };
    }

    this._throwIfAborted(signal);
    this.cachedBrowserState = summary;
    return summary;
  }

  async get_current_page() {
    this._syncTabsWithBrowserPages();
    if (this.agent_current_page) {
      return this.agent_current_page;
    }
    const currentTab = this._tabs[this.currentTabIndex];
    if (currentTab) {
      const tabPage = this.tabPages.get(currentTab.page_id) ?? null;
      if (tabPage) {
        this._setActivePage(tabPage);
        return tabPage;
      }
    }
    const fallback = this.browser_context?.pages()?.[0] ?? null;
    this._setActivePage(fallback ?? null);
    return fallback;
  }

  update_current_page(
    page: Page | null,
    title?: string | null,
    url?: string | null
  ) {
    this._setActivePage(page);
    this.human_current_page = this.human_current_page ?? page;
    if (url) {
      this.currentUrl = normalize_url(url);
    }
    if (title) {
      this.currentTitle = title;
    }
  }

  private _buildTabs(): TabInfo[] {
    if (!this._tabs.length) {
      const pageId = this._tabCounter++;
      this._tabs.push(
        this._createTabInfo({
          page_id: pageId,
          url: this.currentUrl,
          title: this.currentTitle || this.currentUrl,
        })
      );
    } else {
      const tab = this._tabs[this.currentTabIndex];
      if (tab && !tab.tab_id) {
        tab.tab_id = this._formatTabId(tab.page_id);
      }
      tab.url = this.currentUrl;
      tab.title = this.currentTitle || this.currentUrl;
    }
    this._syncSessionManagerFromTabs();
    return this._tabs.slice();
  }

  async navigate_to(url: string, options: BrowserNavigationOptions = {}) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    this._assert_url_allowed(url);
    const normalized = normalize_url(url);
    let completedUrl = normalized;
    const waitUntil = options.wait_until ?? 'domcontentloaded';
    const timeoutMs =
      typeof options.timeout_ms === 'number' &&
      Number.isFinite(options.timeout_ms)
        ? Math.max(0, options.timeout_ms)
        : null;
    this._recordRecentEvent('navigation_started', { url: normalized });
    const page = await this._withAbort(this.get_current_page(), signal);
    if (page?.goto) {
      try {
        this.currentPageLoadingStatus = null;
        const gotoOptions: Record<string, unknown> = {
          waitUntil,
        };
        if (timeoutMs !== null) {
          gotoOptions.timeout = timeoutMs;
        }
        await this._withAbort(
          page.goto(normalized, gotoOptions as any),
          signal
        );
        const finalUrl = page.url();
        this._assert_url_allowed(finalUrl);
        completedUrl = normalize_url(finalUrl);
        await this._waitForStableNetwork(page, signal);
      } catch (error) {
        if (this._isAbortError(error)) {
          throw error;
        }
        const message = (error as Error).message ?? 'Navigation failed';
        this._recordRecentEvent('navigation_failed', {
          url: normalized,
          error_message: message,
        });
        throw new BrowserError(message);
      }
    }
    this._throwIfAborted(signal);
    if (page) {
      await this._syncCurrentTabFromPage(page);
      completedUrl = this.currentUrl || completedUrl;
    } else {
      this.currentUrl = normalized;
      this.currentTitle = normalized;
      if (this._tabs[this.currentTabIndex]) {
        this._tabs[this.currentTabIndex].url = normalized;
        this._tabs[this.currentTabIndex].title = normalized;
      }
      this._syncSessionManagerFromTabs();
    }

    if (this.historyStack[this.historyStack.length - 1] !== completedUrl) {
      this.historyStack.push(completedUrl);
    }
    this._setActivePage(page ?? null);
    this._recordRecentEvent('navigation_completed', { url: completedUrl });
    this.cachedBrowserState = null;
    return this.agent_current_page;
  }

  async create_new_tab(url: string, options: BrowserNavigationOptions = {}) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    this._assert_url_allowed(url);
    const normalized = normalize_url(url);
    let completedUrl = normalized;
    const waitUntil = options.wait_until ?? 'domcontentloaded';
    const timeoutMs =
      typeof options.timeout_ms === 'number' &&
      Number.isFinite(options.timeout_ms)
        ? Math.max(0, options.timeout_ms)
        : null;
    const previousTabIndex = this.currentTabIndex;
    const previousTab = this._tabs[this.currentTabIndex] ?? null;
    const newTab: TabInfo = this._createTabInfo({
      page_id: this._tabCounter++,
      url: normalized,
      title: normalized,
    });
    this._tabs.push(newTab);
    this.currentTabIndex = this._tabs.length - 1;
    this.currentUrl = normalized;
    this.currentTitle = normalized;
    this.historyStack.push(normalized);
    let page: Page | null = null;
    try {
      page =
        (await this._withAbort(
          this.browser_context?.newPage?.() ?? Promise.resolve(null),
          signal
        )) ?? null;
      if (page) {
        this.currentPageLoadingStatus = null;
        const gotoOptions: Record<string, unknown> = {
          waitUntil,
        };
        if (timeoutMs !== null) {
          gotoOptions.timeout = timeoutMs;
        }
        await this._withAbort(
          page.goto(normalized, gotoOptions as any),
          signal
        );
        const finalUrl = page.url();
        this._assert_url_allowed(finalUrl);
        completedUrl = normalize_url(finalUrl);
        await this._waitForStableNetwork(page, signal);
      }
    } catch (error) {
      if (this._isAbortError(error)) {
        throw error;
      }
      const message = (error as Error).message ?? 'Failed to open new tab';
      this._recordRecentEvent('tab_navigation_failed', {
        url: normalized,
        page_id: newTab.page_id,
        tab_id: newTab.tab_id,
        error_message: message,
      });
      this.logger.debug(`Failed to open new tab via Playwright: ${message}`);
      if (page?.close) {
        try {
          await page.close();
        } catch {
          // Ignore best-effort tab close failures during rollback.
        }
      }

      this._tabs = this._tabs.filter((tab) => tab.page_id !== newTab.page_id);
      this.tabPages.delete(newTab.page_id);
      if (this.historyStack[this.historyStack.length - 1] === normalized) {
        this.historyStack.pop();
      }

      if (this._tabs.length > 0) {
        let restoredIndex = previousTab
          ? this._tabs.findIndex((tab) => tab.page_id === previousTab.page_id)
          : -1;
        if (restoredIndex === -1) {
          restoredIndex = Math.min(previousTabIndex, this._tabs.length - 1);
        }
        this.currentTabIndex = Math.max(0, restoredIndex);
        const restoredTab = this._tabs[this.currentTabIndex];
        this.currentUrl = restoredTab.url;
        this.currentTitle = restoredTab.title;
        const restoredPage = this.tabPages.get(restoredTab.page_id) ?? null;
        this._setActivePage(restoredPage);
        await this._syncCurrentTabFromPage(restoredPage);
      } else {
        this.currentTabIndex = 0;
        this.currentUrl = 'about:blank';
        this.currentTitle = 'about:blank';
        this._setActivePage(null);
      }
      this._syncSessionManagerFromTabs();
      this.cachedBrowserState = null;
      throw new BrowserError(message);
    }
    this.tabPages.set(newTab.page_id, page);
    this._syncSessionManagerFromTabs();
    this._setActivePage(page);
    if (page) {
      await this._syncCurrentTabFromPage(page);
      completedUrl = this.currentUrl || completedUrl;
    }
    if (this.historyStack[this.historyStack.length - 1] === normalized) {
      this.historyStack[this.historyStack.length - 1] = completedUrl;
    } else if (
      this.historyStack[this.historyStack.length - 1] !== completedUrl
    ) {
      this.historyStack.push(completedUrl);
    }
    this.currentPageLoadingStatus = null;
    if (!this.human_current_page) {
      this.human_current_page = page;
    }
    this._recordRecentEvent('tab_created', {
      url: completedUrl,
      page_id: newTab.page_id,
      tab_id: newTab.tab_id,
    });
    this._recordRecentEvent('tab_ready', {
      url: completedUrl,
      page_id: newTab.page_id,
      tab_id: newTab.tab_id,
    });
    await this.event_bus.dispatch(
      new TabCreatedEvent({
        target_id: newTab.target_id ?? newTab.tab_id ?? 'unknown_target',
        url: completedUrl,
      })
    );
    this.cachedBrowserState = null;
    return this.agent_current_page;
  }

  private _resolveTabIndex(identifier: number | string): number {
    if (typeof identifier === 'string') {
      const normalized = identifier.trim();
      if (!normalized) {
        return -1;
      }
      if (normalized === '-1') {
        return Math.max(0, this._tabs.length - 1);
      }
      const byTabId = this._tabs.findIndex((tab) => tab.tab_id === normalized);
      if (byTabId !== -1) {
        return byTabId;
      }
      const byTargetId = this._tabs.findIndex(
        (tab) => tab.target_id === normalized
      );
      if (byTargetId !== -1) {
        return byTargetId;
      }
      const numeric = Number.parseInt(normalized, 10);
      if (Number.isFinite(numeric)) {
        return this._resolveTabIndex(numeric);
      }
      return -1;
    }

    if (identifier === -1) {
      return Math.max(0, this._tabs.length - 1);
    }
    const byId = this._tabs.findIndex((tab) => tab.page_id === identifier);
    if (byId !== -1) {
      return byId;
    }
    if (identifier >= 0 && identifier < this._tabs.length) {
      return identifier;
    }
    return -1;
  }

  async switch_to_tab(
    identifier: number | string,
    options: BrowserActionOptions = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    this._syncTabsWithBrowserPages();
    const index = this._resolveTabIndex(identifier);
    const tab = index >= 0 ? (this._tabs[index] ?? null) : null;
    if (!tab) {
      throw new Error(`Tab '${identifier}' does not exist`);
    }
    if (!tab.tab_id) {
      tab.tab_id = this._formatTabId(tab.page_id);
    }
    this.currentTabIndex = index;
    this.currentUrl = tab.url;
    this.currentTitle = tab.title;
    this._syncSessionManagerFromTabs();
    const page = this.tabPages.get(tab.page_id) ?? null;
    this._setActivePage(page);
    if (page?.bringToFront) {
      try {
        await this._withAbort(page.bringToFront(), signal);
      } catch (error) {
        if (this._isAbortError(error)) {
          throw error;
        }
        this.logger.debug(`Failed to focus tab: ${(error as Error).message}`);
      }
    }
    await this._waitForLoad(page, 5000, signal);
    this._recordRecentEvent('tab_switched', {
      url: tab.url,
      page_id: tab.page_id,
      tab_id: tab.tab_id,
    });
    await this.event_bus.dispatch(
      new AgentFocusChangedEvent({
        target_id: tab.target_id ?? tab.tab_id,
        url: tab.url,
      })
    );
    this.cachedBrowserState = null;
    return page;
  }

  async close_tab(identifier: number | string) {
    this._syncTabsWithBrowserPages();
    const index = this._resolveTabIndex(identifier);
    if (index < 0 || index >= this._tabs.length) {
      throw new Error(`Tab '${identifier}' does not exist`);
    }
    const closingTab = this._tabs[index];
    if (!closingTab.tab_id) {
      closingTab.tab_id = this._formatTabId(closingTab.page_id);
    }
    const closingPage = this.tabPages.get(closingTab.page_id) ?? null;
    if (closingPage?.close) {
      try {
        await closingPage.close();
      } catch (error) {
        this.logger.debug(`Failed to close page: ${(error as Error).message}`);
      }
    }
    this.tabPages.delete(closingTab.page_id);
    this._recordRecentEvent('tab_closed', {
      url: closingTab.url,
      page_id: closingTab.page_id,
      tab_id: closingTab.tab_id,
    });
    this._tabs.splice(index, 1);
    if (this.currentTabIndex >= this._tabs.length) {
      this.currentTabIndex = Math.max(0, this._tabs.length - 1);
    }
    this._syncSessionManagerFromTabs();
    const tab = this._tabs[this.currentTabIndex] ?? null;
    const current = tab ? (this.tabPages.get(tab.page_id) ?? null) : null;
    this._setActivePage(current);
    this.currentPageLoadingStatus = null;
    this.cachedBrowserState = null;
    if (this._tabs.length) {
      const tab = this._tabs[this.currentTabIndex];
      this.currentUrl = tab.url;
      this.currentTitle = tab.title;
      await this.event_bus.dispatch(
        new AgentFocusChangedEvent({
          target_id: tab.target_id ?? tab.tab_id ?? 'unknown_target',
          url: tab.url,
        })
      );
    } else {
      this.currentUrl = 'about:blank';
      this.currentTitle = 'about:blank';
      this._setActivePage(null);
    }
    await this.event_bus.dispatch(
      new TabClosedEvent({
        target_id: closingTab.target_id ?? closingTab.tab_id,
      })
    );
  }

  async wait(seconds: number, options: BrowserActionOptions = {}) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const boundedSeconds = Math.max(Number(seconds) || 0, 0);
    const delayMs = boundedSeconds * 1000;
    if (delayMs <= 0) {
      return;
    }
    await this._waitWithAbort(delayMs, signal);
  }

  async send_keys(keys: string, options: BrowserActionOptions = {}) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const page = await this._withAbort(this.get_current_page(), signal);
    const keyboard = page?.keyboard;
    if (!keyboard) {
      throw new BrowserError(
        'Keyboard input is not available on the current page.'
      );
    }

    try {
      await this._withAbort(keyboard.press(keys), signal);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unknown key')) {
        for (const char of keys) {
          await this._withAbort(keyboard.press(char), signal);
        }
        return;
      }
      throw error;
    }
  }

  async click_coordinates(
    coordinate_x: number,
    coordinate_y: number,
    options: BrowserActionOptions & {
      button?: 'left' | 'right' | 'middle';
    } = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const page = await this._withAbort(this.get_current_page(), signal);
    if (!page?.mouse?.click) {
      throw new BrowserError(
        'Unable to perform coordinate click on the current page.'
      );
    }

    await this._withAbort(
      page.mouse.click(coordinate_x, coordinate_y, {
        button: options.button ?? 'left',
      }),
      signal
    );
  }

  async scroll(
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
    options: BrowserActionOptions & { node?: DOMElementNode | null } = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const normalizedAmount = Math.max(Math.floor(Math.abs(amount)), 0);
    if (normalizedAmount === 0) {
      return;
    }

    const page = await this._withAbort(this.get_current_page(), signal);
    if (!page?.evaluate) {
      throw new BrowserError('Unable to access current page for scrolling.');
    }

    const node = options.node ?? null;
    if (node?.xpath) {
      const scrolled = await this._withAbort(
        page.evaluate(
          (payload: {
            xpath: string;
            direction: 'up' | 'down' | 'left' | 'right';
            amount: number;
          }) => {
            const root = document.evaluate(
              payload.xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue as HTMLElement | null;
            if (!root) {
              return false;
            }
            const topDelta =
              payload.direction === 'up'
                ? -payload.amount
                : payload.direction === 'down'
                  ? payload.amount
                  : 0;
            const leftDelta =
              payload.direction === 'left'
                ? -payload.amount
                : payload.direction === 'right'
                  ? payload.amount
                  : 0;
            root.scrollBy({
              top: topDelta,
              left: leftDelta,
              behavior: 'auto',
            });
            return true;
          },
          { xpath: node.xpath, direction, amount: normalizedAmount }
        ),
        signal
      );
      if (scrolled) {
        return;
      }
    }

    if (direction === 'up' || direction === 'down') {
      const pixels =
        direction === 'down' ? -normalizedAmount : normalizedAmount;
      await this._withAbort(this._scrollContainer(pixels), signal);
      return;
    }

    const horizontalDelta =
      direction === 'left' ? -normalizedAmount : normalizedAmount;
    await this._withAbort(
      page.evaluate((x: number) => window.scrollBy(x, 0), horizontalDelta),
      signal
    );
  }

  async scroll_to_text(
    text: string,
    options: BrowserActionOptions & { direction?: 'up' | 'down' } = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const page = await this._withAbort(this.get_current_page(), signal);
    if (!page?.evaluate) {
      throw new BrowserError('Unable to access page for scrolling.');
    }

    const success = await this._withAbort(
      page.evaluate(
        (payload: { text: string; direction: 'up' | 'down' }) => {
          const query = payload.text.toLowerCase();
          const iterator = document.createNodeIterator(
            document.body,
            NodeFilter.SHOW_ELEMENT
          );
          let node: Node | null;
          while ((node = iterator.nextNode())) {
            const el = node as HTMLElement;
            if (!el || !el.textContent) {
              continue;
            }
            if (el.textContent.toLowerCase().includes(query)) {
              el.scrollIntoView({
                behavior: 'smooth',
                block: payload.direction === 'up' ? 'start' : 'center',
              });
              return true;
            }
          }
          return false;
        },
        { text, direction: options.direction ?? 'down' }
      ),
      signal
    );

    if (!success) {
      throw new BrowserError(`Text '${text}' not found on page`);
    }
  }

  async get_dropdown_options(
    element_node: DOMElementNode,
    options: BrowserActionOptions = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const page = await this._withAbort(this.get_current_page(), signal);
    if (!page?.evaluate) {
      throw new BrowserError(
        'Unable to evaluate dropdown options on current page.'
      );
    }
    if (!element_node?.xpath) {
      throw new BrowserError('DOM element does not include an XPath selector.');
    }

    const payload = await this._withAbort(
      page.evaluate(
        ({ xpath }: { xpath: string }) => {
          const element = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue as HTMLElement | null;
          if (!element) return null;

          if (element.tagName?.toLowerCase() === 'select') {
            const options = Array.from(
              (element as HTMLSelectElement).options
            ).map((opt, index) => ({
              text: opt.textContent?.trim() ?? '',
              value: (opt.value ?? '').trim(),
              index,
            }));
            return { type: 'select', options };
          }

          const ariaRoles = new Set(['menu', 'listbox', 'combobox']);
          const role = element.getAttribute('role');
          if (role && ariaRoles.has(role)) {
            const nodes = element.querySelectorAll(
              '[role="menuitem"],[role="option"]'
            );
            const options = Array.from(nodes).map((node, index) => ({
              text: node.textContent?.trim() ?? '',
              value: node.textContent?.trim() ?? '',
              index,
            }));
            return { type: 'aria', options };
          }

          return null;
        },
        { xpath: element_node.xpath }
      ),
      signal
    );

    if (!payload || !Array.isArray((payload as any).options)) {
      throw new BrowserError('No options found for the specified dropdown.');
    }

    const normalizedOptions = (payload as any).options
      .map((option: any, index: number) => ({
        index:
          typeof option?.index === 'number' && Number.isFinite(option.index)
            ? option.index
            : index,
        text: String(option?.text ?? ''),
        value: String(option?.value ?? ''),
      }))
      .filter(
        (option: any) => option.text.length > 0 || option.value.length > 0
      );

    if (normalizedOptions.length === 0) {
      throw new BrowserError('No options found for the specified dropdown.');
    }

    const formattedOptions = normalizedOptions.map(
      (option: { index: number; text: string; value: string }) =>
        `${option.index}: text=${JSON.stringify(option.text)}, value=${JSON.stringify(option.value)}`
    );
    formattedOptions.push(
      'Prefer exact text first; if needed select_dropdown_option also supports case-insensitive text/value matching.'
    );
    const message = formattedOptions.join('\n');
    const indexForMemory = element_node.highlight_index ?? 'unknown';

    return {
      type: String((payload as any).type ?? 'unknown'),
      options: JSON.stringify(normalizedOptions),
      formatted_options: formattedOptions.join('\n'),
      message,
      short_term_memory: message,
      long_term_memory: `Found dropdown options for index ${indexForMemory}.`,
    } satisfies Record<string, string>;
  }

  async select_dropdown_option(
    element_node: DOMElementNode,
    text: string,
    options: BrowserActionOptions = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    if (!element_node?.xpath) {
      throw new BrowserError('DOM element does not include an XPath selector.');
    }

    const page = await this._withAbort(this.get_current_page(), signal);
    if (!page) {
      throw new BrowserError('No active page for selection.');
    }

    const formatAvailableOptions = (
      opts: Array<{ index: number; text: string; value: string }>
    ) =>
      opts
        .map(
          (opt) =>
            `  - [${opt.index}] text=${JSON.stringify(opt.text)} value=${JSON.stringify(opt.value)}`
        )
        .join('\n');

    const pageFrames = (() => {
      const framesAccessor = (page as any).frames;
      if (typeof framesAccessor === 'function') {
        try {
          const result = framesAccessor.call(page);
          return Array.isArray(result) ? result : [];
        } catch {
          return [];
        }
      }
      return Array.isArray(framesAccessor) ? framesAccessor : [];
    })();

    for (const frame of pageFrames) {
      try {
        const typeInfo: any = await this._withAbort(
          frame.evaluate((xpath: string) => {
            const element = document.evaluate(
              xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue as HTMLElement | null;
            if (!element) return { found: false };
            const tagName = element.tagName?.toLowerCase();
            const role = element.getAttribute?.('role');
            if (tagName === 'select') return { found: true, type: 'select' };
            if (role && ['menu', 'listbox', 'combobox'].includes(role))
              return { found: true, type: 'aria' };
            return { found: false };
          }, element_node.xpath),
          signal
        );

        if (!typeInfo?.found) {
          continue;
        }

        if (typeInfo.type === 'select') {
          const selection: any = await this._withAbort(
            frame.evaluate(
              ({
                xpath,
                optionText,
              }: {
                xpath: string;
                optionText: string;
              }) => {
                const root = document.evaluate(
                  xpath,
                  document,
                  null,
                  XPathResult.FIRST_ORDERED_NODE_TYPE,
                  null
                ).singleNodeValue as HTMLSelectElement | null;
                if (!root || root.tagName?.toLowerCase() !== 'select') {
                  return { found: false };
                }

                const options = Array.from(root.options).map((opt, index) => ({
                  index,
                  text: opt.textContent?.trim() ?? '',
                  value: (opt.value ?? '').trim(),
                }));
                const targetRaw = optionText.trim();
                const targetLower = optionText.trim().toLowerCase();

                let matchedIndex = options.findIndex(
                  (opt) => opt.text === targetRaw || opt.value === targetRaw
                );
                if (matchedIndex < 0) {
                  matchedIndex = options.findIndex(
                    (opt) =>
                      opt.text.trim().toLowerCase() === targetLower ||
                      opt.value.trim().toLowerCase() === targetLower
                  );
                }
                if (matchedIndex < 0) {
                  return { found: true, success: false, options };
                }

                const matched = options[matchedIndex];
                root.value = matched.value;
                root.dispatchEvent(new Event('input', { bubbles: true }));
                root.dispatchEvent(new Event('change', { bubbles: true }));
                const selectedOption =
                  root.selectedIndex >= 0
                    ? root.options[root.selectedIndex]
                    : null;
                const selectedText = selectedOption?.textContent?.trim() ?? '';
                const selectedValue = (root.value ?? '').trim();
                const selectedValueLower = selectedValue.trim().toLowerCase();
                const selectedTextLower = selectedText.trim().toLowerCase();
                const matchedValueLower = String(matched.value ?? '')
                  .trim()
                  .toLowerCase();
                const matchedTextLower = String(matched.text ?? '')
                  .trim()
                  .toLowerCase();
                const verified =
                  selectedValueLower === matchedValueLower ||
                  selectedTextLower === matchedTextLower;

                return {
                  found: true,
                  success: verified,
                  options,
                  selectedText,
                  selectedValue,
                  matched,
                };
              },
              { xpath: element_node.xpath, optionText: text }
            ),
            signal
          );

          if (selection?.found && selection.success) {
            const matchedText = selection.matched?.text ?? text;
            const matchedValue = selection.matched?.value ?? '';
            const msg = `Selected option ${matchedText} (${matchedValue})`;
            return {
              message: msg,
              short_term_memory: msg,
              long_term_memory: msg,
              matched_text: String(matchedText),
              matched_value: String(matchedValue),
            } satisfies Record<string, string>;
          }
          if (selection?.found) {
            const details = formatAvailableOptions(
              (selection.options as Array<{
                index: number;
                text: string;
                value: string;
              }>) ?? []
            );
            throw new BrowserError(
              `Could not select option '${text}' for index ${element_node.highlight_index ?? 'unknown'}.\nAvailable options:\n${details}`
            );
          }
          continue;
        }

        const clicked: any = await this._withAbort(
          frame.evaluate(
            ({ xpath, optionText }: { xpath: string; optionText: string }) => {
              const root = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue as HTMLElement | null;
              if (!root) return false;
              const nodes = root.querySelectorAll(
                '[role="menuitem"],[role="option"]'
              );
              const options = Array.from(nodes).map((node, index) => ({
                index,
                text: node.textContent?.trim() ?? '',
                value: node.textContent?.trim() ?? '',
              }));
              const targetRaw = optionText.trim();
              const targetLower = optionText.trim().toLowerCase();

              let matchedIndex = options.findIndex(
                (opt) => opt.text === targetRaw || opt.value === targetRaw
              );
              if (matchedIndex < 0) {
                matchedIndex = options.findIndex(
                  (opt) =>
                    opt.text.trim().toLowerCase() === targetLower ||
                    opt.value.trim().toLowerCase() === targetLower
                );
              }
              if (matchedIndex < 0) {
                return { found: true, success: false, options };
              }
              (nodes[matchedIndex] as HTMLElement).click();
              return {
                found: true,
                success: true,
                options,
                matched: options[matchedIndex],
              };
            },
            { xpath: element_node.xpath, optionText: text }
          ),
          signal
        );

        if (clicked?.found && clicked.success) {
          const matchedText = clicked.matched?.text ?? text;
          const msg = `Selected menu item ${matchedText}`;
          return {
            message: msg,
            short_term_memory: msg,
            long_term_memory: msg,
            matched_text: String(matchedText),
          } satisfies Record<string, string>;
        }
        if (clicked?.found) {
          const details = formatAvailableOptions(
            (clicked.options as Array<{
              index: number;
              text: string;
              value: string;
            }>) ?? []
          );
          throw new BrowserError(
            `Could not select option '${text}' for index ${element_node.highlight_index ?? 'unknown'}.\nAvailable options:\n${details}`
          );
        }
      } catch (error) {
        if (error instanceof BrowserError) {
          throw error;
        }
        continue;
      }
    }

    throw new BrowserError(
      `Could not select option '${text}' for index ${element_node.highlight_index ?? 'unknown'}`
    );
  }

  async upload_file(
    element_node: DOMElementNode,
    file_path: string,
    options: BrowserActionOptions = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const locator = await this.get_locate_element(element_node);
    if (!locator) {
      throw new Error('Element not found');
    }
    if (!fs.existsSync(file_path)) {
      throw new Error(`File does not exist: ${file_path}`);
    }

    const locatorWithUpload = locator as unknown as {
      setInputFiles?: (
        filePath: string,
        options?: { timeout?: number }
      ) => Promise<void>;
    };
    if (typeof locatorWithUpload.setInputFiles !== 'function') {
      throw new Error('Element does not support file upload');
    }

    await this._withAbort(
      locatorWithUpload.setInputFiles(file_path, { timeout: 5000 }),
      signal
    );
  }

  async go_back(options: BrowserActionOptions = {}) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const page = await this._withAbort(this.get_current_page(), signal);
    if (!page?.goBack) {
      return;
    }

    const previousUrl = this.currentUrl;
    try {
      await this._withAbort(page.goBack(), signal);
    } catch (error) {
      if (this._isAbortError(error)) {
        throw error;
      }
      this.logger.debug(`Failed to navigate back: ${(error as Error).message}`);
    }
    this._throwIfAborted(signal);
    await this._syncCurrentTabFromPage(page);
    const currentUrl = this.currentUrl;

    if (currentUrl && currentUrl !== previousUrl) {
      const existingIndex = this.historyStack.lastIndexOf(currentUrl);
      if (existingIndex !== -1) {
        this.historyStack = this.historyStack.slice(0, existingIndex + 1);
      } else if (
        this.historyStack[this.historyStack.length - 1] !== currentUrl
      ) {
        this.historyStack.push(currentUrl);
      }
    }
    this.cachedBrowserState = null;
    this._recordRecentEvent('navigation_back', { url: currentUrl });
  }

  async get_dom_element_by_index(
    _index: number,
    options: BrowserActionOptions = {}
  ) {
    const selectorMap = await this.get_selector_map(options);
    return selectorMap?.[_index] ?? null;
  }

  set_downloaded_files(files: string[]) {
    if (!Array.isArray(files)) {
      return;
    }
    this.downloaded_files = [...files];
  }

  add_downloaded_file(filePath: string) {
    if (!filePath) {
      return;
    }
    if (!this.downloaded_files.includes(filePath)) {
      this.downloaded_files = [...this.downloaded_files, filePath];
      this.logger.info(
        `📁 Added download to session tracking (total: ${this.downloaded_files.length} files)`
      );
    }
  }

  get_downloaded_files() {
    this.logger.debug(
      `📁 Retrieved ${this.downloaded_files.length} downloaded files from session tracking`
    );
    return [...this.downloaded_files];
  }

  set_auto_download_pdfs(enabled: boolean) {
    this._autoDownloadPdfs = Boolean(enabled);
    this.logger.info(
      `📄 PDF auto-download ${this._autoDownloadPdfs ? 'enabled' : 'disabled'}`
    );
  }

  auto_download_pdfs() {
    return this._autoDownloadPdfs;
  }

  static async get_unique_filename(directory: string, filename: string) {
    const resolvedDir = path.resolve(directory);
    const parsed = path.parse(filename);
    let candidate = filename;
    let counter = 1;
    while (fs.existsSync(path.join(resolvedDir, candidate))) {
      candidate = `${parsed.name} (${counter})${parsed.ext}`;
      counter += 1;
    }
    return candidate;
  }

  async get_selector_map(options: BrowserActionOptions = {}) {
    if (!this.cachedBrowserState) {
      await this.get_browser_state_with_recovery({
        cache_clickable_elements_hashes: true,
        include_screenshot: false,
        signal: options.signal ?? null,
      });
    }
    return this.cachedBrowserState?.selector_map ?? {};
  }

  static is_file_input(node: DOMElementNode | null) {
    if (!node) {
      return false;
    }
    return (
      node.tag_name?.toLowerCase() === 'input' &&
      (node.attributes?.type ?? '').toLowerCase() === 'file'
    );
  }

  is_file_input(node: DOMElementNode | null) {
    return BrowserSession.is_file_input(node);
  }

  async find_file_upload_element_by_index(
    index: number,
    maxHeight = 3,
    maxDescendantDepth = 3,
    options: BrowserActionOptions = {}
  ) {
    const selectorMap = await this.get_selector_map(options);
    const root = selectorMap[index];
    if (!root) {
      return null;
    }

    const findInDescendants = (
      node: DOMElementNode,
      depth: number
    ): DOMElementNode | null => {
      if (depth < 0) {
        return null;
      }
      if (BrowserSession.is_file_input(node)) {
        return node;
      }
      for (const child of node.children) {
        if (child instanceof DOMElementNode) {
          const found = findInDescendants(child, depth - 1);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };

    let current: DOMElementNode | null = root;
    let remainingHeight = maxHeight;
    while (current && remainingHeight >= 0) {
      const direct = findInDescendants(current, maxDescendantDepth);
      if (direct) {
        return direct;
      }

      if (current.parent) {
        for (const sibling of current.parent.children) {
          if (sibling instanceof DOMElementNode && sibling !== current) {
            const fromSibling = findInDescendants(sibling, maxDescendantDepth);
            if (fromSibling) {
              return fromSibling;
            }
          }
        }
      }

      current = current.parent;
      remainingHeight -= 1;
    }

    return null;
  }

  async get_locate_element(node: DOMElementNode): Promise<Locator | null> {
    const page = await this.get_current_page();
    if (!page || !node?.xpath) {
      return null;
    }
    try {
      const locator = page.locator(`xpath=${node.xpath}`);
      const count = await locator.count();
      if (count === 0) {
        return null;
      }
      return locator;
    } catch (error) {
      this.logger.debug(
        `Failed to locate element via xpath ${node.xpath}: ${(error as Error).message}`
      );
      return null;
    }
  }

  async _input_text_element_node(
    node: DOMElementNode,
    text: string,
    options: BrowserActionOptions = {}
  ) {
    const signal = options.signal ?? null;
    const clear = options.clear ?? true;
    this._throwIfAborted(signal);
    const locator = await this.get_locate_element(node);
    if (!locator) {
      throw new Error('Element not found');
    }
    await this._withAbort(locator.click({ timeout: 5000 }), signal);
    if (clear) {
      await this._withAbort(locator.fill(text, { timeout: 5000 }), signal);
    } else {
      await this._withAbort(locator.type(text, { timeout: 5000 }), signal);
    }
  }

  async _click_element_node(
    node: DOMElementNode,
    options: BrowserActionOptions = {}
  ) {
    const signal = options.signal ?? null;
    this._throwIfAborted(signal);
    const locator = await this.get_locate_element(node);
    if (!locator) {
      throw new Error('Element not found');
    }
    const page = await this._withAbort(this.get_current_page(), signal);
    const performClick = async () => {
      await this._withAbort(locator.click({ timeout: 5000 }), signal);
    };

    const downloadsDir = this.browser_profile.downloads_path;
    if (downloadsDir && page?.waitForEvent) {
      // most clicks don't trigger a download. attach a no-op catch so that if
      // performClick() throws (e.g. click timeout on a nested iframe), the
      // pending waitForEvent rejection doesn't escape as an unhandledRejection
      // and kill the host process. The real await below still observes the
      // outcome and the catch block treats timeout as "no download, proceed".
      const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
      downloadPromise.catch(() => null);
      await performClick();
      try {
        const download = await this._withAbort(downloadPromise, signal);
        const downloadGuid = uuid7str();
        const suggested =
          typeof download.suggestedFilename === 'function'
            ? download.suggestedFilename()
            : 'download';
        const downloadUrl =
          typeof download.url === 'function'
            ? download.url()
            : (this.currentUrl ?? '');
        await this.event_bus.dispatch(
          new DownloadStartedEvent({
            guid: downloadGuid,
            url: downloadUrl,
            suggested_filename: suggested,
            auto_download: false,
          })
        );
        const uniqueFilename = await BrowserSession.get_unique_filename(
          downloadsDir,
          suggested
        );
        const downloadPath = path.join(downloadsDir, uniqueFilename);
        if (typeof download.saveAs === 'function') {
          await download.saveAs(downloadPath);
        }
        const stats = fs.existsSync(downloadPath)
          ? fs.statSync(downloadPath)
          : null;
        await this.event_bus.dispatch(
          new DownloadProgressEvent({
            guid: downloadGuid,
            received_bytes: stats?.size ?? 0,
            total_bytes: stats?.size ?? 0,
            state: 'completed',
          })
        );
        const fileDownloadedResult = await this.event_bus.dispatch(
          new FileDownloadedEvent({
            guid: downloadGuid,
            url: downloadUrl,
            path: downloadPath,
            file_name: uniqueFilename,
            file_size: stats?.size ?? 0,
            file_type: path.extname(uniqueFilename).replace('.', '') || null,
            mime_type: null,
            auto_download: false,
          })
        );
        if (fileDownloadedResult.handler_results.length === 0) {
          this.add_downloaded_file(downloadPath);
        }
        return downloadPath;
      } catch (error) {
        if (this._isAbortError(error)) {
          throw error;
        }
        this.logger.debug(
          `No download triggered within timeout: ${(error as Error).message}`
        );
      }
    } else {
      await performClick();
    }

    await this._waitForLoad(page, 5000, signal);
    if (page) {
      await this._syncCurrentTabFromPage(page);
      if (this.historyStack[this.historyStack.length - 1] !== this.currentUrl) {
        this.historyStack.push(this.currentUrl);
      }
    }
    this.cachedBrowserState = null;
    return null;
  }

  private async _waitForLoad(
    page: Page | null,
    timeout = 5000,
    signal: AbortSignal | null = null
  ) {
    if (!page || typeof page.waitForLoadState !== 'function') {
      return;
    }
    try {
      await this._withAbort(
        page.waitForLoadState('domcontentloaded', { timeout }),
        signal
      );
    } catch (error) {
      if (this._isAbortError(error)) {
        throw error;
      }
      this.logger.debug(`waitForLoadState failed: ${(error as Error).message}`);
    }
  }

  // ==================== Cookie Management ====================

  /**
   * Get all cookies from the current browser context
   */
  async get_cookies(): Promise<Array<Record<string, any>>> {
    if (this.browser_context?.cookies) {
      return await this.browser_context.cookies();
    }
    return [];
  }

  /**
   * Save cookies to a file (deprecated, use save_storage_state instead)
   * @deprecated Use save_storage_state() instead
   */
  async save_cookies(...args: any[]): Promise<void> {
    return this.save_storage_state(...args);
  }

  /**
   * Load cookies from a file (deprecated, use load_storage_state instead)
   * @deprecated Use load_storage_state() instead
   */
  async load_cookies_from_file(...args: any[]): Promise<void> {
    return this.load_storage_state(...args);
  }

  /**
   * Save the current storage state (cookies, localStorage, sessionStorage) to a file
   */
  async save_storage_state(filePath?: string): Promise<void> {
    if (!this.browser_context) {
      this.logger.warning(
        'Cannot save storage state: browser context not initialized'
      );
      return;
    }

    const targetPath = filePath || this.browser_profile.cookies_file;
    if (!targetPath) {
      return;
    }

    try {
      const resolvedPath = path.resolve(targetPath);
      const dirPath = path.dirname(resolvedPath);

      // Create directory if it doesn't exist
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Get storage state from browser context
      const storageState = await this.browser_context.storageState();

      // Write to temporary file first
      const tempPath = `${resolvedPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(storageState, null, 2));

      // Backup existing file if present
      if (fs.existsSync(resolvedPath)) {
        const backupPath = `${resolvedPath}.bak`;
        try {
          fs.renameSync(resolvedPath, backupPath);
        } catch (error) {
          // Ignore backup errors
        }
      }

      // Move temp file to target
      fs.renameSync(tempPath, resolvedPath);

      const cookieCount = storageState.cookies?.length || 0;
      this.logger.info(
        `🍪 Saved ${cookieCount} cookies to ${path.basename(resolvedPath)}`
      );
    } catch (error) {
      this.logger.warning(
        `❌ Failed to save storage state: ${(error as Error).message}`
      );
    }
  }

  /**
   * Load storage state (cookies, localStorage, sessionStorage) from a file
   */
  async load_storage_state(filePath?: string): Promise<void> {
    const targetPath = filePath || this.browser_profile.cookies_file;
    if (!targetPath) {
      return;
    }

    try {
      const resolvedPath = path.resolve(targetPath);

      if (!fs.existsSync(resolvedPath)) {
        this.logger.warning(`Storage state file not found: ${resolvedPath}`);
        return;
      }

      const storageStateContent = fs.readFileSync(resolvedPath, 'utf-8');
      const storageState = JSON.parse(storageStateContent);

      if (this.browser_context?.addCookies) {
        // Add cookies to context
        if (storageState.cookies && Array.isArray(storageState.cookies)) {
          await this.browser_context.addCookies(storageState.cookies);
          this.logger.info(
            `🍪 Loaded ${storageState.cookies.length} cookies from ${path.basename(resolvedPath)}`
          );
        }
      }
    } catch (error) {
      this.logger.warning(
        `❌ Failed to load storage state: ${(error as Error).message}`
      );
    }
  }

  // ==================== JavaScript Execution ====================

  /**
   * Execute JavaScript in the current page context
   */
  async execute_javascript(script: string): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No page available to execute JavaScript');
    }
    return await page.evaluate(script);
  }

  // ==================== Page Information ====================

  /**
   * Get comprehensive page information (size, scroll position, etc.)
   */
  async get_page_info(page?: Page): Promise<any> {
    const targetPage = page || (await this.get_current_page());
    if (!targetPage) {
      return null;
    }

    const pageData = await targetPage.evaluate(() => {
      return {
        // Current viewport dimensions
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,

        // Total page dimensions
        page_width: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth || 0
        ),
        page_height: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight || 0
        ),

        // Current scroll position
        scroll_x:
          window.scrollX ||
          window.pageXOffset ||
          document.documentElement.scrollLeft ||
          0,
        scroll_y:
          window.scrollY ||
          window.pageYOffset ||
          document.documentElement.scrollTop ||
          0,
      };
    });

    // Calculate derived values
    const viewport_width = Math.floor(pageData.viewport_width);
    const viewport_height = Math.floor(pageData.viewport_height);
    const page_width = Math.floor(pageData.page_width);
    const page_height = Math.floor(pageData.page_height);
    const scroll_x = Math.floor(pageData.scroll_x);
    const scroll_y = Math.floor(pageData.scroll_y);

    // Calculate scroll information
    const pixels_above = scroll_y;
    const pixels_below = Math.max(
      0,
      page_height - (scroll_y + viewport_height)
    );
    const pixels_left = scroll_x;
    const pixels_right = Math.max(0, page_width - (scroll_x + viewport_width));

    return {
      viewport_width,
      viewport_height,
      page_width,
      page_height,
      scroll_x,
      scroll_y,
      pixels_above,
      pixels_below,
      pixels_left,
      pixels_right,
    };
  }

  /**
   * Get the HTML content of the current page
   */
  async get_page_html(): Promise<string> {
    const page = await this.get_current_page();
    if (!page) {
      return '';
    }
    return await page.content();
  }

  /**
   * Get a debug view of the page structure including iframes
   */
  async get_page_structure(): Promise<string> {
    const page = await this.get_current_page();
    if (!page) {
      return '';
    }

    const debug_script = `(() => {
			function getPageStructure(element = document, depth = 0, maxDepth = 10) {
				if (depth >= maxDepth) return '';

				const indent = '  '.repeat(depth);
				let structure = '';

				// Skip certain elements that clutter the output
				const skipTags = new Set(['script', 'style', 'link', 'meta', 'noscript']);

				// Add current element info if it's not the document
				if (element !== document) {
					const tagName = element.tagName.toLowerCase();

					// Skip uninteresting elements
					if (skipTags.has(tagName)) return '';

					const id = element.id ? \`#\${element.id}\` : '';
					const classes = element.className && typeof element.className === 'string' ?
						\`.\${element.className.split(' ').filter(c => c).join('.')}\` : '';

					// Get additional useful attributes
					const attrs = [];
					if (element.getAttribute('role')) attrs.push(\`role="\${element.getAttribute('role')}"\`);
					if (element.getAttribute('aria-label')) attrs.push(\`aria-label="\${element.getAttribute('aria-label')}"\`);
					if (element.getAttribute('type')) attrs.push(\`type="\${element.getAttribute('type')}"\`);
					if (element.getAttribute('name')) attrs.push(\`name="\${element.getAttribute('name')}"\`);
					if (element.getAttribute('src')) {
						const src = element.getAttribute('src');
						attrs.push(\`src="\${src.substring(0, 50)}\${src.length > 50 ? '...' : ''}"\`);
					}

					// Add element info
					structure += \`\${indent}\${tagName}\${id}\${classes}\${attrs.length ? ' [' + attrs.join(', ') + ']' : ''}\\n\`;

					// Handle iframes specially
					if (tagName === 'iframe') {
						try {
							const iframeDoc = element.contentDocument || element.contentWindow?.document;
							if (iframeDoc) {
								structure += \`\${indent}  [IFRAME CONTENT]:\\n\`;
								structure += getPageStructure(iframeDoc, depth + 2, maxDepth);
							} else {
								structure += \`\${indent}  [CROSS-ORIGIN IFRAME - Cannot access]\\n\`;
							}
						} catch (e) {
							structure += \`\${indent}  [IFRAME - Access denied]\\n\`;
						}
						return structure;
					}
				}

				// Process children
				const children = element.children || element.documentElement?.children || [];
				for (let i = 0; i < children.length; i++) {
					structure += getPageStructure(children[i], depth + 1, maxDepth);
				}

				return structure;
			}

			return getPageStructure();
		})()`;

    return await page.evaluate(debug_script);
  }

  // ==================== Navigation & History ====================

  /**
   * Navigate forward in browser history
   */
  async go_forward(): Promise<void> {
    try {
      const page = await this.get_current_page();
      if (page?.goForward) {
        await page.goForward({ timeout: 10000, waitUntil: 'load' });
      }
    } catch (error) {
      this.logger.debug(
        `⏭️ Error during go_forward: ${(error as Error).message}`
      );
      // Verify page is still usable after navigation error
      if ((error as Error).message.toLowerCase().includes('timeout')) {
        const page = await this.get_current_page();
        try {
          await page?.evaluate('1');
        } catch (evalError) {
          this.logger.error(
            `❌ Page crashed after go_forward timeout: ${(evalError as Error).message}`
          );
        }
      }
    }
  }

  /**
   * Refresh the current page
   */
  async refresh(): Promise<void> {
    try {
      const page = await this.get_current_page();
      if (page?.reload) {
        this.currentPageLoadingStatus = null;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this._waitForStableNetwork(page);
      }
    } catch (error) {
      this.logger.debug(`🔄 Error during refresh: ${(error as Error).message}`);
    }
  }

  // ==================== Element Waiting ====================

  /**
   * Wait for an element to appear on the page
   */
  async wait_for_element(
    selector: string,
    timeout: number = 10000
  ): Promise<void> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No page available');
    }
    await page.waitForSelector(selector, { state: 'visible', timeout });
  }

  // ==================== Screenshots ====================

  /**
   * Take a screenshot of the current page.
   * @param full_page Whether to capture the full scrollable page
   * @param clip Optional clip region for partial screenshots
   * @returns Base64 encoded PNG screenshot
   */
  async take_screenshot(
    full_page: boolean = false,
    clip: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null
  ): Promise<string | null> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No page available for screenshot');
    }

    if (!this.browser_context) {
      throw new Error('Browser context is not set');
    }

    // Check if it's a new tab page
    const url = page.url();
    if (
      url === 'about:blank' ||
      url === 'chrome://newtab/' ||
      url === 'edge://newtab/'
    ) {
      this.logger.warning(`▫️ Skipping screenshot of empty page: ${url}`);
      // Return a 4px placeholder
      return 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAD0lEQVQIHWP8//8/AxYMACgtBP9g8jqYAAAAAElFTkSuQmCC';
    }

    // Bring page to front before rendering
    try {
      await page.bringToFront();
    } catch (error) {
      // Ignore errors
    }

    // Take screenshot using CDP for better performance
    let cdp_session: any = null;
    try {
      this.logger.debug(
        `📸 Taking ${full_page ? 'full-page' : 'viewport'} PNG screenshot via CDP: ${url}`
      );

      // Create CDP session for the screenshot
      cdp_session = await this.get_or_create_cdp_session(page);

      // Capture screenshot via CDP
      const screenshotParams: Record<string, unknown> = {
        captureBeyondViewport: full_page,
        fromSurface: true,
        format: 'png',
      };
      if (clip) {
        screenshotParams.clip = {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1,
        };
      }

      const screenshot_response = await cdp_session.send(
        'Page.captureScreenshot',
        screenshotParams
      );

      const screenshot_b64 = screenshot_response.data;
      if (!screenshot_b64) {
        throw new Error(`CDP returned empty screenshot data for page ${url}`);
      }

      return screenshot_b64;
    } catch (error) {
      const error_str = (error as Error).message || String(error);
      if (error_str.toLowerCase().includes('timeout')) {
        this.logger.warning(
          `⏱️ Screenshot timed out on page ${url}: ${error_str}`
        );
      } else {
        this.logger.error(`❌ Screenshot failed on page ${url}: ${error_str}`);
      }
      throw error;
    } finally {
      if (cdp_session) {
        try {
          await cdp_session.detach();
        } catch (error) {
          // Ignore detach errors
        }
      }
    }
  }

  // ==================== Event Listeners ====================

  /**
   * Add a request event listener to the current page
   */
  async on_request(
    callback: (request: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.on === 'function') {
      page.on('request', callback);
    }
  }

  /**
   * Add a response event listener to the current page
   */
  async on_response(
    callback: (response: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.on === 'function') {
      page.on('response', callback);
    }
  }

  /**
   * Remove a request event listener from the current page
   */
  async off_request(
    callback: (request: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.off === 'function') {
      page.off('request', callback);
    }
  }

  /**
   * Remove a response event listener from the current page
   */
  async off_response(
    callback: (response: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.off === 'function') {
      page.off('response', callback);
    }
  }

  // ==================== P2 Additional Functions ====================

  /**
   * Get information about all open tabs
   * @returns Array of tab information including page_id, tab_id, url, and title
   */
  async get_tabs_info(): Promise<
    Array<{ page_id: number; tab_id: string; url: string; title: string }>
  > {
    if (!this.browser_context) {
      return [];
    }
    this._syncTabsWithBrowserPages();

    const tabs_info: Array<{
      page_id: number;
      tab_id: string;
      url: string;
      title: string;
    }> = [];
    for (const tab of this._tabs) {
      const page_id = tab.page_id;
      const page = this.tabPages.get(page_id) ?? null;
      const tab_id = tab.tab_id || this._formatTabId(page_id);
      if (!tab.tab_id) {
        tab.tab_id = tab_id;
      }
      this._attachDialogHandler(page);

      let currentUrl = tab.url;
      if (page?.url) {
        try {
          currentUrl = normalize_url(page.url());
        } catch {
          // Keep tab url fallback when page url is unavailable.
        }
      }

      // Skip chrome:// pages and new tab pages
      const isNewTab =
        currentUrl === 'about:blank' ||
        currentUrl.startsWith('chrome://newtab');
      if (isNewTab || currentUrl.startsWith('chrome://')) {
        if (isNewTab) {
          tabs_info.push({
            page_id,
            tab_id,
            url: currentUrl,
            title: 'ignore this tab and do not use it',
          });
        } else {
          tabs_info.push({
            page_id,
            tab_id,
            url: currentUrl,
            title: currentUrl,
          });
        }
        continue;
      }

      // Normal pages - try to get title with timeout
      try {
        if (!page?.title) {
          throw new Error('page_title_unavailable');
        }
        const titlePromise = page.title();
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 2000);
        });

        const title = await Promise.race([titlePromise, timeoutPromise]);
        tabs_info.push({ page_id, tab_id, url: currentUrl, title });
      } catch (error) {
        this.logger.debug(
          `⚠️ Failed to get tab info for tab #${page_id}: ${currentUrl} (using fallback title)`
        );

        if (isNewTab) {
          tabs_info.push({
            page_id,
            tab_id,
            url: currentUrl,
            title: 'ignore this tab and do not use it',
          });
        } else {
          tabs_info.push({
            page_id,
            tab_id,
            url: currentUrl,
            title: tab.title || currentUrl,
          });
        }
      }
    }

    return tabs_info;
  }

  /**
   * Check if a page is responsive by trying to evaluate simple JavaScript
   * @param page - The page to check
   * @param timeout - Timeout in seconds (default: 5)
   * @returns True if page is responsive, false otherwise
   */
  async _is_page_responsive(
    page: any,
    timeout: number = 5.0
  ): Promise<boolean> {
    try {
      const evalPromise = page.evaluate('1');
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeout * 1000);
      });

      await Promise.race([evalPromise, timeoutPromise]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get scroll information for the current page
   * @returns Object with scroll position and page dimensions
   */
  async get_scroll_info(): Promise<{
    scroll_x: number;
    scroll_y: number;
    page_width: number;
    page_height: number;
    viewport_width: number;
    viewport_height: number;
  }> {
    const page = await this.get_current_page();
    if (!page) {
      return {
        scroll_x: 0,
        scroll_y: 0,
        page_width: 0,
        page_height: 0,
        viewport_width: 0,
        viewport_height: 0,
      };
    }

    return await page.evaluate(() => {
      return {
        scroll_x:
          window.scrollX ||
          window.pageXOffset ||
          document.documentElement.scrollLeft ||
          0,
        scroll_y:
          window.scrollY ||
          window.pageYOffset ||
          document.documentElement.scrollTop ||
          0,
        page_width: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth || 0
        ),
        page_height: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight || 0
        ),
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
      };
    });
  }

  /**
   * Get a summary of the current browser state
   * @param cache_clickable_elements_hashes - Cache clickable element hashes to detect new elements
   * @param include_screenshot - Include screenshot in state summary
   * @returns BrowserStateSummary with current page state
   */
  async get_state_summary(
    cache_clickable_elements_hashes: boolean = true,
    include_screenshot: boolean = true,
    include_recent_events: boolean = false
  ): Promise<BrowserStateSummary> {
    this.logger.debug('🔄 Starting get_state_summary...');

    const updated_state = await this._get_updated_state(
      -1,
      include_screenshot,
      include_recent_events
    );

    // Implement clickable element hash caching to detect new elements
    if (cache_clickable_elements_hashes) {
      const page = await this.get_current_page();
      if (page) {
        const currentUrl = page.url();
        const currentHashes = this._computeElementHashes(
          updated_state.selector_map
        );

        // Mark new elements if we have cached hashes for this URL
        if (
          this._cachedClickableElementHashes &&
          this._cachedClickableElementHashes.url === currentUrl
        ) {
          this._markNewElements(
            updated_state.selector_map,
            this._cachedClickableElementHashes.hashes
          );
        }

        // Update cache with current hashes
        this._cachedClickableElementHashes = {
          url: currentUrl,
          hashes: currentHashes,
        };
      }
    }

    this.cachedBrowserState = updated_state;
    return this.cachedBrowserState;
  }

  /**
   * Get minimal state summary without DOM processing, but with screenshot
   * Used when page is in error state or unresponsive
   */
  async get_minimal_state_summary(
    include_recent_events: boolean = false
  ): Promise<BrowserStateSummary> {
    try {
      const page = await this.get_current_page();
      const url = page ? page.url() : 'unknown';

      // Try to get title safely
      let title = 'Page Load Error';
      try {
        if (page) {
          const titlePromise = page.title();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 2000)
          );
          title = await Promise.race([titlePromise, timeoutPromise]);
        }
      } catch (error) {
        // Keep default title
      }

      // Try to get tabs info safely
      let tabs_info: TabInfo[] = [];
      try {
        const tabsPromise = this.get_tabs_info();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        );
        tabs_info = await Promise.race([tabsPromise, timeoutPromise]);
      } catch (error) {
        // Keep empty tabs
      }

      // Create minimal DOM element for error state
      const minimal_element_tree = new DOMElementNode(
        true,
        null,
        'body',
        '/body',
        {},
        []
      );

      // Try to get screenshot
      let screenshot_b64: string | null = null;
      try {
        screenshot_b64 = await this.take_screenshot();
      } catch (error) {
        this.logger.debug(
          `Screenshot failed in minimal state: ${(error as Error).message}`
        );
      }

      // Use default viewport dimensions
      const viewport = this.browser_profile.viewport || {
        width: 1280,
        height: 720,
      };

      const dom_state = new DOMState(minimal_element_tree, {});
      this._original_viewport_size = [viewport.width, viewport.height];
      return new BrowserStateSummary(dom_state, {
        url,
        title,
        tabs: tabs_info,
        screenshot: screenshot_b64,
        page_info: {
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          page_width: viewport.width,
          page_height: viewport.height,
          scroll_x: 0,
          scroll_y: 0,
          pixels_above: 0,
          pixels_below: 0,
          pixels_left: 0,
          pixels_right: 0,
        },
        pixels_above: 0,
        pixels_below: 0,
        browser_errors: ['Page in error state - minimal navigation available'],
        is_pdf_viewer: false,
        loading_status: this.currentPageLoadingStatus,
        recent_events: include_recent_events
          ? this._getRecentEventsSummary()
          : null,
        pending_network_requests: [],
        pagination_buttons: [],
        closed_popup_messages: this._getClosedPopupMessagesSnapshot(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to get minimal state summary: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * Internal method to get updated browser state with DOM processing
   * @param focus_element - Element index to focus on (default: -1)
   * @param include_screenshot - Whether to include screenshot
   */
  private async _get_updated_state(
    focus_element: number = -1,
    include_screenshot: boolean = true,
    include_recent_events: boolean = false
  ): Promise<BrowserStateSummary> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No current page available');
    }

    const page_url = page.url();

    // Check for new tab or chrome:// pages - fast path
    const is_empty_page =
      this._is_new_tab_page(page_url) || page_url.startsWith('chrome://');

    if (is_empty_page) {
      this.logger.debug(`⚡ Fast path for empty page: ${page_url}`);

      // Create minimal DOM state
      const minimal_element_tree = new DOMElementNode(
        false,
        null,
        'body',
        '',
        {},
        []
      );

      const tabs_info = await this.get_tabs_info();
      const viewport = this.browser_profile.viewport || {
        width: 1280,
        height: 720,
      };

      const dom_state = new DOMState(minimal_element_tree, {});
      this._original_viewport_size = [viewport.width, viewport.height];
      return new BrowserStateSummary(dom_state, {
        url: page_url,
        title: this._is_new_tab_page(page_url) ? 'New Tab' : 'Chrome Page',
        tabs: tabs_info,
        screenshot: null,
        page_info: {
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          page_width: viewport.width,
          page_height: viewport.height,
          scroll_x: 0,
          scroll_y: 0,
          pixels_above: 0,
          pixels_below: 0,
          pixels_left: 0,
          pixels_right: 0,
        },
        pixels_above: 0,
        pixels_below: 0,
        browser_errors: [],
        is_pdf_viewer: false,
        loading_status: this.currentPageLoadingStatus,
        recent_events: include_recent_events
          ? this._getRecentEventsSummary()
          : null,
        pending_network_requests: [],
        pagination_buttons: [],
        closed_popup_messages: this._getClosedPopupMessagesSnapshot(),
      });
    }

    // Normal path for regular pages
    this.logger.debug('🧹 Removing highlights...');
    try {
      await this.remove_highlights();
    } catch (error) {
      this.logger.debug('Timeout removing highlights');
    }

    // Check for PDF and auto-download if needed
    try {
      const pdf_path = await this._auto_download_pdf_if_needed(page);
      if (pdf_path) {
        this.logger.info(`📄 PDF auto-downloaded: ${pdf_path}`);
      }
    } catch (error) {
      this.logger.debug(
        `PDF auto-download check failed: ${(error as Error).message}`
      );
    }

    // DOM processing
    this.logger.debug('🌳 Starting DOM processing...');
    const dom_service = new DomService(page, this.logger);

    let content: DOMState;
    try {
      const domPromise = dom_service.get_clickable_elements(
        this.browser_profile.highlight_elements,
        focus_element,
        this.browser_profile.viewport_expansion
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DOM processing timeout')), 45000)
      );

      content = await Promise.race([domPromise, timeoutPromise]);
      this.logger.debug('✅ DOM processing completed');
    } catch (error) {
      this.logger.warning(`DOM processing timed out for ${page_url}`);
      this.logger.warning('🔄 Falling back to minimal DOM state...');

      // Create minimal DOM state for fallback
      const minimal_element_tree = new DOMElementNode(
        true,
        null,
        'body',
        '/body',
        {},
        []
      );
      content = new DOMState(minimal_element_tree, {});
    }

    // Get tabs info
    this.logger.debug('📋 Getting tabs info...');
    const tabs_info = await this.get_tabs_info();
    this.logger.debug('✅ Tabs info completed');

    // Screenshot
    let screenshot_b64: string | null = null;
    if (include_screenshot) {
      try {
        this.logger.debug('📸 Capturing screenshot...');
        screenshot_b64 = await this.take_screenshot();
      } catch (error) {
        this.logger.warning(
          `❌ Screenshot failed for ${page_url}: ${(error as Error).message}`
        );
      }
    }

    // Get page info and scroll info
    const page_info = await this.get_page_info(page);
    if (
      page_info &&
      Number.isFinite(page_info.viewport_width) &&
      Number.isFinite(page_info.viewport_height)
    ) {
      this._original_viewport_size = [
        Math.floor(page_info.viewport_width),
        Math.floor(page_info.viewport_height),
      ];
    }

    let pixels_above = 0;
    let pixels_below = 0;
    try {
      this.logger.debug('📏 Getting scroll info...');
      const scroll_info = await Promise.race([
        this.get_scroll_info(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]);

      // Calculate pixels above/below viewport
      pixels_above = Math.max(0, scroll_info.scroll_y);
      const viewport_bottom =
        scroll_info.scroll_y + scroll_info.viewport_height;
      pixels_below = Math.max(0, scroll_info.page_height - viewport_bottom);

      this.logger.debug('✅ Scroll info completed');
    } catch (error) {
      this.logger.warning(
        `Failed to get scroll info: ${(error as Error).message}`
      );
    }

    // Get title
    let title = 'Title unavailable';
    try {
      const titlePromise = page.title();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      );
      title = await Promise.race([titlePromise, timeoutPromise]);
    } catch (error) {
      // Keep default title
    }

    // Check for errors
    const browser_errors: string[] = [];
    if (Object.keys(content.selector_map).length === 0) {
      browser_errors.push(
        `DOM processing timed out for ${page_url} - using minimal state. Basic navigation still available.`
      );
    }

    // Check if PDF viewer
    const is_pdf_viewer = await this._is_pdf_viewer(page);

    const pendingNetworkRequests = await this._getPendingNetworkRequests(page);
    const paginationButtons = DomService.detect_pagination_buttons(
      content.selector_map
    );
    const browser_state = new BrowserStateSummary(content, {
      url: page_url,
      title,
      tabs: tabs_info,
      screenshot: screenshot_b64,
      page_info,
      pixels_above,
      pixels_below,
      browser_errors,
      is_pdf_viewer,
      loading_status: this.currentPageLoadingStatus,
      recent_events: include_recent_events
        ? this._getRecentEventsSummary()
        : null,
      pending_network_requests: pendingNetworkRequests,
      pagination_buttons: paginationButtons,
      closed_popup_messages: this._getClosedPopupMessagesSnapshot(),
    });

    this.logger.debug('✅ get_state_summary completed successfully');
    return browser_state;
  }

  /**
   * Check if a URL is a new tab page
   */
  private _is_new_tab_page(url: string): boolean {
    return (
      url === 'about:blank' ||
      url === 'about:newtab' ||
      url === 'chrome://newtab/' ||
      url === 'chrome://new-tab-page/' ||
      url === 'chrome://new-tab-page'
    );
  }

  private _is_ip_address_host(hostname: string): boolean {
    const normalized =
      hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;
    return isIP(normalized) !== 0;
  }

  private _get_domain_variants(hostname: string): [string, string] {
    const host = hostname.toLowerCase();
    if (host.startsWith('www.')) {
      return [host, host.slice(4)];
    }
    return [host, `www.${host}`];
  }

  private _setEntryMatchesUrl(
    domains: Set<string>,
    hostVariant: string,
    hostAlt: string,
    protocol: string
  ) {
    const matchedHost = domains.has(hostVariant) || domains.has(hostAlt);
    if (!matchedHost) {
      return false;
    }
    // Set-optimized entries are exact hostnames without explicit schemes,
    // so keep parity with pattern matching default: https-only.
    return protocol.toLowerCase() === 'https:';
  }

  /**
   * Check if page is displaying a PDF
   */
  private async _is_pdf_viewer(page: Page): Promise<boolean> {
    try {
      const url = page.url();
      if (url.endsWith('.pdf') || url.includes('.pdf?')) {
        return true;
      }

      // Check for PDF viewer in page content
      const is_pdf = await page.evaluate(() => {
        return (
          document.querySelector('embed[type="application/pdf"]') !== null ||
          document.querySelector('object[type="application/pdf"]') !== null
        );
      });

      return is_pdf;
    } catch (error) {
      return false;
    }
  }

  /**
   * Auto-download PDF if detected and auto-download is enabled
   */
  private async _auto_download_pdf_if_needed(
    page: Page
  ): Promise<string | null> {
    const downloadsPath = this.browser_profile.downloads_path;
    if (!downloadsPath || !this._autoDownloadPdfs) {
      return null;
    }

    try {
      const is_pdf = await this._is_pdf_viewer(page);
      if (!is_pdf) {
        return null;
      }

      const url = page.url();
      this.logger.info(`📄 PDF detected: ${url}`);

      let pdfFilename = path.basename(url.split('?')[0]);
      if (!pdfFilename || !pdfFilename.toLowerCase().endsWith('.pdf')) {
        const parsed = new URL(url);
        pdfFilename = path.basename(parsed.pathname) || 'document.pdf';
        if (!pdfFilename.toLowerCase().endsWith('.pdf')) {
          pdfFilename += '.pdf';
        }
      }

      if (
        this.downloaded_files.some(
          (downloaded) => path.basename(downloaded) === pdfFilename
        )
      ) {
        this.logger.debug(`📄 PDF already downloaded: ${pdfFilename}`);
        return null;
      }

      this.logger.info(`📄 Auto-downloading PDF from: ${url}`);
      const downloadResult = await page.evaluate(async (pdfUrl: string) => {
        try {
          const response = await fetch(pdfUrl, {
            cache: 'force-cache',
          });
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          const cacheHeader = response.headers.get('x-cache') || '';
          const fromCache =
            response.headers.has('age') ||
            cacheHeader.toLowerCase().includes('hit');

          return {
            data: Array.from(uint8Array),
            fromCache,
            responseSize: uint8Array.length,
          };
        } catch (error) {
          return {
            data: [],
            fromCache: false,
            responseSize: 0,
            error:
              error instanceof Error ? error.message : 'Unknown fetch error',
          };
        }
      }, url);

      if (downloadResult?.error) {
        this.logger.warning(
          `⚠️ Failed to auto-download PDF from ${url}: ${downloadResult.error}`
        );
        return null;
      }

      if (
        !downloadResult ||
        !Array.isArray(downloadResult.data) ||
        downloadResult.data.length === 0
      ) {
        this.logger.warning(
          `⚠️ No data received when downloading PDF from ${url}`
        );
        return null;
      }

      await fs.promises.mkdir(downloadsPath, { recursive: true });
      const uniqueFilename = await BrowserSession.get_unique_filename(
        downloadsPath,
        pdfFilename
      );
      const downloadPath = path.join(downloadsPath, uniqueFilename);

      await fs.promises.writeFile(
        downloadPath,
        Buffer.from(downloadResult.data)
      );
      this.add_downloaded_file(downloadPath);

      const cacheStatus = downloadResult.fromCache
        ? 'from cache'
        : 'from network';
      const responseSize = Number(downloadResult.responseSize || 0);
      this.logger.info(
        `📄 Auto-downloaded PDF (${cacheStatus}, ${responseSize.toLocaleString()} bytes): ${downloadPath}`
      );

      return downloadPath;
    } catch (error) {
      this.logger.debug(`PDF detection failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if an element is visible on the page
   */
  private async _is_visible(element: any): Promise<boolean> {
    try {
      const is_hidden = await element.isHidden();
      const bbox = await element.boundingBox();

      return !is_hidden && bbox !== null && bbox.width > 0 && bbox.height > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Locate an element by XPath
   */
  async get_locate_element_by_xpath(xpath: string): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      return null;
    }

    try {
      // Use XPath to locate the element
      const element_handle = await page
        .locator(`xpath=${xpath}`)
        .elementHandle();
      if (element_handle) {
        const is_visible = await this._is_visible(element_handle);
        if (is_visible) {
          await element_handle.scrollIntoViewIfNeeded({ timeout: 1000 });
        }
        return element_handle;
      }
      return null;
    } catch (error) {
      this.logger.error(
        `❌ Failed to locate xpath ${xpath}: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Locate an element by CSS selector
   */
  async get_locate_element_by_css_selector(css_selector: string): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      return null;
    }

    try {
      // Use CSS selector to locate the element
      const element_handle = await page.locator(css_selector).elementHandle();
      if (element_handle) {
        const is_visible = await this._is_visible(element_handle);
        if (is_visible) {
          await element_handle.scrollIntoViewIfNeeded({ timeout: 1000 });
        }
        return element_handle;
      }
      return null;
    } catch (error) {
      this.logger.error(
        `❌ Failed to locate element ${css_selector}: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Locate an element by text content
   * @param text - Text to search for
   * @param nth - Which matching element to return (0-based index)
   * @param element_type - Optional tag name to filter by (e.g., 'button', 'span')
   */
  async get_locate_element_by_text(
    text: string,
    nth: number = 0,
    element_type: string | null = null
  ): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      return null;
    }

    try {
      // Build selector: filter by element type and text
      const selector = element_type
        ? `${element_type}:text("${text}")`
        : `:text("${text}")`;

      // Get all matching elements
      const locator = page.locator(selector);
      const count = await locator.count();

      if (count === 0) {
        this.logger.error(`❌ No element with text '${text}' found`);
        return null;
      }

      // Filter visible elements
      const visible_elements: any[] = [];
      for (let i = 0; i < count; i++) {
        const element_handle = await locator.nth(i).elementHandle();
        if (element_handle && (await this._is_visible(element_handle))) {
          visible_elements.push(element_handle);
        }
      }

      if (visible_elements.length === 0) {
        this.logger.error(`❌ No visible element with text '${text}' found`);
        return null;
      }

      if (nth >= visible_elements.length) {
        this.logger.error(
          `❌ Element with text '${text}' not found at index #${nth}`
        );
        return null;
      }

      const element_handle = visible_elements[nth];
      const is_visible = await this._is_visible(element_handle);
      if (is_visible) {
        await element_handle.scrollIntoViewIfNeeded({ timeout: 1000 });
      }

      return element_handle;
    } catch (error) {
      this.logger.error(
        `❌ Failed to locate element by text '${text}': ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Check if browser session is connected and has valid browser/context objects
   * @param restart - If true, attempt to create a new tab if no pages exist
   */
  async is_connected(restart: boolean = true): Promise<boolean> {
    if (!this.browser_context) {
      return false;
    }

    try {
      // Check if browser is connected
      if (this.browser && !(this.browser as any).isConnected()) {
        return false;
      }

      // Check if browser context's browser is connected (context may reference a different browser object)
      const context_browser = (this.browser_context as any).browser?.();
      if (context_browser && !(context_browser as any).isConnected()) {
        return false;
      }

      // Check if context has at least one page
      const pages = this.browser_context.pages();
      if (pages.length === 0) {
        if (restart) {
          // Try to create a new page to keep context alive
          try {
            await this.browser_context.newPage();
          } catch (error) {
            return false;
          }
        } else {
          return false;
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a URL is allowed based on allowed_domains configuration
   * @param url - URL to check
   */
  private _get_url_access_denial_reason(url: string): string | null {
    // Always allow new tab pages and browser-internal pages we intentionally use.
    if (this._is_new_tab_page(url)) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'invalid_url';
    }

    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
      return null;
    }

    if (!parsed.hostname) {
      return 'missing_host';
    }
    const [hostVariant, hostAlt] = this._get_domain_variants(parsed.hostname);

    if (
      this.browser_profile.block_ip_addresses &&
      this._is_ip_address_host(parsed.hostname)
    ) {
      return 'ip_address_blocked';
    }

    const allowedDomains = this.browser_profile.allowed_domains;
    if (
      allowedDomains &&
      ((Array.isArray(allowedDomains) && allowedDomains.length > 0) ||
        (allowedDomains instanceof Set && allowedDomains.size > 0))
    ) {
      if (allowedDomains instanceof Set) {
        if (
          this._setEntryMatchesUrl(
            allowedDomains,
            hostVariant,
            hostAlt,
            parsed.protocol
          )
        ) {
          return null;
        }
      } else {
        for (const allowedDomain of allowedDomains) {
          try {
            if (match_url_with_domain_pattern(url, allowedDomain, true)) {
              return null;
            }
          } catch {
            this.logger.warning(`Invalid domain pattern: ${allowedDomain}`);
          }
        }
      }
      return 'not_in_allowed_domains';
    }

    const prohibitedDomains = this.browser_profile.prohibited_domains;
    if (
      prohibitedDomains &&
      ((Array.isArray(prohibitedDomains) && prohibitedDomains.length > 0) ||
        (prohibitedDomains instanceof Set && prohibitedDomains.size > 0))
    ) {
      if (prohibitedDomains instanceof Set) {
        if (
          this._setEntryMatchesUrl(
            prohibitedDomains,
            hostVariant,
            hostAlt,
            parsed.protocol
          )
        ) {
          return 'in_prohibited_domains';
        }
      } else {
        for (const prohibitedDomain of prohibitedDomains) {
          try {
            if (match_url_with_domain_pattern(url, prohibitedDomain, true)) {
              return 'in_prohibited_domains';
            }
          } catch {
            this.logger.warning(`Invalid domain pattern: ${prohibitedDomain}`);
          }
        }
      }
    }

    return null;
  }

  private _is_url_allowed(url: string): boolean {
    return this._get_url_access_denial_reason(url) === null;
  }

  private _formatDomainCollection(
    value: string[] | Set<string> | null | undefined
  ) {
    if (value instanceof Set) {
      return JSON.stringify(Array.from(value));
    }
    return JSON.stringify(value ?? null);
  }

  private _assert_url_allowed(url: string) {
    const denialReason = this._get_url_access_denial_reason(url);
    if (!denialReason) {
      return;
    }
    this._recordRecentEvent('navigation_blocked', {
      url,
      error_message: denialReason,
    });

    if (denialReason === 'not_in_allowed_domains') {
      throw new URLNotAllowedError(
        `URL ${url} is not in allowed_domains. Current allowed_domains: ${this._formatDomainCollection(
          this.browser_profile.allowed_domains
        )}`
      );
    }

    if (denialReason === 'in_prohibited_domains') {
      throw new URLNotAllowedError(
        `URL ${url} is blocked by prohibited_domains. Current prohibited_domains: ${this._formatDomainCollection(
          this.browser_profile.prohibited_domains
        )}`
      );
    }

    if (denialReason === 'ip_address_blocked') {
      throw new URLNotAllowedError(
        `URL ${url} is blocked because block_ip_addresses=true`
      );
    }

    throw new URLNotAllowedError(`URL ${url} is not allowed (${denialReason})`);
  }

  /**
   * Navigate helper with URL validation
   */
  async navigate(url: string): Promise<void> {
    this._assert_url_allowed(url);
    await this.navigate_to(url);
  }

  /**
   * Kill the browser session (force close even if keep_alive=true)
   */
  async kill(): Promise<void> {
    this.logger.info('💀 Force killing browser session...');

    // Temporarily disable keep_alive to ensure browser closes
    const original_keep_alive = this.browser_profile.keep_alive;
    this.browser_profile.keep_alive = false;

    try {
      await this.close();
    } finally {
      // Restore original keep_alive setting
      this.browser_profile.keep_alive = original_keep_alive;
    }
  }

  /**
   * Alias for close() to match Python API
   */
  async stop(): Promise<void> {
    if (this.browser_profile.keep_alive) {
      this.logger.info(
        '🕊️ BrowserSession.stop() called but keep_alive=true, leaving browser running. Use .kill() to force close.'
      );
      return;
    }

    if (this._stoppingPromise) {
      await this._stoppingPromise;
      return;
    }

    const hasActiveResources =
      this.initialized ||
      Boolean(
        this.browser ||
        this.browser_context ||
        this.browser_pid ||
        this._subprocess ||
        this._childProcesses.size > 0
      );
    if (!hasActiveResources) {
      return;
    }

    this._stoppingPromise = Promise.resolve().then(async () => {
      await this.event_bus.dispatch(new BrowserStopEvent());
      await this._shutdown_browser_session();
    });

    try {
      await this._stoppingPromise;
      this._recordRecentEvent('browser_stopped');
      await this.event_bus.dispatch(new BrowserStoppedEvent());
    } finally {
      this.detach_all_watchdogs();
      await this.event_bus.stop();
      this._stoppingPromise = null;
    }
  }

  /**
   * Perform a click action with download and navigation handling
   * @param element_node - DOM element to click
   */
  async perform_click(element_node: DOMElementNode): Promise<string | null> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No current page available');
    }

    const element_handle = await this.get_locate_element(element_node);
    if (!element_handle) {
      throw new Error(`Element not found: ${JSON.stringify(element_node)}`);
    }

    // Check if downloads are enabled
    const downloads_path = this.browser_profile.downloads_path;
    if (downloads_path) {
      fs.mkdirSync(downloads_path, { recursive: true });

      // Try to detect file download.
      const download_promise = page.waitForEvent('download', {
        timeout: 5000,
      });

      // Click failures should bubble to the caller.
      try {
        await element_handle.click();
      } catch (error) {
        void download_promise.catch(() => undefined);
        throw error;
      }

      let download: any;
      try {
        download = await download_promise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isDownloadTimeout =
          error instanceof Error &&
          (error.name === 'TimeoutError' ||
            message.toLowerCase().includes('timeout'));
        if (!isDownloadTimeout) {
          throw error;
        }
        this.logger.debug(
          'No download triggered within timeout. Checking navigation...'
        );
        try {
          await page.waitForLoadState();
        } catch (e) {
          this.logger.warning(
            `Navigation check failed: ${(e as Error).message}`
          );
        }
        return null;
      }

      // Save the downloaded file.
      const suggested_filename = download.suggestedFilename();
      const unique_filename = await BrowserSession.get_unique_filename(
        downloads_path,
        suggested_filename
      );
      const download_path = path.join(downloads_path, unique_filename);
      const download_guid = uuid7str();
      const download_url =
        typeof download.url === 'function'
          ? download.url()
          : (this.currentUrl ?? '');
      await this.event_bus.dispatch(
        new DownloadStartedEvent({
          guid: download_guid,
          url: download_url,
          suggested_filename,
          auto_download: false,
        })
      );

      await download.saveAs(download_path);
      this.logger.info(`⬇️ Downloaded file to: ${download_path}`);
      const stats = fs.existsSync(download_path)
        ? fs.statSync(download_path)
        : null;
      await this.event_bus.dispatch(
        new DownloadProgressEvent({
          guid: download_guid,
          received_bytes: stats?.size ?? 0,
          total_bytes: stats?.size ?? 0,
          state: 'completed',
        })
      );

      const fileDownloadedResult = await this.event_bus.dispatch(
        new FileDownloadedEvent({
          guid: download_guid,
          url: download_url,
          path: download_path,
          file_name: unique_filename,
          file_size: stats?.size ?? 0,
          file_type: path.extname(unique_filename).replace('.', '') || null,
          mime_type: null,
          auto_download: false,
        })
      );
      if (fileDownloadedResult.handler_results.length === 0) {
        this.add_downloaded_file(download_path);
      }

      return download_path;
    } else {
      // No downloads path configured, just click
      await element_handle.click();
    }

    return null;
  }

  /**
   * Remove all highlights from the current page
   */
  async remove_highlights(): Promise<void> {
    const page = await this.get_current_page();
    if (!page) {
      return;
    }

    try {
      await page.evaluate(() => {
        const pageWindow = window as Window & {
          _highlightCleanupFunctions?: Array<() => void>;
        };

        const cleanupFunctions = Array.isArray(
          pageWindow._highlightCleanupFunctions
        )
          ? pageWindow._highlightCleanupFunctions
          : [];

        for (const cleanupFn of cleanupFunctions) {
          try {
            if (typeof cleanupFn === 'function') {
              cleanupFn();
            }
          } catch {
            // Ignore callback cleanup failures.
          }
        }
        pageWindow._highlightCleanupFunctions = [];

        const containers = document.querySelectorAll(
          '#playwright-highlight-container'
        );
        containers.forEach((element) => element.remove());

        const labels = document.querySelectorAll('.playwright-highlight-label');
        labels.forEach((element) => element.remove());

        // Backward compatibility with legacy selectors.
        const highlights = document.querySelectorAll('.browser-use-highlight');
        highlights.forEach((element) => element.remove());
        const styled = document.querySelectorAll('[style*="browser-use"]');
        styled.forEach((element: any) => {
          if (element.style) {
            element.style.outline = '';
            element.style.border = '';
          }
        });
      });
    } catch (error) {
      this.logger.debug(
        `Failed to remove highlights: ${(error as Error).message}`
      );
    }
  }

  // region - Trace Recording

  /**
   * Start tracing on browser context if traces_dir is configured
   * Note: Currently optional as it may cause performance issues in some cases
   */
  async start_trace_recording(): Promise<void> {
    await this._startContextTracing();
  }

  /**
   * Save browser trace recording if active
   */
  async save_trace_recording(): Promise<void> {
    await this._saveTraceRecording();
  }

  /**
   * Start tracing on browser context if traces_dir is configured
   * Note: Currently optional as it may cause performance issues in some cases
   */
  private async _startContextTracing(): Promise<void> {
    if (this.browser_profile.traces_dir && this.browser_context) {
      try {
        this.logger.debug(
          `📽️ Starting tracing (will save to: ${this.browser_profile.traces_dir})`
        );
        await this.browser_context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false, // Reduce trace size
        });
      } catch (error) {
        this.logger.warning(
          `Failed to start tracing: ${(error as Error).message}`
        );
        throw error;
      }
    }
  }

  /**
   * Save browser trace recording
   */
  private async _saveTraceRecording(): Promise<void> {
    if (this.browser_profile.traces_dir && this.browser_context) {
      try {
        const tracesPath = this.browser_profile.traces_dir;
        let finalTracePath: string;

        // Check if path has extension
        if (path.extname(tracesPath)) {
          // Path has extension, use as-is (user specified exact file path)
          finalTracePath = tracesPath;
        } else {
          // Path has no extension, treat as directory and create filename
          const traceFilename = `BrowserSession_${this.id}.zip`;
          finalTracePath = path.join(tracesPath, traceFilename);
        }

        this.logger.info(
          `🎥 Saving browser_context trace to ${finalTracePath}...`
        );
        await this.browser_context.tracing.stop({ path: finalTracePath });
      } catch (error) {
        this.logger.warning(
          `Failed to save trace recording: ${(error as Error).message}`
        );
        throw error;
      }
    }
  }

  // endregion

  // region - CDP Advanced Integration

  /**
   * Scroll using CDP Input.synthesizeScrollGesture for universal compatibility
   * @param page - The page to scroll
   * @param pixels - Number of pixels to scroll (positive = up, negative = down)
   * @returns true if successful, false if failed
   */
  private async _scrollWithCdpGesture(
    page: Page,
    pixels: number
  ): Promise<boolean> {
    try {
      // Use CDP to synthesize scroll gesture - works in all contexts including PDFs
      const cdpSession = await this.get_or_create_cdp_session(page);

      // Get viewport center for scroll origin
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const centerX = Math.floor(viewport.width / 2);
      const centerY = Math.floor(viewport.height / 2);

      await cdpSession.send('Input.synthesizeScrollGesture', {
        x: centerX,
        y: centerY,
        xDistance: 0,
        yDistance: -pixels, // Negative = scroll down, Positive = scroll up
        gestureSourceType: 'mouse', // Use mouse gestures for better compatibility
        speed: 3000, // Pixels per second
      });

      try {
        await Promise.race([
          cdpSession.detach(),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore detach errors
      }

      this.logger.debug(
        `📄 Scrolled via CDP Input.synthesizeScrollGesture: ${pixels}px`
      );
      return true;
    } catch (error) {
      this.logger.warning(
        `❌ Scrolling via CDP Input.synthesizeScrollGesture failed: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Scroll the current page container
   * @param pixels - Number of pixels to scroll (positive = up, negative = down)
   */
  private async _scrollContainer(pixels: number): Promise<void> {
    const page = await this.getCurrentPage();
    if (!page) {
      throw new Error('No active page available for scrolling');
    }

    // Try CDP scroll gesture first (works universally including PDFs)
    if (await this._scrollWithCdpGesture(page, pixels)) {
      return;
    }

    // Fallback to JavaScript for older browsers or when CDP fails
    this.logger.debug('Falling back to JavaScript scrolling');
    const SMART_SCROLL_JS = `(dy) => {
			const bigEnough = el => el.clientHeight >= window.innerHeight * 0.5;
			const canScroll = el =>
				el &&
				/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) &&
				el.scrollHeight > el.clientHeight &&
				bigEnough(el);

			let el = document.activeElement;
			while (el && !canScroll(el) && el !== document.body) el = el.parentElement;

			el = canScroll(el)
					? el
					: [...document.querySelectorAll('*')].find(canScroll)
					|| document.scrollingElement
					|| document.documentElement;

			if (el === document.scrollingElement ||
				el === document.documentElement ||
				el === document.body) {
				window.scrollBy(0, dy);
			} else {
				el.scrollBy(0, dy);
			}
		}`;

    await page.evaluate(SMART_SCROLL_JS, pixels);
  }

  /**
   * Compute hashes for all clickable elements in the selector map
   * @param selectorMap - Selector map from DOM state
   * @returns Set of element hashes
   */
  private _computeElementHashes(selectorMap: SelectorMap): Set<string> {
    const hashes = new Set<string>();

    for (const [index, element] of Object.entries(selectorMap)) {
      if (element instanceof DOMElementNode) {
        // Create hash from element's xpath and key attributes
        const hashParts = [
          element.xpath || '',
          element.tag_name || '',
          JSON.stringify(element.attributes || {}),
        ];
        const hash = hashParts.join('|');
        hashes.add(hash);
      }
    }

    return hashes;
  }

  /**
   * Mark elements in the selector map as new if they weren't in the cached hashes
   * @param selectorMap - Selector map to update
   * @param cachedHashes - Previously cached element hashes
   */
  private _markNewElements(
    selectorMap: SelectorMap,
    cachedHashes: Set<string>
  ): void {
    for (const [index, element] of Object.entries(selectorMap)) {
      if (element instanceof DOMElementNode) {
        // Create hash for current element
        const hashParts = [
          element.xpath || '',
          element.tag_name || '',
          JSON.stringify(element.attributes || {}),
        ];
        const hash = hashParts.join('|');

        // Mark as new if not in cached hashes
        if (!cachedHashes.has(hash)) {
          // Add a marker to the element's attributes to indicate it's new
          element.attributes = element.attributes || {};
          (element.attributes as any)['__browser_use_new_element'] = true;
        }
      }
    }
  }

  /**
   * Helper to get a safe method name from the calling context
   * Used for recovery error messages
   */
  private _getCurrentMethodName(): string {
    try {
      const stack = new Error().stack;
      if (!stack) return 'unknown';

      const lines = stack.split('\n');
      // Skip first 3 lines: Error, this method, and the caller
      const callerLine = lines[3] || '';
      const match = callerLine.match(/at (?:BrowserSession\.)?(\w+)/);
      return match ? match[1] : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get current page with fallback logic
   * Alias for compatibility with Python API
   */
  async getCurrentPage(): Promise<Page | null> {
    return await this.get_current_page();
  }

  /**
   * Log warning about unsafe glob patterns
   * @param pattern - The glob pattern being used
   */
  private _logGlobWarning(pattern: string): void {
    const unsafePatterns = [
      '**/*',
      '**/.*',
      '~/*',
      '/etc/*',
      '/sys/*',
      '/proc/*',
    ];
    const isUnsafe = unsafePatterns.some(
      (unsafe) =>
        pattern.includes(unsafe) ||
        pattern.startsWith(unsafe.replace('**/', ''))
    );

    if (isUnsafe) {
      this.logger.warning(
        `⚠️ Potentially unsafe glob pattern detected: "${pattern}". ` +
          `This could access system files or expose sensitive data.`
      );
    }
  }

  /**
   * Create a shallow copy of the browser session
   * Note: This doesn't copy the actual browser instance, just the session metadata
   * @returns A new BrowserSession instance with copied state
   */
  modelCopy(): BrowserSession {
    const copy = new BrowserSession({
      id: this.id,
      browser_profile: this.browser_profile,
      browser: this.browser,
      browser_context: this.browser_context,
      page: this.agent_current_page,
      title: this.currentTitle,
      url: this.currentUrl,
      wss_url: this.wss_url,
      cdp_url: this.cdp_url,
      browser_pid: this.browser_pid,
      playwright: this.playwright,
      downloaded_files: [...this.downloaded_files],
      closed_popup_messages: [...this._closedPopupMessages],
    });
    copy.llm_screenshot_size = this.llm_screenshot_size
      ? [...this.llm_screenshot_size]
      : null;
    copy._original_viewport_size = this._original_viewport_size
      ? [...this._original_viewport_size]
      : null;
    return copy;
  }

  model_copy(): BrowserSession {
    return this.modelCopy();
  }

  // endregion

  // region - Page Health Check and Recovery

  private _inRecovery = false;

  /**
   * Check if a page is responsive by trying to evaluate simple JavaScript
   * @param page - The page to check
   * @param timeout - Timeout in seconds (default: 5.0)
   * @returns true if page is responsive, false otherwise
   */
  private async _isPageResponsive(
    page: Page,
    timeout: number = 5.0
  ): Promise<boolean> {
    try {
      const timeoutMs = timeout * 1000;
      await Promise.race([
        page.evaluate('1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        ),
      ]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Force close a crashed page using CDP from a clean temporary page
   * @param pageUrl - The URL of the page to force close
   * @returns true if successful, false otherwise
   */
  private async _forceClosePageViaCdp(pageUrl: string): Promise<boolean> {
    try {
      if (!this.browser_context) {
        throw new Error('Browser context is not set up yet');
      }

      // Create a clean page for CDP operations
      const tempPage = await Promise.race([
        this.browser_context.newPage(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timeout creating temp page')),
            5000
          )
        ),
      ]);

      await Promise.race([
        tempPage.goto('about:blank'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timeout navigating to blank')),
            2000
          )
        ),
      ]);

      try {
        // Create CDP session from the clean page
        const cdpSession = await Promise.race([
          this.get_or_create_cdp_session(tempPage),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout creating CDP session')),
              5000
            )
          ),
        ]);

        try {
          // Get all browser targets
          const targets = (await Promise.race([
            cdpSession.send('Target.getTargets'),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Timeout getting targets')),
                2000
              )
            ),
          ])) as any;

          // Find the crashed page target
          let blockedTargetId: string | null = null;
          const targetInfos = targets.targetInfos || [];
          for (const target of targetInfos) {
            if (target.type === 'page' && target.url === pageUrl) {
              blockedTargetId = target.targetId;
              break;
            }
          }

          if (blockedTargetId) {
            // Force close the target
            this.logger.warning(
              `🪓 Force-closing crashed page target_id=${blockedTargetId} via CDP: ${pageUrl.substring(0, 50)}...`
            );
            await Promise.race([
              cdpSession.send('Target.closeTarget', {
                targetId: blockedTargetId,
              }),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('Timeout closing target')),
                  2000
                )
              ),
            ]);
            return true;
          } else {
            this.logger.debug(
              `❌ Could not find CDP page target_id to force-close: ${pageUrl.substring(0, 50)} (concurrency issues?)`
            );
            return false;
          }
        } finally {
          try {
            await Promise.race([
              cdpSession.detach(),
              new Promise<void>((resolve) => setTimeout(resolve, 1000)),
            ]);
          } catch {
            // Ignore detach errors
          }
        }
      } finally {
        await tempPage.close();
      }
    } catch (error) {
      this.logger.error(
        `❌ Using raw CDP to force-close crashed page failed: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Try to reopen a URL in a new page and check if it's responsive
   * @param url - The URL to reopen
   * @param timeoutMs - Navigation timeout in milliseconds
   * @returns true if successful and responsive, false otherwise
   */
  private async _tryReopenUrl(
    url: string,
    timeoutMs?: number
  ): Promise<boolean> {
    if (
      !url ||
      url.startsWith('about:') ||
      url.startsWith('chrome://') ||
      url.startsWith('edge://')
    ) {
      return false;
    }

    const timeout =
      timeoutMs || this.browser_profile.default_navigation_timeout || 6000;

    try {
      this.logger.debug(
        `🔄 Attempting to reload URL that crashed: ${url.substring(0, 50)}`
      );

      if (!this.browser_context) {
        throw new Error('Browser context is not set');
      }

      // Create new page directly to avoid circular dependency
      const newPage = await this.browser_context.newPage();
      this.agent_current_page = newPage;

      // Update human tab reference if there is no human tab yet
      if (!this.human_current_page || this.human_current_page.isClosed()) {
        this.human_current_page = newPage;
      }

      // Set viewport for new tab
      if (this.browser_profile.window_size) {
        await newPage.setViewportSize(this.browser_profile.window_size);
      }

      // Navigate with timeout
      try {
        await Promise.race([
          newPage.goto(url, { waitUntil: 'load', timeout }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Navigation timeout')),
              timeout + 500
            )
          ),
        ]);
      } catch (error) {
        this.logger.debug(
          `⚠️ Attempting to reload previously crashed URL ${url.substring(0, 50)} failed again: ${(error as Error).name}`
        );
      }

      // Wait a bit for any transient blocking to resolve
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if the reopened page is responsive
      const isResponsive = await this._isPageResponsive(newPage, 2.0);

      if (isResponsive) {
        this.logger.info(
          `✅ Page recovered and is now responsive after reopening on: ${url.substring(0, 50)}`
        );
        return true;
      } else {
        this.logger.warning(
          `⚠️ Reopened page ${url.substring(0, 50)} is still unresponsive`
        );
        // Close the unresponsive page before returning
        try {
          await this._forceClosePageViaCdp(newPage.url());
        } catch (error) {
          this.logger.error(
            `❌ Failed to close crashed page ${url.substring(0, 50)} via CDP: ${(error as Error).message} (something is very wrong or system is extremely overloaded)`
          );
        }
        this.agent_current_page = null; // Clear reference to closed page
        return false;
      }
    } catch (error) {
      this.logger.error(
        `❌ Retrying crashed page ${url.substring(0, 50)} failed: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Create a new blank page as a fallback when recovery fails
   * @param url - The original URL that failed
   */
  private async _createBlankFallbackPage(url: string): Promise<void> {
    this.logger.warning(
      `⚠️ Resetting to about:blank as fallback because browser is unable to load the original URL without crashing: ${url.substring(0, 50)}`
    );

    // Close any existing broken page
    if (this.agent_current_page && !this.agent_current_page.isClosed()) {
      try {
        await this.agent_current_page.close();
      } catch {
        // Ignore close errors
      }
    }

    if (!this.browser_context) {
      throw new Error('Browser context is not set');
    }

    // Create fresh page directly (avoid decorated methods to prevent circular dependency)
    const newPage = await this.browser_context.newPage();
    this.agent_current_page = newPage;

    // Update human tab reference if there is no human tab yet
    if (!this.human_current_page || this.human_current_page.isClosed()) {
      this.human_current_page = newPage;
    }

    // Set viewport for new tab
    if (this.browser_profile.window_size) {
      await newPage.setViewportSize(this.browser_profile.window_size);
    }

    // Navigate to blank
    try {
      await newPage.goto('about:blank', { waitUntil: 'load', timeout: 5000 });
    } catch (error) {
      this.logger.error(
        `❌ Failed to navigate to about:blank: ${(error as Error).message} (something is very wrong or system is extremely overloaded)`
      );
      throw error;
    }

    // Verify it's responsive
    if (!(await this._isPageResponsive(newPage, 1.0))) {
      throw new BrowserError(
        'Browser is unable to load any new about:blank pages (something is very wrong or browser is extremely overloaded)'
      );
    }
  }

  /**
   * Recover from an unresponsive page by closing and reopening it
   * @param callingMethod - The name of the method that detected the unresponsive page
   * @param timeoutMs - Navigation timeout in milliseconds
   */
  private async _recoverUnresponsivePage(
    callingMethod: string,
    timeoutMs?: number
  ): Promise<void> {
    this.logger.warning(
      `⚠️ Page JS engine became unresponsive in ${callingMethod}(), attempting recovery...`
    );
    const timeout = Math.min(
      3000,
      timeoutMs || this.browser_profile.default_navigation_timeout || 5000
    );

    // Check if browser connection is still alive
    if (this.browser && !this.browser.isConnected()) {
      this.logger.error(
        '❌ Browser connection lost - browser process may have crashed'
      );
      throw new Error(
        'Browser connection lost - cannot recover unresponsive page'
      );
    }

    // Prevent re-entrance
    if (this._inRecovery) {
      this.logger.debug(
        'Already in recovery, skipping nested recovery attempt'
      );
      return;
    }

    this._inRecovery = true;
    try {
      // Get current URL before recovery
      if (!this.agent_current_page) {
        throw new Error('Agent current page is not set');
      }
      const currentUrl = this.agent_current_page.url();

      // Clear page references
      const blockedPage = this.agent_current_page;
      this.agent_current_page = null;
      if (blockedPage === this.human_current_page) {
        this.human_current_page = null;
      }

      // Force-close the crashed page via CDP
      this.logger.debug(
        '🪓 Page Recovery Step 1/3: Force-closing crashed page via CDP...'
      );
      await this._forceClosePageViaCdp(currentUrl);

      // Remove the closed page from browser_context.pages by forcing a refresh
      if (this.browser_context && this.browser_context.pages()) {
        for (const page of this.browser_context.pages().slice()) {
          const pageUrl = page.url();
          if (
            pageUrl === currentUrl &&
            !page.isClosed() &&
            !pageUrl.startsWith('about:') &&
            !pageUrl.startsWith('chrome://') &&
            !pageUrl.startsWith('edge://')
          ) {
            try {
              await page.close();
              this.logger.debug(
                `🪓 Closed page because it has a known crash-causing URL: ${pageUrl.substring(0, 50)}`
              );
            } catch {
              // Page might already be closed via CDP
            }
          }
        }
      }

      // Try to reopen the URL (in case blocking was transient)
      this.logger.debug(
        '🍼 Page Recovery Step 2/3: Trying to reopen the URL again...'
      );
      if (await this._tryReopenUrl(currentUrl, timeout)) {
        this.logger.debug(
          '✅ Page Recovery Step 3/3: Page loading succeeded after 2nd attempt!'
        );
        return; // Success!
      }

      // If that failed, fall back to blank page
      this.logger.debug(
        '❌ Page Recovery Step 3/3: Loading the page a 2nd time failed as well, browser seems unable to load this URL without getting stuck, retreating to a safe page...'
      );
      await this._createBlankFallbackPage(currentUrl);
    } finally {
      // Always clear recovery flag
      this._inRecovery = false;
    }
  }

  // endregion

  // region - Enhanced CSS Selector Generation

  /**
   * Generate enhanced CSS selector for an element
   * Handles special characters and provides fallback strategies
   * @param xpath - XPath of the element
   * @param element - Optional element node for additional context
   * @returns Enhanced CSS selector string
   */
  private _enhancedCssSelectorForElement(
    xpath: string,
    element?: DOMElementNode
  ): string {
    // Try to convert XPath to CSS selector
    const cssSelector = this._xpathToCss(xpath);

    if (cssSelector) {
      return cssSelector;
    }

    // Fallback: use element attributes if available
    if (element) {
      const selectors: string[] = [];

      // Try ID first (most specific)
      if (element.attributes?.id) {
        const id = this._escapeSelector(element.attributes.id as string);
        selectors.push(`#${id}`);
      }

      // Try class names
      if (element.attributes?.class) {
        const classes = (element.attributes.class as string)
          .split(/\s+/)
          .filter((c) => c.length > 0)
          .map((c) => `.${this._escapeSelector(c)}`)
          .join('');
        if (classes) {
          selectors.push(`${element.tag_name}${classes}`);
        }
      }

      // Try name attribute
      if (element.attributes?.name) {
        const name = this._escapeSelector(element.attributes.name as string);
        selectors.push(`${element.tag_name}[name="${name}"]`);
      }

      // Try data attributes
      for (const [key, value] of Object.entries(element.attributes || {})) {
        if (key.startsWith('data-')) {
          const escaped = this._escapeSelector(String(value));
          selectors.push(`${element.tag_name}[${key}="${escaped}"]`);
        }
      }

      if (selectors.length > 0) {
        return selectors[0];
      }

      // Last resort: just the tag name
      return element.tag_name || 'div';
    }

    // Ultimate fallback
    return 'body';
  }

  /**
   * Convert XPath to CSS selector
   * Handles simple XPath expressions
   */
  private _xpathToCss(xpath: string): string | null {
    try {
      // Remove leading slashes
      let path = xpath.replace(/^\/+/, '');

      // Handle simple cases like /html/body/div[1]/span[2]
      const parts = path.split('/');
      const cssparts: string[] = [];

      for (const part of parts) {
        // Extract tag and index: div[1] -> {tag: 'div', index: 1}
        const match = part.match(/^([a-zA-Z0-9_-]+)(?:\[(\d+)\])?$/);
        if (match) {
          const [, tag, index] = match;
          if (index) {
            // CSS uses nth-of-type (1-indexed like XPath)
            cssparts.push(`${tag}:nth-of-type(${index})`);
          } else {
            cssparts.push(tag);
          }
        } else {
          // Complex XPath, can't convert
          return null;
        }
      }

      return cssparts.join(' > ');
    } catch {
      return null;
    }
  }

  /**
   * Escape special characters in CSS selectors
   * Handles characters that need escaping in CSS
   */
  private _escapeSelector(selector: string): string {
    // Escape special CSS characters
    return selector.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&');
  }

  // endregion

  // region - User Data Directory Management

  /**
   * Prepare user data directory for browser profile
   * Handles singleton lock conflicts and creates temp profiles if needed
   */
  async prepareUserDataDir(userDataDir?: string): Promise<string> {
    if (!userDataDir) {
      // Use profile's user data dir or create temp one
      userDataDir =
        this.browser_profile.user_data_dir ||
        (await this._createTempUserDataDir());
    }

    // Check for singleton lock conflicts
    const hasConflict = await this._checkForSingletonLockConflict(userDataDir);
    if (hasConflict) {
      this.logger.warning(
        `Singleton lock detected in ${userDataDir}, falling back to temp profile`
      );
      userDataDir = await this._fallbackToTempProfile();
    }

    // Ensure directory exists
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      this.logger.debug(`Created user data directory: ${userDataDir}`);
    }

    return userDataDir;
  }

  /**
   * Check if user data directory has a singleton lock
   * This happens when another Chrome instance is using the profile
   */
  private async _checkForSingletonLockConflict(
    userDataDir: string
  ): Promise<boolean> {
    try {
      const singletonLockFile = path.join(userDataDir, 'SingletonLock');
      const singletonSocketFile = path.join(userDataDir, 'SingletonSocket');
      const singletonCookieFile = path.join(userDataDir, 'SingletonCookie');

      // Check if any singleton lock files exist
      if (
        fs.existsSync(singletonLockFile) ||
        fs.existsSync(singletonSocketFile) ||
        fs.existsSync(singletonCookieFile)
      ) {
        // Try to detect if process is still alive (Unix-like systems)
        if (process.platform !== 'win32' && fs.existsSync(singletonLockFile)) {
          try {
            // Try to read the lock file to get PID
            const lockContent = fs.readFileSync(singletonLockFile, 'utf-8');
            const pidMatch = lockContent.match(/(\d+)/);
            if (pidMatch) {
              const pid = parseInt(pidMatch[1], 10);
              try {
                // Check if process exists (signal 0 doesn't kill, just checks)
                process.kill(pid, 0);
                return true; // Process exists, lock is valid
              } catch {
                // Process doesn't exist, stale lock
                this.logger.debug(`Stale singleton lock detected, removing`);
                fs.unlinkSync(singletonLockFile);
                return false;
              }
            }
          } catch {
            // Couldn't read lock file
          }
        }
        return true;
      }
      return false;
    } catch (error) {
      this.logger.debug(
        `Error checking singleton lock: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Fallback to a temporary profile when the primary one is locked
   */
  private async _fallbackToTempProfile(): Promise<string> {
    const tempDir = await this._createTempUserDataDir();
    this.logger.info(`Using temporary profile: ${tempDir}`);
    return tempDir;
  }

  /**
   * Create a temporary user data directory
   */
  private async _createTempUserDataDir(): Promise<string> {
    const osTempDir = os.tmpdir();
    const tempDir = path.join(
      osTempDir,
      `browser-use-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
  }

  // endregion

  // region - Page Visibility Listeners

  /**
   * Setup listeners for page visibility changes
   * Tracks when user switches tabs to update human_current_page
   */
  private async _setupCurrentPageChangeListeners(): Promise<void> {
    if (!this.browser_context) {
      return;
    }

    // Listen for page events to track which page the user is viewing
    this.browser_context.on?.('page', (page: Page) => {
      this.logger.debug(`New page created: ${page.url?.() || 'about:blank'}`);

      // Note: 'visibilitychange' is not a standard Playwright page event
      // Visibility tracking would need to be implemented differently
      // (e.g., through page.evaluate polling or browser context events)

      // Track new page
      if (page.url && !page.url().startsWith('about:')) {
        this.human_current_page = page;
      }
    });
  }

  /**
   * Callback when tab visibility changes
   * Updates human_current_page to reflect which tab the user is viewing
   */
  private _onTabVisibilityChange(page: Page): void {
    try {
      // Check if page is visible
      page
        .evaluate?.(() => document.visibilityState === 'visible')
        .then((isVisible: boolean) => {
          if (isVisible) {
            this.logger.debug(
              `Tab became visible: ${page.url?.() || 'unknown'}`
            );
            this.human_current_page = page;
          }
        })
        .catch(() => {
          // Ignore errors from closed pages
        });
    } catch {
      // Ignore errors
    }
  }

  // endregion

  // region - Process Management

  /**
   * Normalize pid values before issuing process operations.
   */
  private _normalizePid(pid: unknown): number | null {
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
      this.logger.debug(
        `Skipping process operation for invalid pid: ${String(pid)}`
      );
      return null;
    }
    return pid as number;
  }

  /**
   * Kill all child processes spawned by this browser session
   */
  private async _killChildProcesses(): Promise<void> {
    if (this._childProcesses.size === 0) {
      return;
    }

    this.logger.debug(`Killing ${this._childProcesses.size} child processes`);

    for (const trackedPid of this._childProcesses) {
      const pid = this._normalizePid(trackedPid);
      if (!pid) {
        continue;
      }

      try {
        process.kill(pid, 'SIGTERM');
        this.logger.debug(`Sent SIGTERM to process ${pid}`);

        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
          this.logger.debug(`Sent SIGKILL to process ${pid}`);
        } catch {
          // Process is dead, ignore
        }
      } catch (error) {
        this.logger.debug(
          `Could not kill process ${pid}: ${(error as Error).message}`
        );
      }
    }

    this._childProcesses.clear();
  }

  /**
   * Terminate the browser process and all its children
   */
  private async _terminateBrowserProcess(): Promise<void> {
    const browserPid = this._normalizePid(this.browser_pid);
    if (!browserPid) {
      return;
    }

    try {
      this.logger.debug(`Terminating browser process ${browserPid}`);

      if (process.platform === 'win32') {
        await execFileAsync('taskkill', [
          '/PID',
          String(browserPid),
          '/T',
          '/F',
        ]).catch(() => {
          // Ignore errors if process already dead
        });
      } else {
        try {
          process.kill(-browserPid, 'SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 1000));

          try {
            process.kill(-browserPid, 0);
            process.kill(-browserPid, 'SIGKILL');
          } catch {
            // Process is dead
          }
        } catch {
          try {
            process.kill(browserPid, 'SIGTERM');
            await new Promise((resolve) => setTimeout(resolve, 1000));
            process.kill(browserPid, 'SIGKILL');
          } catch {
            // Process doesn't exist
          }
        }
      }
    } catch (error) {
      this.logger.debug(
        `Error terminating browser process: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get child processes of a given PID
   * Cross-platform implementation using ps on Unix-like systems and WMIC on Windows
   */
  private async _getChildProcesses(pid: number): Promise<number[]> {
    const normalizedPid = this._normalizePid(pid);
    if (!normalizedPid) {
      return [];
    }

    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('wmic', [
          'process',
          'where',
          `ParentProcessId=${normalizedPid}`,
          'get',
          'ProcessId',
        ]);
        const pids = stdout
          .split('\n')
          .slice(1)
          .map((line) => parseInt(line.trim(), 10))
          .filter((p) => Number.isFinite(p));
        return pids;
      }

      const { stdout } = await execFileAsync('ps', [
        '-o',
        'pid=',
        '--ppid',
        String(normalizedPid),
      ]);
      const pids = stdout
        .split('\n')
        .map((line) => parseInt(line.trim(), 10))
        .filter((p) => Number.isFinite(p));
      return pids;
    } catch {
      return [];
    }
  }

  /**
   * Track a child process
   */
  private _trackChildProcess(pid: number): void {
    const normalizedPid = this._normalizePid(pid);
    if (normalizedPid) {
      this._childProcesses.add(normalizedPid);
    }
  }

  /**
   * Untrack a child process
   */
  private _untrackChildProcess(pid: number): void {
    const normalizedPid = this._normalizePid(pid);
    if (normalizedPid) {
      this._childProcesses.delete(normalizedPid);
    }
  }

  // region: Loading Animations

  /**
   * Show DVD screensaver loading animation
   * Returns a function to stop the animation
   *
   * @param message - Message to display (default: 'Loading...')
   * @param fps - Frames per second (default: 10)
   * @returns Function to stop the animation
   *
   * @example
   * const stopAnimation = this._showDvdScreensaverLoadingAnimation('Loading page...');
   * await someLongOperation();
   * stopAnimation();
   */
  _showDvdScreensaverLoadingAnimation(
    message: string = 'Loading...',
    fps: number = 10
  ): () => void {
    return showDVDScreensaver(message, fps);
  }

  /**
   * Show simple spinner loading animation
   * Returns a function to stop the animation
   *
   * @param message - Message to display (default: 'Loading...')
   * @param fps - Frames per second (default: 10)
   * @returns Function to stop the animation
   *
   * @example
   * const stopSpinner = this._showSpinnerLoadingAnimation('Processing...');
   * await someLongOperation();
   * stopSpinner();
   */
  _showSpinnerLoadingAnimation(
    message: string = 'Loading...',
    fps: number = 10
  ): () => void {
    return showSpinner(message, fps);
  }

  /**
   * Execute an async operation with DVD screensaver animation
   *
   * @param operation - Async operation to execute
   * @param message - Message to display during operation
   * @returns Result of the operation
   *
   * @example
   * const page = await this._withDvdScreensaver(
   *   async () => await this.browser_context!.newPage(),
   *   'Opening new page...'
   * );
   */
  async _withDvdScreensaver<T>(
    operation: () => Promise<T>,
    message: string = 'Loading...'
  ): Promise<T> {
    return withDVDScreensaver(operation, message);
  }

  // endregion: Loading Animations

  // endregion
}

export { DEFAULT_BROWSER_PROFILE };
