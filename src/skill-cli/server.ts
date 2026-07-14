import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Request, Response } from './protocol.js';
import { SessionRegistry } from './sessions.js';
import {
  extractBoundedPageHtml,
  MAX_MAIN_PAGE_HTML_CHARS,
  MAX_PAGE_HTML_SELECTOR_CHARS,
} from '../browser/page-content.js';
import { readBoundedPageTitle } from '../browser/state-limits.js';
import {
  parseBoundedCookieImport,
  readBoundedCookieImportFile,
} from './cookie-import.js';
import {
  evaluateBoundedCliScript,
  normalizeCliWaitTimeout,
  readBoundedCliElementData,
  waitForVisiblePageText,
} from './page-inspection.js';

export interface SkillCliServerOptions {
  registry?: SessionRegistry;
}

type BrowserCookieInit = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
};

const normalizeCookieDomain = (value: string | null | undefined) =>
  String(value ?? '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();

const chmodPrivateFile = (filePath: string) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
};

const writePrivateJsonFile = async (filePath: string, data: unknown) => {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodPrivateFile(filePath);
};

const writePrivateBinaryFile = async (filePath: string, data: Buffer) => {
  await fsp.writeFile(filePath, data, { mode: 0o600 });
  chmodPrivateFile(filePath);
};

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
  cookie: Pick<BrowserCookieInit, 'domain' | 'path' | 'secure'>,
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

