#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { BrowserSession, systemChrome } from '../browser/session.js';
import { CloudBrowserClient } from '../browser/cloud/cloud.js';
import {
  discoverLocalCdpWebSocketUrl,
  readDevToolsActivePort,
} from '../browser/cdp-discovery.js';
import { readBoundedPageTitle } from '../browser/state-limits.js';
import {
  extractBoundedPageHtml,
  MAX_MAIN_PAGE_HTML_CHARS,
  MAX_PAGE_HTML_SELECTOR_CHARS,
} from '../browser/page-content.js';
import { isMainModule } from '../entrypoint.js';
import {
  getProcessCommandLine,
  type ProcessCommandLineReader,
} from '../process-identity.js';
import { formatDirectUsage, isDirectCommandName } from './direct-commands.js';
import {
  assertBoundedCookieImportFile,
  parseBoundedCookieImport,
} from './cookie-import.js';
import {
  evaluateBoundedCliScript,
  readBoundedCliElementData,
} from './page-inspection.js';

export interface DirectModeState {
  mode?: 'local' | 'remote';
  cdp_url?: string | null;
  session_id?: string | null;
  browser_pid?: number | null;
  browser_launch_token?: string | null;
  user_data_dir?: string | null;
  owns_user_data_dir?: boolean | null;
  active_url?: string | null;
}

const getSafeUserSegment = () => {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  try {
    const username = os.userInfo().username;
    return username.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'user';
  } catch {
    return 'user';
  }
};

const getDefaultDirectStateDir = () => {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir && path.isAbsolute(runtimeDir)) {
    return path.join(runtimeDir, 'browser-use');
  }

  const homeDir = os.homedir();
  if (homeDir) {
    if (process.platform === 'darwin') {
      return path.join(
        homeDir,
        'Library',
        'Application Support',
        'browser-use'
      );
    }
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA?.trim();
      const baseDir =
        localAppData && path.isAbsolute(localAppData)
          ? localAppData
          : path.join(homeDir, 'AppData', 'Local');
      return path.join(baseDir, 'browser-use');
    }

    const stateHome = process.env.XDG_STATE_HOME?.trim();
    const baseDir =
      stateHome && path.isAbsolute(stateHome)
        ? stateHome
        : path.join(homeDir, '.local', 'state');
    return path.join(baseDir, 'browser-use');
  }

  return path.join(os.tmpdir(), `browser-use-${getSafeUserSegment()}`);
};

export const DIRECT_STATE_FILE = path.join(
  getDefaultDirectStateDir(),
  'direct-state.json'
);
export const MAX_DIRECT_STATE_BYTES = 64 * 1024;

interface StreamLike {
  write(chunk: string): void;
}

interface DirectSessionLike {
  tabs?: Array<{ target_id?: string | null; url?: string | null }>;
  active_tab?: { target_id?: string | null; url?: string | null } | null;
  event_bus?: { stop?: () => Promise<void> | void } | null;
  browser_context?: {
    cookies?: (urls?: string[]) => Promise<any[]>;
    addCookies?: (cookies: any[]) => Promise<unknown>;
    clearCookies?: () => Promise<unknown>;
  } | null;
  detach_all_watchdogs?: () => void;
  start: () => Promise<unknown>;
  navigate_to?: (url: string) => Promise<unknown>;
  get_current_page?: () => Promise<any>;
  get_browser_state_with_recovery?: (options?: {
    include_screenshot?: boolean;
  }) => Promise<{
    llm_representation: () => string;
    url?: string;
    title?: string;
    tabs?: unknown[];
  }>;
  get_page_info?: () => Promise<any>;
  get_dom_element_by_index?: (index: number) => Promise<any>;
  get_locate_element?: (node: any) => Promise<any>;
  _click_element_node?: (node: any) => Promise<unknown>;
  click_coordinates?: (
    x: number,
    y: number,
    options?: { button?: 'left' | 'middle' | 'right' }
  ) => Promise<unknown>;
  send_keys?: (text: string) => Promise<unknown>;
  _input_text_element_node?: (
    node: any,
    text: string,
    options?: { clear?: boolean }
  ) => Promise<unknown>;
  take_screenshot?: (full_page?: boolean) => Promise<string | null>;
  scroll?: (
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number
  ) => Promise<unknown>;
  go_back?: () => Promise<unknown>;
  go_forward?: () => Promise<unknown>;
  get_page_html?: () => Promise<string>;
  execute_javascript?: (script: string) => Promise<unknown>;
  validate_page_after_action?: (page: any) => Promise<unknown>;
  switch_to_tab?: (identifier: number | string) => Promise<unknown>;
  close_tab?: (identifier: number | string) => Promise<unknown>;
  select_dropdown_option?: (node: any, value: string) => Promise<unknown>;
  wait_for_element?: (selector: string, timeout: number) => Promise<unknown>;
  get_cookies?: (options?: { include_blocked?: boolean }) => Promise<any[]>;
}

