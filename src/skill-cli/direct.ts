#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BrowserSession, systemChrome } from '../browser/session.js';
import { CloudBrowserClient } from '../browser/cloud/cloud.js';
import { isMainModule } from '../entrypoint.js';
import {
  getProcessCommandLine,
  type ProcessCommandLineReader,
} from '../process-identity.js';

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
}

const DEFAULT_STDOUT: StreamLike = process.stdout;
const DEFAULT_STDERR: StreamLike = process.stderr;

const writeLine = (stream: StreamLike, message: string) => {
  stream.write(`${message}\n`);
};

export const load_direct_state = (state_file: string = DIRECT_STATE_FILE) => {
  if (!fs.existsSync(state_file)) {
    return {} as DirectModeState;
  }

  try {
    return JSON.parse(fs.readFileSync(state_file, 'utf8')) as DirectModeState;
  } catch {
    return {} as DirectModeState;
  }
};

export const save_direct_state = (
  state: DirectModeState,
  state_file: string = DIRECT_STATE_FILE
) => {
  fs.mkdirSync(path.dirname(state_file), { recursive: true, mode: 0o700 });
  if (
    process.platform !== 'win32' &&
    path.resolve(state_file) === path.resolve(DIRECT_STATE_FILE)
  ) {
    fs.chmodSync(path.dirname(state_file), 0o700);
  }
  fs.writeFileSync(state_file, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    fs.chmodSync(state_file, 0o600);
  }
};

export const clear_direct_state = (state_file: string = DIRECT_STATE_FILE) => {
  fs.rmSync(state_file, { force: true });
};

const isOwnedDirectBrowserProcess = async (
  state: DirectModeState,
  getProcessCommandLine: Required<DirectCliEnvironment>['get_process_command_line']
) => {
  const pid = state.browser_pid;
  const token = state.browser_launch_token?.trim();
  if (typeof pid !== 'number' || pid <= 0 || !token) {
    return false;
  }

  const commandLine = await getProcessCommandLine(pid);
  return Boolean(commandLine?.includes(`--browser-use-direct-token=${token}`));
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

const formatDirectUsage = () => `Usage: browser-use-direct <command> [args]

Commands:
  open <url>              Navigate to URL
  state                   Get current browser state
  click <index>           Click element by DOM index
  click <x> <y>           Click viewport coordinates
  type <text>             Type into focused element
  input <index> <text>    Click element and type text
  screenshot [path] [--full]  Take viewport or full-page screenshot
  scroll [up|down]        Scroll page
  back                    Go back in history
  forward                 Go forward in history
  switch <tab>            Switch to tab index or target id
  close-tab [tab]         Close a tab
  keys <keys>             Send keyboard keys
  select <index> <value>  Select dropdown option
  wait selector <css>     Wait for a selector
  wait text <text>        Wait for text
  hover <index>           Hover element by DOM index
  dblclick <index>        Double-click element by DOM index
  rightclick <index>      Right-click element by DOM index
  cookies <subcommand>    Manage cookies (get/set/clear/export/import)
  get title               Get page title
  get html [selector]     Get page HTML or a CSS selector
  get text <index>        Get element text
  get value <index>       Get element value
  get attributes <index>  Get element attributes
  get bbox <index>        Get element bounding box
  extract <query>         Explain that extraction requires agent mode
  html [selector]         Get page HTML or a CSS selector
  eval <js>               Execute JavaScript
  close                   Close the active direct-mode browser

Flags:
  --remote                Launch browser-use cloud browser`;

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

const getFreePort = async () =>
  await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate local port')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

const waitForLocalCdpEndpoint = async (port: number, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port}`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        const payload = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        if (typeof payload.webSocketDebuggerUrl === 'string') {
          return endpoint;
        }
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for local Chrome debugging endpoint on port ${port}`
  );
};