const normalizeSameSite = (
  value: unknown
): BrowserCookieInit['sameSite'] | undefined => {
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

const parseCookieExpires = (value: unknown) => {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getCookieDenialReason = (session: any, cookie: unknown) => {
  const checker = session?._get_cookie_access_denial_reason;
  if (typeof checker !== 'function') {
    return null;
  }
  return checker.call(session, cookie);
};

const filterAllowedCookies = (session: any, cookies: BrowserCookieInit[]) =>
  cookies.filter((cookie) => !getCookieDenialReason(session, cookie));

const partitionAllowedCookies = (
  session: any,
  cookies: BrowserCookieInit[]
) => {
  const allowedCookies: BrowserCookieInit[] = [];
  const blockedCookies: BrowserCookieInit[] = [];
  for (const cookie of cookies) {
    if (getCookieDenialReason(session, cookie)) {
      blockedCookies.push(cookie);
    } else {
      allowedCookies.push(cookie);
    }
  }
  return { allowedCookies, blockedCookies };
};

const assertCookieUrlAllowed = (session: any, url: string) => {
  const denialReason = getCookieDenialReason(session, { url });
  if (denialReason) {
    throw new Error(`Cookie URL blocked by domain policy: ${denialReason}`);
  }
};

export class SkillCliServer {
  readonly registry: SessionRegistry;

  constructor(options: SkillCliServerOptions = {}) {
    this.registry = options.registry ?? new SessionRegistry();
  }

  private async _require_node_by_index(browser_session: any, index: unknown) {
    const parsedIndex = Number(index);
    if (!Number.isFinite(parsedIndex)) {
      throw new Error('Missing index');
    }

    const node = await browser_session.get_dom_element_by_index(parsedIndex);
    if (!node) {
      return {
        error: `Element index ${parsedIndex} not found - page may have changed`,
      };
    }

    return node;
  }

  private async _run_with_page_validation<T>(
    browser_session: any,
    action: () => Promise<T>
  ): Promise<T> {
    const page = await browser_session.get_current_page?.();
    await browser_session.validate_page_after_action?.(page);
    try {
      return await action();
    } finally {
      await browser_session.validate_page_after_action?.(page);
    }
  }

  private async _read_node_data(
    browser_session: any,
    node: any,
    kind: 'text' | 'value' | 'attributes' | 'bbox'
  ) {
    if (!node?.xpath) {
      throw new Error('DOM element does not include an XPath selector');
    }

    const page = await browser_session.get_current_page();
    if (!page?.evaluate) {
      throw new Error('No active page available');
    }

    return await this._run_with_page_validation(browser_session, () =>
      readBoundedCliElementData(page, node.xpath, kind)
    );
  }

  private async _handle_browser_action(
    action: string,
    sessionName: string,
    params: Record<string, unknown>
  ): Promise<any> {
    const session = await this.registry.get_or_create_session(sessionName);
    const browser_session = session.browser_session;

    if (action === 'open') {
      let url = String(params.url ?? '').trim();
      if (!url) {
        throw new Error('Missing url');
      }
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
        url = `https://${url}`;
      }
      await browser_session.navigate_to(url);
      return { url };
    }

    if (action === 'click') {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }
      await browser_session._click_element_node(node);
      return { clicked: Number(params.index) };
    }

    if (action === 'hover') {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }
      const locator = await browser_session.get_locate_element(node);
      if (!locator?.hover) {
        throw new Error('Hover is not available for this element');
      }
      await this._run_with_page_validation(browser_session, async () =>
        locator.hover({ timeout: 5000 })
      );
      return { hovered: Number(params.index) };
    }

    if (action === 'dblclick') {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }
      const locator = await browser_session.get_locate_element(node);
      if (!locator?.dblclick) {
        throw new Error('Double-click is not available for this element');
      }
      await this._run_with_page_validation(browser_session, async () =>
        locator.dblclick({ timeout: 5000 })
      );
      return { double_clicked: Number(params.index) };
    }

    if (action === 'rightclick') {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }
      const locator = await browser_session.get_locate_element(node);
      if (!locator?.click) {
        throw new Error('Right-click is not available for this element');
      }
      await this._run_with_page_validation(browser_session, async () =>
        locator.click({ button: 'right', timeout: 5000 })
      );
      return { right_clicked: Number(params.index) };
    }

    if (action === 'type') {
      const text = String(params.text ?? '');
      await browser_session.send_keys(text);
      return { typed: true, characters: text.length };
    }

    if (action === 'input') {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }
      const text = String(params.text ?? '');
      const clear = typeof params.clear === 'boolean' ? params.clear : true;
      await browser_session._input_text_element_node(node, text, { clear });
      return {
        input: Number(params.index),
        characters: text.length,
        clear,
      };
    }

    if (action === 'state') {
      const state = await browser_session.get_browser_state_with_recovery({
        include_screenshot: false,
      });
      const page_info =
        typeof browser_session.get_page_info === 'function'
          ? await browser_session.get_page_info()
          : null;
      return {
        url: state.url,
        title: state.title,
        tabs: state.tabs,
        page_info,
        llm_representation: state.llm_representation(),
      };
    }

    if (action === 'screenshot') {
      const screenshot = await browser_session.take_screenshot(
        Boolean(params.full)
      );
      if (!screenshot) {
        throw new Error('Failed to capture screenshot');
      }

      const file = typeof params.file === 'string' ? params.file.trim() : '';
      if (!file) {
        return { screenshot };
      }

      const filePath = path.resolve(file);
      await writePrivateBinaryFile(filePath, Buffer.from(screenshot, 'base64'));
      return { file: filePath };
    }

    if (action === 'wait_selector') {
      const selector = String(params.selector ?? '');
      if (!selector) {
        throw new Error('Missing selector');
      }
      const timeout = normalizeCliWaitTimeout(params.timeout);
      await browser_session.wait_for_element(selector, timeout);
      return { waited_for: 'selector', selector, timeout };
    }

    if (action === 'wait_text') {
      const text = String(params.text ?? '');
      if (!text) {
        throw new Error('Missing text');
      }
      const timeout = normalizeCliWaitTimeout(params.timeout);
      const page = await browser_session.get_current_page();
      if (!page?.getByText) {
        throw new Error('No active page available for wait_text');
      }
      await this._run_with_page_validation(browser_session, () =>
        waitForVisiblePageText(page, text, timeout)
      );
      return { waited_for: 'text', text, timeout };
    }

    if (action === 'scroll') {
      let direction: 'up' | 'down' | 'left' | 'right' = 'down';
      if (
        typeof params.direction === 'string' &&
        ['up', 'down', 'left', 'right'].includes(params.direction)
      ) {
        direction = params.direction as 'up' | 'down' | 'left' | 'right';
      }
      const amount = Number(params.amount ?? 500);
      await browser_session.scroll(direction, amount);
      return { direction, amount };
    }

    if (action === 'back') {
      await browser_session.go_back();
      return { navigated: 'back' };
    }

    if (action === 'forward') {
      await browser_session.go_forward();
      return { navigated: 'forward' };
    }

    if (action === 'switch') {
      const identifier = params.tab ?? params.target_id;
      if (typeof identifier !== 'string' && typeof identifier !== 'number') {
        throw new Error('Missing tab');
      }
      await browser_session.switch_to_tab(identifier);
      return {
        active_tab:
          browser_session.active_tab?.target_id ??
          browser_session.active_tab?.tab_id ??
          browser_session.active_tab?.page_id ??
          null,
      };
    }

    if (action === 'close_tab' || action === 'close-tab') {
      const identifier =
        params.tab ??
        params.target_id ??
        browser_session.active_tab?.target_id ??
        browser_session.active_tab?.page_id ??
        browser_session.active_tab_index;
      if (typeof identifier !== 'string' && typeof identifier !== 'number') {
        throw new Error('Missing tab');
      }
      await browser_session.close_tab(identifier);
      return { closed_tab: identifier };
    }

    if (action === 'keys') {
      const keys = String(params.keys ?? '');
      if (!keys) {
        throw new Error('Missing keys');
      }
      await browser_session.send_keys(keys);
      return { keys: true };
    }

    if (action === 'select') {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }
      const value = String(params.value ?? '');
      if (!value) {
        throw new Error('Missing value');
      }
      await browser_session.select_dropdown_option(node, value);
      return {
        index: Number(params.index),
        selected: true,
      };
    }

    if (action === 'html') {
      const selector =
        typeof params.selector === 'string'
          ? params.selector.trim().slice(0, MAX_PAGE_HTML_SELECTOR_CHARS)
          : '';
      if (!selector) {
        return { html: await browser_session.get_page_html() };
      }

      const page = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new Error('No active page available for html');
      }
      const result = await this._run_with_page_validation(browser_session, () =>
        extractBoundedPageHtml(page, MAX_MAIN_PAGE_HTML_CHARS, { selector })
      );
      if (!result.rootFound || result.html.length === 0) {
        throw new Error(`No element found for selector: ${selector}`);
      }
      return { selector, html: result.html, truncated: result.truncated };
    }

    if (action === 'eval') {
      const script = String(params.js ?? params.script ?? '').trim();
      if (!script) {
        throw new Error('Missing js');
      }
      const page = await browser_session.get_current_page?.();
      if (!page?.evaluate) {
        throw new Error('No active page available for eval');
      }
      const evaluation = await this._run_with_page_validation(
        browser_session,
        () => evaluateBoundedCliScript(page, script)
      );
      if (!evaluation.ok) {
        throw new Error(evaluation.error || 'JavaScript evaluation failed');
      }
      let result: unknown = evaluation.output;
      if (evaluation.output === 'undefined') {
        result = undefined;
      } else if (evaluation.output !== undefined) {
        try {
          result = JSON.parse(evaluation.output);
        } catch {
          // A size-truncated JSON value is intentionally returned as text.
        }
      }
      return {
        result,
        ...(evaluation.truncated ? { truncated: true } : {}),
      };
    }

    if (action === 'extract') {
      const query = String(params.query ?? '').trim();
      if (!query) {
        throw new Error('Missing query');
      }
      return {
        query,
        error:
          'extract requires agent mode - use: browser-use run "extract ..."',
      };
    }

    if (action === 'get_title') {
      const page = await browser_session.get_current_page?.();
      if (!page?.title) {
        throw new Error('No active page available for get_title');
      }
      return {
        title: await this._run_with_page_validation(browser_session, () =>
          readBoundedPageTitle(page)
        ),
      };
    }

    if (action === 'get_html') {
      const selector =
        typeof params.selector === 'string'
          ? params.selector.trim().slice(0, MAX_PAGE_HTML_SELECTOR_CHARS)
          : '';
      return selector
        ? await this._handle_browser_action('html', sessionName, { selector })
        : await this._handle_browser_action('html', sessionName, {});
    }

    if (
      action === 'get_text' ||
      action === 'get_value' ||
      action === 'get_attributes' ||
      action === 'get_bbox'
    ) {
      const node = await this._require_node_by_index(
        browser_session,
        params.index
      );
      if ('error' in node) {
        return node;
      }

      const kind = action.replace('get_', '') as
        | 'text'
        | 'value'
        | 'attributes'
        | 'bbox';
      const value = await this._read_node_data(browser_session, node, kind);
      if (value == null) {
        throw new Error(`Unable to retrieve ${kind} for element`);
      }

      return {
        index: Number(params.index),
        [kind]: value,
      };
    }

    if (action === 'cookies_get') {
      const url = typeof params.url === 'string' ? params.url.trim() : '';
      if (url) {
        assertCookieUrlAllowed(browser_session, url);
      }
      const allCookies =
        (await browser_session.get_cookies()) as BrowserCookieInit[];
      const allowedCookies = filterAllowedCookies(browser_session, allCookies);
      const cookies = url
        ? allowedCookies.filter((cookie: BrowserCookieInit) =>
            cookieMatchesUrl(cookie, url)
          )
        : allowedCookies;
      return { cookies, count: cookies.length };
    }

    if (action === 'cookies_set') {
      const name = String(params.name ?? '').trim();
      const value = String(params.value ?? '');
      if (!name) {
        throw new Error('Missing cookie name');
      }
      if (!browser_session.browser_context?.addCookies) {
        throw new Error('Browser context does not support setting cookies');
      }

      const currentPage = await browser_session.get_current_page?.();
      const currentUrl =
        typeof currentPage?.url === 'function' ? currentPage.url() : '';
      const cookie: BrowserCookieInit = {
        name,
        value,
        url:
          typeof params.url === 'string' && params.url.trim().length > 0
            ? params.url.trim()
            : undefined,
        domain:
          typeof params.domain === 'string' ? params.domain.trim() : undefined,
        path: typeof params.path === 'string' ? params.path : '/',
        secure: Boolean(params.secure),
        httpOnly: Boolean(params.http_only),
        sameSite: normalizeSameSite(params.same_site ?? params.sameSite),
        expires: parseCookieExpires(params.expires),
      };

      if (!cookie.url && !cookie.domain && currentUrl) {
        cookie.url = currentUrl;
      }
      if (!cookie.url && !cookie.domain) {
        throw new Error('Provide cookie url/domain or open a page first');
      }

      const denialReason = getCookieDenialReason(browser_session, cookie);
      if (denialReason) {
        throw new Error(
          `Cookie target blocked by domain policy: ${denialReason}`
        );
      }
      await browser_session.browser_context.addCookies([cookie]);
      return { set: name };
    }

    if (action === 'cookies_clear') {
      if (!browser_session.browser_context?.clearCookies) {
        throw new Error('Browser context does not support clearing cookies');
      }
      const url = typeof params.url === 'string' ? params.url.trim() : '';
      if (!url) {
        if (typeof browser_session.get_cookies !== 'function') {
          await browser_session.browser_context.clearCookies();
          return { cleared: true };
        }
        const allCookies = (await browser_session.get_cookies({
          include_blocked: true,
        })) as BrowserCookieInit[];
        const { allowedCookies, blockedCookies } = partitionAllowedCookies(
          browser_session,
          allCookies
        );
        if (allowedCookies.length === 0 && blockedCookies.length > 0) {
          return { cleared: true, count: 0 };
        }
        if (
          blockedCookies.length > 0 &&
          !browser_session.browser_context.addCookies
        ) {
          throw new Error(
            'Browser context does not support preserving blocked cookies'
          );
        }
        await browser_session.browser_context.clearCookies();
        if (blockedCookies.length > 0) {
          await browser_session.browser_context.addCookies(blockedCookies);
        }
        return { cleared: true, count: allowedCookies.length };
      }

      assertCookieUrlAllowed(browser_session, url);
      const allCookies = (await browser_session.get_cookies({
        include_blocked: true,
      })) as BrowserCookieInit[];
      const remainingCookies = allCookies.filter(
        (cookie: BrowserCookieInit) => !cookieMatchesUrl(cookie, url)
      );
      const removedCount = allCookies.length - remainingCookies.length;
      if (
        remainingCookies.length > 0 &&
        !browser_session.browser_context.addCookies
      ) {
        throw new Error(
          'Browser context does not support preserving non-matching cookies'
        );
      }
      await browser_session.browser_context.clearCookies();
      if (remainingCookies.length > 0) {
        await browser_session.browser_context.addCookies(remainingCookies);
      }
      return { cleared: true, url, count: removedCount };
    }

    if (action === 'cookies_export') {
      const file = String(params.file ?? '').trim();
      if (!file) {
        throw new Error('Missing file');
      }
      const url = typeof params.url === 'string' ? params.url.trim() : '';
      if (url) {
        assertCookieUrlAllowed(browser_session, url);
      }
      const allCookies =
        (await browser_session.get_cookies()) as BrowserCookieInit[];
      const allowedCookies = filterAllowedCookies(browser_session, allCookies);
      const cookies = url
        ? allowedCookies.filter((cookie: BrowserCookieInit) =>
            cookieMatchesUrl(cookie, url)
          )
        : allowedCookies;
      const filePath = path.resolve(file);
      await writePrivateJsonFile(filePath, cookies);
      return { file: filePath, count: cookies.length };
    }

    if (action === 'cookies_import') {
      const file = String(params.file ?? '').trim();
      if (!file) {
        throw new Error('Missing file');
      }
      if (!browser_session.browser_context?.addCookies) {
        throw new Error('Browser context does not support importing cookies');
      }
      const filePath = path.resolve(file);
      const raw = await readBoundedCookieImportFile(filePath);
      const cookies = parseBoundedCookieImport(raw);
      const importedCookies = cookies.map((cookie) => {
        if (!cookie || typeof cookie !== 'object') {
          throw new Error('Each imported cookie must be a JSON object');
        }
        const typedCookie = cookie as Partial<BrowserCookieInit>;
        if (
          typeof typedCookie.name !== 'string' ||
          typeof typedCookie.value !== 'string'
        ) {
          throw new Error(
            'Each imported cookie must include string name/value'
          );
        }
        return typedCookie as BrowserCookieInit;
      });
      const allowedCookies = filterAllowedCookies(
        browser_session,
        importedCookies
      );
      if (allowedCookies.length > 0) {
        await browser_session.browser_context.addCookies(allowedCookies);
      }
      return { file: filePath, imported: allowedCookies.length };
    }

    if (action === 'close') {
      await this.registry.close_session(sessionName);
      return { closed: sessionName };
    }

    if (action === 'sessions') {
      const sessions = this.registry.list_sessions();
      return { sessions, count: sessions.length };
    }

    throw new Error(`Unknown action: ${action}`);
  }

  async handle_request(request: Request | string) {
    const req =
      typeof request === 'string' ? Request.from_json(request) : request;
    try {
      const data = await this._handle_browser_action(
        req.action,
        req.session,
        req.params
      );
      if (data && typeof data === 'object' && 'error' in data) {
        return new Response({
          id: req.id,
          success: false,
          data: null,
          error: String((data as any).error),
        });
      }
      return new Response({
        id: req.id,
        success: true,
        data,
      });
    } catch (error) {
      return new Response({
        id: req.id,
        success: false,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
}