const normalizeCookieDomain = (value: string | null | undefined) =>
  String(value ?? '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();

const parseCookieHostname = (url: string | null | undefined) => {
  const value = String(url ?? '').trim();
  if (!value) {
    return '';
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const validateDirectPageAfterAction = async (
  session: DirectSessionLike,
  page: any
) => {
  await session.validate_page_after_action?.(page);
};

const parseCookieUrl = (url: string | null | undefined) => {
  const value = String(url ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const cookiePathMatches = (
  cookiePath: string | null | undefined,
  urlPath: string
) => {
  const normalizedCookiePath =
    typeof cookiePath === 'string' && cookiePath.length > 0 ? cookiePath : '/';
  if (normalizedCookiePath === '/') {
    return true;
  }
  if (urlPath === normalizedCookiePath) {
    return true;
  }
  return urlPath.startsWith(
    normalizedCookiePath.endsWith('/')
      ? normalizedCookiePath
      : `${normalizedCookiePath}/`
  );
};

const cookieMatchesUrl = (
  cookie: {
    domain?: string | null;
    path?: string | null;
    secure?: boolean | null;
  },
  url: string | null | undefined
) => {
  const parsedUrl = parseCookieUrl(url);
  const hostname = parsedUrl?.hostname.toLowerCase() ?? '';
  const domain = normalizeCookieDomain(cookie.domain);
  if (!hostname || !domain) {
    return false;
  }
  if (!(hostname === domain || hostname.endsWith(`.${domain}`))) {
    return false;
  }
  if (!cookiePathMatches(cookie.path, parsedUrl?.pathname || '/')) {
    return false;
  }
  if (cookie.secure && parsedUrl?.protocol !== 'https:') {
    return false;
  }
  return true;
};

const normalizeSameSite = (value: string | null | undefined) => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'strict') {
    return 'Strict';
  }
  if (normalized === 'lax') {
    return 'Lax';
  }
  if (normalized === 'none') {
    return 'None';
  }
  return undefined;
};

const getDirectCookieDenialReason = (
  session: DirectSessionLike,
  cookie: unknown
) => {
  const checker = (session as any)._get_cookie_access_denial_reason;
  if (typeof checker !== 'function') {
    return null;
  }
  return checker.call(session, cookie);
};

const filterDirectAllowedCookies = (
  session: DirectSessionLike,
  cookies: any[]
) => cookies.filter((cookie) => !getDirectCookieDenialReason(session, cookie));

const partitionDirectAllowedCookies = (
  session: DirectSessionLike,
  cookies: any[]
) => {
  const allowedCookies: any[] = [];
  const blockedCookies: any[] = [];
  for (const cookie of cookies) {
    if (getDirectCookieDenialReason(session, cookie)) {
      blockedCookies.push(cookie);
    } else {
      allowedCookies.push(cookie);
    }
  }
  return { allowedCookies, blockedCookies };
};

const assertDirectCookieUrlAllowed = (
  session: DirectSessionLike,
  url: string
) => {
  const denialReason = getDirectCookieDenialReason(session, { url });
  if (denialReason) {
    throw new Error(`Cookie URL blocked by domain policy: ${denialReason}`);
  }
};

export interface DirectCliEnvironment {
  state_file?: string;
  stdout?: StreamLike;
  stderr?: StreamLike;
  session_factory?: (init: { cdp_url?: string | null }) => DirectSessionLike;
  cloud_client_factory?: () => Pick<
    CloudBrowserClient,
    'create_browser' | 'stop_browser'
  >;
  local_launcher?: (options: { state: DirectModeState }) => Promise<{
    cdp_url: string;
    browser_pid?: number | null;
    browser_launch_token?: string | null;
    user_data_dir?: string | null;
    owns_user_data_dir?: boolean | null;
  }>;
  kill_process?: (pid: number) => void | Promise<void>;
  get_process_command_line?: ProcessCommandLineReader;
  max_screenshot_bytes?: number | null;
  max_screenshot_pixels?: number | null;
}

const DEFAULT_STDOUT: StreamLike = process.stdout;
const DEFAULT_STDERR: StreamLike = process.stderr;

const writeLine = (stream: StreamLike, message: string) => {
  stream.write(`${message}\n`);
};

const normalizeDirectState = (value: unknown): DirectModeState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const state: DirectModeState = {};
  if (raw.mode === 'local' || raw.mode === 'remote') {
    state.mode = raw.mode;
  }
  for (const key of [
    'cdp_url',
    'session_id',
    'browser_launch_token',
    'user_data_dir',
    'active_url',
  ] as const) {
    if (typeof raw[key] === 'string' || raw[key] === null) {
      state[key] = raw[key];
    }
  }
  if (
    raw.browser_pid === null ||
    (typeof raw.browser_pid === 'number' &&
      Number.isSafeInteger(raw.browser_pid) &&
      raw.browser_pid > 0)
  ) {
    state.browser_pid = raw.browser_pid;
  }
  if (typeof raw.owns_user_data_dir === 'boolean') {
    state.owns_user_data_dir = raw.owns_user_data_dir;
  } else if (raw.owns_user_data_dir === null) {
    state.owns_user_data_dir = null;
  }
  return state;
};

export const load_direct_state = (state_file: string = DIRECT_STATE_FILE) => {
  try {
    const stats = fs.lstatSync(state_file);
    if (!stats.isFile() || stats.size > MAX_DIRECT_STATE_BYTES) {
      return {};
    }
    const raw = fs.readFileSync(state_file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_DIRECT_STATE_BYTES) {
      return {};
    }
    return normalizeDirectState(JSON.parse(raw));
  } catch {
    return {};
  }
};

export const save_direct_state = (
  state: DirectModeState,
  state_file: string = DIRECT_STATE_FILE
) => {
  const serializedState = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(serializedState, 'utf8') > MAX_DIRECT_STATE_BYTES) {
    throw new Error(`Direct state exceeds ${MAX_DIRECT_STATE_BYTES} bytes`);
  }
  const stateDir = path.dirname(state_file);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (
    process.platform !== 'win32' &&
    path.resolve(state_file) === path.resolve(DIRECT_STATE_FILE)
  ) {
    fs.chmodSync(stateDir, 0o700);
  }

  const tempPath = path.join(
    stateDir,
    `.${path.basename(state_file)}.${process.pid}.${randomUUID()}.tmp`
  );
  let renamed = false;
  try {
    fs.writeFileSync(tempPath, serializedState, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') {
      fs.chmodSync(tempPath, 0o600);
    }
    fs.renameSync(tempPath, state_file);
    renamed = true;
    if (process.platform !== 'win32') {
      fs.chmodSync(state_file, 0o600);
    }
  } finally {
    if (!renamed) {
      fs.rmSync(tempPath, { force: true });
    }
  }
};

export const clear_direct_state = (state_file: string = DIRECT_STATE_FILE) => {
  fs.rmSync(state_file, { force: true });
};

const getDirectBrowserProcessOwnership = async (
  state: DirectModeState,
  getProcessCommandLine: Required<DirectCliEnvironment>['get_process_command_line']
): Promise<'owned' | 'not_owned' | 'unverified'> => {
  const pid = state.browser_pid;
  const token = state.browser_launch_token?.trim();
  if (typeof pid !== 'number' || pid <= 0 || !token) {
    return 'not_owned';
  }

  let commandLine: string | null = null;
  try {
    commandLine = await getProcessCommandLine(pid);
  } catch {
    // Treat process inspection failures as unverified while the PID is alive.
  }
  if (commandLine) {
    return commandLine.includes(`--browser-use-direct-token=${token}`)
      ? 'owned'
      : 'not_owned';
  }

  return isProcessTargetAlive(pid) ? 'unverified' : 'not_owned';
};

const writePrivateFile = (filePath: string, contents: string) => {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
};

const writePrivateBufferFile = (filePath: string, contents: Buffer) => {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
};

const assertDirectScreenshotPixelBudget = async (
  session: DirectSessionLike,
  fullPage: boolean,
  maxPixels: number | null
) => {
  if (maxPixels == null) {
    return;
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new Error('Screenshot pixel limit must be a positive integer');
  }
  if (typeof session.get_page_info !== 'function') {
    throw new Error('Unable to verify screenshot dimensions before capture');
  }
  const pageInfo = await session.get_page_info();
  const cssWidth = Number(
    fullPage ? pageInfo?.page_width : pageInfo?.viewport_width
  );
  const cssHeight = Number(
    fullPage ? pageInfo?.page_height : pageInfo?.viewport_height
  );
  const devicePixelRatio = Number(pageInfo?.device_pixel_ratio ?? 1);
  if (
    !Number.isFinite(cssWidth) ||
    cssWidth <= 0 ||
    !Number.isFinite(cssHeight) ||
    cssHeight <= 0 ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0
  ) {
    throw new Error('Unable to verify screenshot dimensions before capture');
  }

  const width = Math.ceil(cssWidth * devicePixelRatio);
  const height = Math.ceil(cssHeight * devicePixelRatio);
  if (width > Math.floor(maxPixels / height)) {
    throw new Error(`Screenshot exceeds maximum pixel count of ${maxPixels}`);
  }
};

const decodeDirectScreenshot = (
  screenshot: string,
  maxBytes: number | null
) => {
  if (maxBytes != null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Screenshot byte limit must be a positive integer');
    }
    if (Buffer.byteLength(screenshot, 'base64') > maxBytes) {
      throw new Error(`Screenshot exceeds maximum size of ${maxBytes} bytes`);
    }
  }
  const bytes = Buffer.from(screenshot, 'base64');
  if (maxBytes != null && bytes.length > maxBytes) {
    throw new Error(`Screenshot exceeds maximum size of ${maxBytes} bytes`);
  }
  return bytes;
};