export const defaultLocalLauncher = async (options: {
  state: DirectModeState;
  timeout_ms?: number;
}) => {
  const executablePath = systemChrome.findExecutable();
  if (!executablePath) {
    throw new Error(
      'Chrome not found. Install Chrome or provide an already-running browser via cdp_url.'
    );
  }

  const port = await getFreePort();
  const reusingUserDataDir =
    options.state.user_data_dir &&
    options.state.user_data_dir.trim().length > 0;
  const userDataDir = reusingUserDataDir
    ? options.state.user_data_dir
    : fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-direct-'));
  const browserLaunchToken = randomUUID();

  const child = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
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

  try {
    const cdp_url = await waitForLocalCdpEndpoint(port, options.timeout_ms);
    return {
      cdp_url,
      browser_pid: child.pid ?? null,
      browser_launch_token: browserLaunchToken,
      user_data_dir: userDataDir,
      owns_user_data_dir: !reusingUserDataDir,
    };
  } catch (error) {
    if (typeof child.pid === 'number' && child.pid > 0) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Ignore cleanup failures for a process that may not have started.
      }
    }
    if (!reusingUserDataDir && typeof userDataDir === 'string') {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures for ephemeral launch profiles.
      }
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
    return await page.evaluate(
      ({ xpath, dataKind }: { xpath: string; dataKind: string }) => {
        const element = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue as HTMLElement | null;
        if (!element) {
          return null;
        }

        if (dataKind === 'text') {
          return element.textContent?.trim() ?? '';
        }
        if (dataKind === 'value') {
          return 'value' in element
            ? String((element as HTMLInputElement).value ?? '')
            : null;
        }
        if (dataKind === 'attributes') {
          return Object.fromEntries(
            Array.from(element.attributes).map((attribute) => [
              attribute.name,
              attribute.value,
            ])
          );
        }
        if (dataKind === 'bbox') {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          };
        }
        return null;
      },
      { xpath: node.xpath, dataKind: kind }
    );
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
  if (
    !(await isOwnedDirectBrowserProcess(
      state,
      environment.get_process_command_line
    ))
  ) {
    return 'not_owned';
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
      writeLine(environment.stdout, `Typed: ${text}`);
    } else if (command === 'input') {
      const index = Number(args[1] ?? Number.NaN);
      const text = args.slice(2).join(' ').trim();
      if (!Number.isFinite(index) || !text) {
        throw new Error('Usage: input <index> <text>');
      }
      const { node } = await requireDirectNodeByIndex(session, String(index));
      await session._input_text_element_node?.(node, text, { clear: true });
      writeLine(environment.stdout, `Typed "${text}" into element [${index}]`);
    } else if (command === 'screenshot') {
      const screenshotArgs = args.slice(1);
      const fullPage = screenshotArgs.some(
        (value) => value === '--full' || value === '--full-page'
      );
      const outputPathValue = screenshotArgs.find(
        (value) => value !== '--full' && value !== '--full-page'
      );
      const outputPath = outputPathValue ? path.resolve(outputPathValue) : null;
      const screenshot = await session.take_screenshot?.(fullPage);
      if (!screenshot) {
        throw new Error('Failed to capture screenshot');
      }
      const bytes = Buffer.from(screenshot, 'base64');
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
      writeLine(environment.stdout, `Sent keys: ${keys}`);
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
        `Selected "${value}" for element [${numericIndex}]`
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
        const raw = fs.readFileSync(inputPath, 'utf8');
        const cookies = JSON.parse(raw) as unknown;
        if (!Array.isArray(cookies)) {
          throw new Error('Cookie import file must contain a JSON array');
        }
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
          writeLine(environment.stdout, await page.title());
        } finally {
          await validateDirectPageAfterAction(session, page);
        }
      } else if (subcommand === 'html') {
        const selector = args.slice(2).join(' ').trim();
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
              return await page.evaluate((targetSelector: string) => {
                const element = document.querySelector(targetSelector);
                return element ? element.outerHTML : null;
              }, selector);
            } finally {
              await validateDirectPageAfterAction(session, page);
            }
          })();
          if (typeof html !== 'string' || html.length === 0) {
            throw new Error(`No element found for selector: ${selector}`);
          }
          writeLine(environment.stdout, html);
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
      const selector = args.slice(1).join(' ').trim();
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
            return await page.evaluate((targetSelector: string) => {
              const element = document.querySelector(targetSelector);
              return element ? element.outerHTML : null;
            }, selector);
          } finally {
            await validateDirectPageAfterAction(session, page);
          }
        })();
        if (typeof html !== 'string' || html.length === 0) {
          throw new Error(`No element found for selector: ${selector}`);
        }
        writeLine(environment.stdout, html);
      }
    } else if (command === 'eval') {
      const script = args.slice(1).join(' ').trim();
      if (!script) {
        throw new Error('Missing js');
      }
      const result = await session.execute_javascript?.(script);
      writeLine(
        environment.stdout,
        result === undefined ? 'undefined' : JSON.stringify(result)
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