const isOwnedDirectUserDataDir = (userDataDir: string) => {
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    return false;
  }

  try {
    const resolvedDir = fs.realpathSync(userDataDir);
    const resolvedTmp = fs.realpathSync(os.tmpdir());
    return (
      path.dirname(resolvedDir) === resolvedTmp &&
      path.basename(resolvedDir).startsWith('browser-use-direct-')
    );
  } catch {
    return false;
  }
};

const cleanupOwnedDirectUserDataDir = (state: DirectModeState) => {
  if (!state.owns_user_data_dir || !state.user_data_dir) {
    return;
  }
  if (!isOwnedDirectUserDataDir(state.user_data_dir)) {
    return;
  }
  try {
    fs.rmSync(state.user_data_dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures for ephemeral direct-mode profiles.
  }
};

const normalizeDirectUrl = (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
};

const extractDirectModeArgs = (argv: string[]) => {
  let useRemote = false;
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index] ?? '';
    if (arg === '--remote') {
      useRemote = true;
      index += 1;
      continue;
    }
    break;
  }

  return {
    useRemote,
    args: argv.slice(index),
  };
};

const waitForLocalCdpEndpoint = async (
  activePortPath: string,
  timeoutMs = 15000
) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const activePort = readDevToolsActivePort(activePortPath);
    if (activePort) {
      const webSocketUrl = await discoverLocalCdpWebSocketUrl({
        port: activePort.port,
        timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
      });
      if (
        webSocketUrl &&
        new URL(webSocketUrl).pathname === activePort.browserPath
      ) {
        return `http://127.0.0.1:${activePort.port}`;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for local Chrome debugging endpoint at ${activePortPath}`
  );
};

const isProcessTargetAlive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const waitForProcessTargetExit = async (target: number) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isProcessTargetAlive(target)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessTargetAlive(target);
};

const terminateFailedDirectLaunch = async (pid: number) => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T'], {
      stdio: 'ignore',
    });
    if (await waitForProcessTargetExit(pid)) {
      return true;
    }
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return waitForProcessTargetExit(pid);
  }

  let target = -pid;
  try {
    process.kill(target, 'SIGTERM');
  } catch {
    target = pid;
    try {
      process.kill(target, 'SIGTERM');
    } catch {
      return !isProcessTargetAlive(target);
    }
  }

  if (await waitForProcessTargetExit(target)) {
    return true;
  }

  try {
    process.kill(target, 'SIGKILL');
  } catch {
    return !isProcessTargetAlive(target);
  }
  return waitForProcessTargetExit(target);
};

export interface DirectBrowserExecutable {
  executable_path: string;
  source: 'system_chrome' | 'playwright_chromium';
}

export const resolveDirectBrowserExecutable =
  (): DirectBrowserExecutable | null => {
    const systemExecutablePath = systemChrome.findExecutable();
    if (systemExecutablePath) {
      return {
        executable_path: systemExecutablePath,
        source: 'system_chrome',
      };
    }

    try {
      const playwrightExecutablePath = chromium.executablePath();
      if (playwrightExecutablePath && fs.existsSync(playwrightExecutablePath)) {
        return {
          executable_path: playwrightExecutablePath,
          source: 'playwright_chromium',
        };
      }
    } catch {
      // Playwright reports the expected path even when a browser is absent,
      // and can throw for incomplete installations. Both mean unavailable.
    }

    return null;
  };

export const defaultLocalLauncher = async (options: {
  state: DirectModeState;
  timeout_ms?: number;
}) => {
  const browserExecutable = resolveDirectBrowserExecutable();
  if (!browserExecutable) {
    throw new Error(
      'No Chrome or Playwright Chromium executable found. Install Chrome, run "browser-use install", or provide an already-running browser via cdp_url.'
    );
  }
  const executablePath = browserExecutable.executable_path;

  const savedUserDataDir = options.state.user_data_dir?.trim() ?? '';
  const reusingUserDataDir = savedUserDataDir.length > 0;
  if (
    browserExecutable.source === 'playwright_chromium' &&
    reusingUserDataDir
  ) {
    throw new Error(
      'Playwright Chromium fallback cannot reuse a saved Chrome profile. Close the stale direct-mode session or remove its state before retrying.'
    );
  }
  const userDataDir = reusingUserDataDir
    ? savedUserDataDir
    : fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-direct-'));
  const browserLaunchToken = randomUUID();
  const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
  try {
    fs.rmSync(activePortPath, { force: true });
  } catch (error) {
    if (!reusingUserDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Preserve the original stale-marker error.
      }
    }
    throw new Error(
      `Cannot remove stale Chrome debugging marker at ${activePortPath}: ${(error as Error).message}`,
      { cause: error }
    );
  }

  const child = spawn(
    executablePath,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--browser-use-direct-token=${browserLaunchToken}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref();
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once('error', reject);
  });

  try {
    const cdp_url = await Promise.race([
      waitForLocalCdpEndpoint(activePortPath, options.timeout_ms),
      spawnError,
    ]);
    return {
      cdp_url,
      browser_pid: child.pid ?? null,
      browser_launch_token: browserLaunchToken,
      user_data_dir: userDataDir,
      owns_user_data_dir: !reusingUserDataDir,
    };
  } catch (error) {
    let launchTerminated = true;
    if (typeof child.pid === 'number' && child.pid > 0) {
      launchTerminated = await terminateFailedDirectLaunch(child.pid);
    }
    if (
      launchTerminated &&
      !reusingUserDataDir &&
      typeof userDataDir === 'string'
    ) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures for ephemeral launch profiles.
      }
    }
    if (!launchTerminated) {
      throw new Error(
        `${(error as Error).message}; browser process ${child.pid} could not be terminated and its profile was retained at ${userDataDir}`,
        { cause: error }
      );
    }
    throw error;
  }
};

const cleanupDirectSession = async (session: DirectSessionLike) => {
  try {
    session.detach_all_watchdogs?.();
  } catch {
    // Ignore cleanup failures.
  }
  try {
    await session.event_bus?.stop?.();
  } catch {
    // Ignore event bus cleanup failures.
  }
};

const requireDirectNodeByIndex = async (
  session: DirectSessionLike,
  indexValue: string | undefined
) => {
  const index = Number(indexValue ?? Number.NaN);
  if (!Number.isFinite(index)) {
    throw new Error('Missing index');
  }
  const node = await session.get_dom_element_by_index?.(index);
  if (!node) {
    throw new Error(`Element index ${index} not found - run "state" first`);
  }
  return { index, node };
};

const readDirectNodeData = async (
  session: DirectSessionLike,
  node: any,
  kind: 'text' | 'value' | 'attributes' | 'bbox'
) => {
  if (!node?.xpath) {
    throw new Error('DOM element does not include an XPath selector');
  }

  const page = await session.get_current_page?.();
  if (!page?.evaluate) {
    throw new Error('No active page available');
  }

  await validateDirectPageAfterAction(session, page);
  try {
    return await readBoundedCliElementData(page, node.xpath, kind);
  } finally {
    await validateDirectPageAfterAction(session, page);
  }
};

const takeDirectOptionValue = (
  args: string[],
  index: number,
  option: string
) => {
  const next = args[index + 1]?.trim();
  if (!next || next === '--' || next.startsWith('-')) {
    throw new Error(`Missing value for ${option}`);
  }
  return next;
};

const parseDirectCookieOptions = (args: string[]) => {
  const positional: string[] = [];
  let url: string | null = null;
  let domain: string | null = null;
  let cookiePath = '/';
  let secure = false;
  let httpOnly = false;
  let sameSite: 'Strict' | 'Lax' | 'None' | undefined;
  let expires: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (
      arg === '--url' ||
      arg === '--domain' ||
      arg === '--path' ||
      arg === '--same-site' ||
      arg === '--expires'
    ) {
      const next = takeDirectOptionValue(args, index, arg);
      if (arg === '--url') {
        url = next;
      } else if (arg === '--domain') {
        domain = next;
      } else if (arg === '--path') {
        cookiePath = next;
      } else if (arg === '--same-site') {
        sameSite = normalizeSameSite(next);
        if (!sameSite) {
          throw new Error(
            'Invalid --same-site value. Expected Strict, Lax, or None'
          );
        }
      } else {
        const parsed = Number(next);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid --expires value: ${next}`);
        }
        expires = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === '--secure') {
      secure = true;
      continue;
    }
    if (arg === '--http-only') {
      httpOnly = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  return {
    positional,
    url,
    domain,
    path: cookiePath,
    secure,
    httpOnly,
    sameSite,
    expires,
  };
};

const restoreActiveTab = async (
  session: DirectSessionLike,
  state: DirectModeState
) => {
  if (
    typeof state.active_url !== 'string' ||
    !state.active_url ||
    !Array.isArray(session.tabs) ||
    typeof session.switch_to_tab !== 'function'
  ) {
    return;
  }

  const matchingTab = session.tabs.find((tab) => tab?.url === state.active_url);
  if (!matchingTab?.target_id) {
    return;
  }

  try {
    await session.switch_to_tab(matchingTab.target_id);
  } catch {
    // Fall back to the default page if the tab cannot be restored.
  }
};

const createDefaultSessionFactory =
  () =>
  (init: { cdp_url?: string | null }): DirectSessionLike =>
    new BrowserSession({
      cdp_url: init.cdp_url ?? null,
      profile: {
        keep_alive: true,
      },
    });

const killOwnedDirectBrowserProcess = async (
  state: DirectModeState,
  environment: Required<DirectCliEnvironment>
): Promise<'terminated' | 'not_owned' | 'failed'> => {
  const ownership = await getDirectBrowserProcessOwnership(
    state,
    environment.get_process_command_line
  );
  if (ownership === 'not_owned') {
    return 'not_owned';
  }
  if (ownership === 'unverified') {
    return 'failed';
  }

  try {
    await environment.kill_process(state.browser_pid!);
    return 'terminated';
  } catch {
    return 'failed';
  }
};

const defaultKillDirectBrowserProcess = async (pid: number) => {
  process.kill(pid, 'SIGTERM');

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Browser process ${pid} did not exit after SIGTERM`);
};

const connectDirectSession = async (
  useRemote: boolean,
  environment: Required<DirectCliEnvironment>
) => {
  let state = load_direct_state(environment.state_file);
  const session_factory =
    environment.session_factory ?? createDefaultSessionFactory();

  const connectWithState = async (currentState: DirectModeState) => {
    const session = session_factory({ cdp_url: currentState.cdp_url ?? null });
    await session.start();
    await restoreActiveTab(session, currentState);
    return session;
  };

  const cleanupDisconnectedState = async (currentState: DirectModeState) => {
    if (currentState.mode === 'remote' && currentState.session_id) {
      try {
        await environment
          .cloud_client_factory()
          .stop_browser(currentState.session_id);
        return true;
      } catch {
        return false;
      }
    }

    if (
      currentState.mode === 'local' &&
      typeof currentState.browser_pid === 'number' &&
      currentState.browser_pid > 0
    ) {
      const termination = await killOwnedDirectBrowserProcess(
        currentState,
        environment
      );
      if (termination === 'failed') {
        return false;
      }
    }
    cleanupOwnedDirectUserDataDir(currentState);
    return true;
  };

  if (useRemote && state.cdp_url && state.mode !== 'remote') {
    if (!(await cleanupDisconnectedState(state))) {
      throw new Error(
        'Failed to close the existing direct-mode browser; state was retained for retry'
      );
    }
    clear_direct_state(environment.state_file);
    state = {};
  }

  if (state.cdp_url) {
    try {
      const session = await connectWithState(state);
      return { session, state };
    } catch {
      if (!(await cleanupDisconnectedState(state))) {
        throw new Error(
          'Failed to clean up the disconnected direct-mode browser; state was retained for retry'
        );
      }
      clear_direct_state(environment.state_file);
      state = {};
    }
  }

  if (useRemote) {
    const cloudClient =
      environment.cloud_client_factory?.() ?? new CloudBrowserClient();
    const browser = await cloudClient.create_browser({});
    state = {
      mode: 'remote',
      cdp_url: browser.cdpUrl,
      session_id: browser.id,
      active_url: null,
    };
    save_direct_state(state, environment.state_file);
    return {
      session: await connectWithState(state),
      state,
    };
  }

  const localLaunch = await (
    environment.local_launcher ?? defaultLocalLauncher
  )({
    state,
  });
  state = {
    mode: 'local',
    cdp_url: localLaunch.cdp_url,
    browser_pid: localLaunch.browser_pid ?? null,
    browser_launch_token: localLaunch.browser_launch_token ?? null,
    user_data_dir: localLaunch.user_data_dir ?? null,
    owns_user_data_dir: localLaunch.owns_user_data_dir ?? null,
    active_url: null,
  };
  save_direct_state(state, environment.state_file);
  return {
    session: await connectWithState(state),
    state,
  };
};

const updateDirectStateFromSession = async (
  session: DirectSessionLike,
  state: DirectModeState,
  environment: Required<DirectCliEnvironment>
) => {
  const currentPage = await session.get_current_page?.();
  const active_url =
    typeof currentPage?.url === 'function'
      ? String(currentPage.url() ?? '')
      : (session.active_tab?.url ?? null);

  save_direct_state(
    {
      ...state,
      active_url:
        typeof active_url === 'string' && active_url.trim().length > 0
          ? active_url
          : null,
    },
    environment.state_file
  );
};

export const run_direct_command = async (
  argv: string[],
  options: DirectCliEnvironment = {}
) => {
  const environment: Required<DirectCliEnvironment> = {
    state_file: options.state_file ?? DIRECT_STATE_FILE,
    stdout: options.stdout ?? DEFAULT_STDOUT,
    stderr: options.stderr ?? DEFAULT_STDERR,
    session_factory: options.session_factory ?? createDefaultSessionFactory(),
    cloud_client_factory:
      options.cloud_client_factory ?? (() => new CloudBrowserClient()),
    local_launcher: options.local_launcher ?? defaultLocalLauncher,
    kill_process: options.kill_process ?? defaultKillDirectBrowserProcess,
    get_process_command_line:
      options.get_process_command_line ?? getProcessCommandLine,
    max_screenshot_bytes: options.max_screenshot_bytes ?? null,
    max_screenshot_pixels: options.max_screenshot_pixels ?? null,
  };

  const { useRemote, args } = extractDirectModeArgs(argv);
  const command = args[0] ?? '';

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    writeLine(environment.stdout, formatDirectUsage());
    return command ? 0 : 1;
  }

  if (!isDirectCommandName(command)) {
    writeLine(environment.stderr, `Error: Unknown command: ${command}`);
    return 1;
  }

  if (command === 'close') {
    const state = load_direct_state(environment.state_file);
    if (!state.cdp_url) {
      writeLine(environment.stdout, 'No active browser session');
      clear_direct_state(environment.state_file);
      return 0;
    }

    if (state.mode === 'remote' && state.session_id) {
      try {
        await environment.cloud_client_factory().stop_browser(state.session_id);
      } catch {
        writeLine(
          environment.stderr,
          'Failed to close cloud browser; state was retained for retry'
        );
        return 1;
      }
    } else if (typeof state.browser_pid === 'number' && state.browser_pid > 0) {
      const termination = await killOwnedDirectBrowserProcess(
        state,
        environment
      );
      if (termination === 'failed') {
        writeLine(
          environment.stderr,
          'Failed to close local browser; state was retained for retry'
        );
        return 1;
      }
    }
    cleanupOwnedDirectUserDataDir(state);

    clear_direct_state(environment.state_file);
    writeLine(environment.stdout, 'Browser closed');
    return 0;
  }

  let connected: Awaited<ReturnType<typeof connectDirectSession>> | null = null;
  try {
    connected = await connectDirectSession(useRemote, environment);
    const { session, state } = connected;

    if (command === 'open') {
      const url = normalizeDirectUrl(args[1] ?? '');
      if (!url) {
        throw new Error('Missing url');
      }
      await session.navigate_to?.(url);
      writeLine(environment.stdout, `Navigated to: ${url}`);
    } else if (command === 'state') {
      const summary = await session.get_browser_state_with_recovery?.({
        include_screenshot: false,
      });
      if (!summary) {
        throw new Error('No browser state available');
      }
      const pageInfo = await session.get_page_info?.();
      let output = summary.llm_representation();
      if (pageInfo) {
        output =
          `viewport: ${pageInfo.viewport_width}x${pageInfo.viewport_height}\n` +
          `page: ${pageInfo.page_width}x${pageInfo.page_height}\n` +
          `scroll: (${pageInfo.scroll_x}, ${pageInfo.scroll_y})\n` +
          output;
      }
      writeLine(environment.stdout, output);
    } else if (command === 'click') {
      const numericArgs = args.slice(1).map((arg) => Number(arg));
      if (numericArgs.length === 2 && numericArgs.every(Number.isFinite)) {
        const [x, y] = numericArgs;
        await session.click_coordinates?.(x!, y!);
        writeLine(environment.stdout, `Clicked at (${x}, ${y})`);
      } else if (
        numericArgs.length === 1 &&
        Number.isFinite(numericArgs[0] ?? Number.NaN)
      ) {
        const { node } = await requireDirectNodeByIndex(
          session,
          String(numericArgs[0])
        );
        await session._click_element_node?.(node);
        writeLine(environment.stdout, `Clicked element [${numericArgs[0]}]`);
      } else {
        throw new Error('Usage: click <index> or click <x> <y>');
      }
    } else if (command === 'type') {
      const text = args.slice(1).join(' ').trim();
      if (!text) {
        throw new Error('Missing text');
      }
      await session.send_keys?.(text);
      writeLine(environment.stdout, `Typed ${text.length} characters`);
    } else if (command === 'input') {
      const index = Number(args[1] ?? Number.NaN);
      const text = args.slice(2).join(' ').trim();
      if (!Number.isFinite(index) || !text) {
        throw new Error('Usage: input <index> <text>');
      }
      const { node } = await requireDirectNodeByIndex(session, String(index));
      await session._input_text_element_node?.(node, text, { clear: true });
      writeLine(
        environment.stdout,
        `Typed ${text.length} characters into element [${index}]`
      );
    } else if (command === 'screenshot') {
      const screenshotArgs = args.slice(1);
      const fullPage = screenshotArgs.some(
        (value) => value === '--full' || value === '--full-page'
      );
      const outputPathValue = screenshotArgs.find(
        (value) => value !== '--full' && value !== '--full-page'
      );
      const outputPath = outputPathValue ? path.resolve(outputPathValue) : null;
      await assertDirectScreenshotPixelBudget(
        session,
        fullPage,
        environment.max_screenshot_pixels
      );
      const screenshot = await session.take_screenshot?.(fullPage);
      if (!screenshot) {
        throw new Error('Failed to capture screenshot');
      }
      const bytes = decodeDirectScreenshot(
        screenshot,
        environment.max_screenshot_bytes
      );
      if (outputPath) {
        writePrivateBufferFile(outputPath, bytes);
        writeLine(
          environment.stdout,
          `Screenshot saved to ${outputPath} (${bytes.length} bytes)`
        );
      } else {
        writeLine(
          environment.stdout,
          JSON.stringify({
            screenshot,
            size_bytes: bytes.length,
          })
        );
      }
    } else if (command === 'scroll') {
      const direction =
        args[1] === 'up' || args[1] === 'left' || args[1] === 'right'
          ? (args[1] as 'up' | 'left' | 'right')
          : 'down';
      await session.scroll?.(direction, 500);
      writeLine(environment.stdout, `Scrolled ${direction}`);
    } else if (command === 'back') {
      await session.go_back?.();
      writeLine(environment.stdout, 'Navigated back');
    } else if (command === 'forward') {
      await session.go_forward?.();
      writeLine(environment.stdout, 'Navigated forward');
    } else if (command === 'switch') {
      const rawIdentifier = args[1]?.trim();
      if (!rawIdentifier) {
        throw new Error('Usage: switch <tab>');
      }
      const numericIdentifier = Number(rawIdentifier);
      const identifier = Number.isFinite(numericIdentifier)
        ? numericIdentifier
        : rawIdentifier;
      await session.switch_to_tab?.(identifier);
      writeLine(environment.stdout, `Switched to tab: ${rawIdentifier}`);
    } else if (command === 'close-tab') {
      const rawIdentifier = args[1]?.trim();
      const numericIdentifier =
        rawIdentifier && rawIdentifier.length > 0 ? Number(rawIdentifier) : NaN;
      const identifier =
        rawIdentifier && rawIdentifier.length > 0
          ? Number.isFinite(numericIdentifier)
            ? numericIdentifier
            : rawIdentifier
          : (session.active_tab?.target_id ?? null);
      if (identifier === null) {
        throw new Error('Usage: close-tab [tab]');
      }
      await session.close_tab?.(identifier);
      writeLine(environment.stdout, `Closed tab: ${identifier}`);
    } else if (command === 'keys') {
      const keys = args.slice(1).join(' ').trim();
      if (!keys) {
        throw new Error('Missing keys');
      }
      await session.send_keys?.(keys);
      writeLine(environment.stdout, 'Sent key sequence');
    } else if (command === 'select') {
      const index = args[1];
      const value = args.slice(2).join(' ').trim();
      if (!index || !value) {
        throw new Error('Usage: select <index> <value>');
      }
      const { node, index: numericIndex } = await requireDirectNodeByIndex(
        session,
        index
      );
      await session.select_dropdown_option?.(node, value);
      writeLine(
        environment.stdout,
        `Selected option for element [${numericIndex}]`
      );
    } else if (command === 'wait') {
      const waitCommand = args[1] ?? '';
      if (waitCommand === 'selector') {
        const selector = args[2]?.trim();
        const timeout = Number(args[3] ?? 5000);
        if (!selector) {
          throw new Error('Usage: wait selector <css> [timeout]');
        }
        await session.wait_for_element?.(selector, timeout);
        writeLine(
          environment.stdout,
          `Waited for selector "${selector}" (${timeout}ms)`
        );
      } else if (waitCommand === 'text') {
        const text = args.slice(2).join(' ').trim();
        if (!text) {
          throw new Error('Usage: wait text <text>');
        }
        const page = await session.get_current_page?.();
        if (!page?.waitForFunction) {
          throw new Error('No active page available for wait text');
        }
        try {
          await page.waitForFunction(
            (needle: string) =>
              document.body?.innerText?.includes(needle) ?? false,
            text,
            { timeout: 5000 }
          );
        } finally {
          await validateDirectPageAfterAction(session, page);
        }
        writeLine(environment.stdout, `Waited for text "${text}"`);
      } else {
        throw new Error('Usage: wait selector <css> | wait text <text>');
      }
    } else if (command === 'hover') {
      const { node, index } = await requireDirectNodeByIndex(session, args[1]);
      const locator = await session.get_locate_element?.(node);
      if (!locator?.hover) {
        throw new Error('Hover is not available for this element');
      }
      const page = await session.get_current_page?.();
      try {
        await locator.hover({ timeout: 5000 });
      } finally {
        await validateDirectPageAfterAction(session, page);
      }
      writeLine(environment.stdout, `Hovered element [${index}]`);
    } else if (command === 'dblclick') {
      const { node, index } = await requireDirectNodeByIndex(session, args[1]);
      const locator = await session.get_locate_element?.(node);
      if (!locator?.dblclick) {
        throw new Error('Double-click is not available for this element');
      }
      const page = await session.get_current_page?.();
      try {
        await locator.dblclick({ timeout: 5000 });
      } finally {
        await validateDirectPageAfterAction(session, page);
      }
      writeLine(environment.stdout, `Double-clicked element [${index}]`);
    } else if (command === 'rightclick') {
      const { node, index } = await requireDirectNodeByIndex(session, args[1]);
      const locator = await session.get_locate_element?.(node);
      if (!locator?.click) {
        throw new Error('Right-click is not available for this element');
      }
      const page = await session.get_current_page?.();
      try {
        await locator.click({ button: 'right', timeout: 5000 });
      } finally {
        await validateDirectPageAfterAction(session, page);
      }
      writeLine(environment.stdout, `Right-clicked element [${index}]`);
    } else if (command === 'cookies') {
      const cookieCommand = args[1] ?? '';
      if (cookieCommand === 'get') {
        const parsed = parseDirectCookieOptions(args.slice(2));
        const url = parsed.url ?? parsed.positional[0] ?? null;
        if (url) {
          assertDirectCookieUrlAllowed(session, url);
        }
        const allCookies = (await session.get_cookies?.()) ?? [];
        const allowedCookies = filterDirectAllowedCookies(session, allCookies);
        const cookies = url
          ? allowedCookies.filter((cookie) => cookieMatchesUrl(cookie, url))
          : allowedCookies;
        writeLine(
          environment.stdout,
          JSON.stringify({ cookies, count: cookies.length }, null, 2)
        );
      } else if (cookieCommand === 'set') {
        if (!session.browser_context?.addCookies) {
          throw new Error('Browser context does not support setting cookies');
        }
        const parsed = parseDirectCookieOptions(args.slice(2));
        const name = parsed.positional[0]?.trim();
        const value = parsed.positional[1] ?? '';
        if (!name || parsed.positional.length < 2) {
          throw new Error(
            'Usage: cookies set <name> <value> [--url <url>] [--domain <domain>] [--path <path>] [--secure] [--http-only] [--same-site <Strict|Lax|None>] [--expires <unix-seconds>]'
          );
        }
        const currentPage = await session.get_current_page?.();
        const currentUrl =
          typeof currentPage?.url === 'function' ? currentPage.url() : '';
        const cookie: Record<string, unknown> = {
          name,
          value,
          path: parsed.path,
          secure: parsed.secure,
          httpOnly: parsed.httpOnly,
          sameSite: parsed.sameSite,
          expires: parsed.expires,
        };
        if (parsed.url) {
          cookie.url = parsed.url;
        } else if (parsed.domain) {
          cookie.domain = parsed.domain;
        } else if (currentUrl) {
          cookie.url = currentUrl;
        } else {
          throw new Error('Provide cookie url/domain or open a page first');
        }
        const denialReason = getDirectCookieDenialReason(session, cookie);
        if (denialReason) {
          throw new Error(
            `Cookie target blocked by domain policy: ${denialReason}`
          );
        }
        await session.browser_context.addCookies([cookie]);
        writeLine(environment.stdout, `Set cookie ${name}`);
      } else if (cookieCommand === 'clear') {
        if (!session.browser_context?.clearCookies) {
          throw new Error('Browser context does not support clearing cookies');
        }
        const parsed = parseDirectCookieOptions(args.slice(2));
        const url = parsed.url ?? parsed.positional[0] ?? null;
        if (!url) {
          if (typeof session.get_cookies !== 'function') {
            await session.browser_context.clearCookies();
            writeLine(environment.stdout, 'Cleared cookies');
          } else {
            const allCookies =
              (await session.get_cookies?.({ include_blocked: true })) ?? [];
            const { allowedCookies, blockedCookies } =
              partitionDirectAllowedCookies(session, allCookies);
            if (allowedCookies.length === 0 && blockedCookies.length > 0) {
              writeLine(environment.stdout, 'Cleared 0 cookies');
            } else {
              const addCookies = session.browser_context.addCookies?.bind(
                session.browser_context
              );
              if (blockedCookies.length > 0 && !addCookies) {
                throw new Error(
                  'Browser context does not support preserving blocked cookies'
                );
              }
              await session.browser_context.clearCookies();
              if (blockedCookies.length > 0) {
                await addCookies!(blockedCookies);
              }
              writeLine(
                environment.stdout,
                `Cleared ${allowedCookies.length} cookies`
              );
            }
          }
        } else {
          assertDirectCookieUrlAllowed(session, url);
          const allCookies =
            (await session.get_cookies?.({ include_blocked: true })) ?? [];
          const remaining = allCookies.filter(
            (cookie) => !cookieMatchesUrl(cookie, url)
          );
          const removedCount = allCookies.length - remaining.length;
          const addCookies = session.browser_context.addCookies?.bind(
            session.browser_context
          );
          if (remaining.length > 0 && !addCookies) {
            throw new Error(
              'Browser context does not support preserving non-matching cookies'
            );
          }
          await session.browser_context.clearCookies();
          if (remaining.length > 0) {
            await addCookies!(remaining);
          }
          writeLine(
            environment.stdout,
            `Cleared ${removedCount} cookies matching ${url}`
          );
        }
      } else if (cookieCommand === 'export') {
        const file = args[2]?.trim();
        if (!file) {
          throw new Error('Usage: cookies export <file> [--url <url>]');
        }
        const parsed = parseDirectCookieOptions(args.slice(3));
        const url = parsed.url ?? parsed.positional[0] ?? null;
        if (url) {
          assertDirectCookieUrlAllowed(session, url);
        }
        const allCookies = (await session.get_cookies?.()) ?? [];
        const allowedCookies = filterDirectAllowedCookies(session, allCookies);
        const cookies = url
          ? allowedCookies.filter((cookie) => cookieMatchesUrl(cookie, url))
          : allowedCookies;
        const outputPath = path.resolve(file);
        writePrivateFile(outputPath, JSON.stringify(cookies, null, 2));
        writeLine(
          environment.stdout,
          `Exported ${cookies.length} cookies to ${outputPath}`
        );
      } else if (cookieCommand === 'import') {
        if (!session.browser_context?.addCookies) {
          throw new Error('Browser context does not support importing cookies');
        }
        const file = args[2]?.trim();
        if (!file) {
          throw new Error('Usage: cookies import <file>');
        }
        const inputPath = path.resolve(file);
        assertBoundedCookieImportFile(fs.statSync(inputPath), inputPath);
        const raw = fs.readFileSync(inputPath, 'utf8');
        const cookies = parseBoundedCookieImport(raw);
        const allowedCookies = filterDirectAllowedCookies(session, cookies);
        if (allowedCookies.length > 0) {
          await session.browser_context.addCookies(allowedCookies);
        }
        writeLine(
          environment.stdout,
          `Imported ${allowedCookies.length} cookies from ${inputPath}`
        );
      } else {
        throw new Error(
          'Usage: cookies get [url|--url <url>] | cookies set <name> <value> | cookies clear [--url <url>] | cookies export <file> [--url <url>] | cookies import <file>'
        );
      }
    } else if (command === 'get') {
      const subcommand = args[1] ?? '';
      if (subcommand === 'title') {
        const page = await session.get_current_page?.();
        if (!page?.title) {
          throw new Error('No active page available for get title');
        }
        await validateDirectPageAfterAction(session, page);
        try {
          writeLine(environment.stdout, await readBoundedPageTitle(page));
        } finally {
          await validateDirectPageAfterAction(session, page);
        }
      } else if (subcommand === 'html') {
        const selector = args
          .slice(2)
          .join(' ')
          .trim()
          .slice(0, MAX_PAGE_HTML_SELECTOR_CHARS);
        if (!selector) {
          writeLine(
            environment.stdout,
            (await session.get_page_html?.()) ?? ''
          );
        } else {
          const page = await session.get_current_page?.();
          if (!page?.evaluate) {
            throw new Error('No active page available for get html');
          }
          await validateDirectPageAfterAction(session, page);
          const html = await (async () => {
            try {
              return await extractBoundedPageHtml(
                page,
                MAX_MAIN_PAGE_HTML_CHARS,
                { selector }
              );
            } finally {
              await validateDirectPageAfterAction(session, page);
            }
          })();
          if (!html.rootFound || html.html.length === 0) {
            throw new Error(`No element found for selector: ${selector}`);
          }
          writeLine(environment.stdout, html.html);
        }
      } else if (
        subcommand === 'text' ||
        subcommand === 'value' ||
        subcommand === 'attributes' ||
        subcommand === 'bbox'
      ) {
        const { node } = await requireDirectNodeByIndex(session, args[2]);
        const value = await readDirectNodeData(session, node, subcommand);
        if (value == null) {
          throw new Error(`Unable to retrieve ${subcommand} for element`);
        }
        writeLine(
          environment.stdout,
          typeof value === 'string' ? value : JSON.stringify(value)
        );
      } else {
        throw new Error(
          'Usage: get title | get html [selector] | get text <index> | get value <index> | get attributes <index> | get bbox <index>'
        );
      }
    } else if (command === 'extract') {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        throw new Error('Missing query');
      }
      writeLine(
        environment.stdout,
        JSON.stringify({
          query,
          error:
            'extract requires agent mode - use: browser-use run "extract ..."',
        })
      );
    } else if (command === 'html') {
      const selector = args
        .slice(1)
        .join(' ')
        .trim()
        .slice(0, MAX_PAGE_HTML_SELECTOR_CHARS);
      if (!selector) {
        writeLine(environment.stdout, (await session.get_page_html?.()) ?? '');
      } else {
        const page = await session.get_current_page?.();
        if (!page?.evaluate) {
          throw new Error('No active page available for html');
        }
        await validateDirectPageAfterAction(session, page);
        const html = await (async () => {
          try {
            return await extractBoundedPageHtml(
              page,
              MAX_MAIN_PAGE_HTML_CHARS,
              { selector }
            );
          } finally {
            await validateDirectPageAfterAction(session, page);
          }
        })();
        if (!html.rootFound || html.html.length === 0) {
          throw new Error(`No element found for selector: ${selector}`);
        }
        writeLine(environment.stdout, html.html);
      }
    } else if (command === 'eval') {
      const script = args.slice(1).join(' ').trim();
      if (!script) {
        throw new Error('Missing js');
      }
      const page = await session.get_current_page?.();
      if (!page?.evaluate) {
        throw new Error('No active page available for eval');
      }
      await validateDirectPageAfterAction(session, page);
      let evaluation;
      try {
        evaluation = await evaluateBoundedCliScript(page, script);
      } finally {
        await validateDirectPageAfterAction(session, page);
      }
      if (!evaluation.ok) {
        throw new Error(evaluation.error || 'JavaScript evaluation failed');
      }
      const truncationNote = evaluation.truncated
        ? '\n...[result truncated by browser-use safety limits]'
        : '';
      writeLine(
        environment.stdout,
        `${evaluation.output ?? 'undefined'}${truncationNote}`
      );
    } else {
      throw new Error(`Unknown command: ${command}`);
    }

    await updateDirectStateFromSession(session, state, environment);
    await cleanupDirectSession(session);
    return 0;
  } catch (error) {
    if (connected?.session) {
      await cleanupDirectSession(connected.session);
    }
    writeLine(
      environment.stderr,
      `Error: ${(error as Error)?.message ?? String(error)}`
    );
    return 1;
  }
};

export const main = async (argv: string[] = process.argv.slice(2)) => {
  const exitCode = await run_direct_command(argv);
  if (isMainModule(import.meta.url)) {
    process.exit(exitCode);
  }
  return exitCode;
};

if (isMainModule(import.meta.url)) {
  void main();
}
