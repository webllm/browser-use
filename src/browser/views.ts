import { DOMState } from '../dom/views.js';
import type { DOMHistoryElement } from '../dom/history-tree-processor/view.js';
import { readBoundedScreenshotFileSync } from '../screenshots/file.js';
import {
  boundBrowserStateText,
  boundBrowserStateTitle,
  boundBrowserStateUrl,
  MAX_BROWSER_STATE_MESSAGE_CHARS,
  MAX_BROWSER_STATE_MESSAGES,
  MAX_BROWSER_STATE_NETWORK_REQUESTS,
  MAX_BROWSER_STATE_PAGINATION_BUTTONS,
  MAX_BROWSER_STATE_RECENT_EVENTS_CHARS,
  MAX_BROWSER_STATE_TABS,
} from './state-limits.js';

export const PLACEHOLDER_4PX_SCREENSHOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=';

export interface TabInfo {
  page_id: number;
  tab_id?: string;
  target_id?: string;
  url: string;
  title: string;
  parent_page_id?: number | null;
}

export interface PageInfo {
  viewport_width: number;
  viewport_height: number;
  page_width: number;
  page_height: number;
  scroll_x: number;
  scroll_y: number;
  pixels_above: number;
  pixels_below: number;
  pixels_left: number;
  pixels_right: number;
}

export interface NetworkRequest {
  url: string;
  method?: string;
  loading_duration_ms?: number;
  resource_type?: string | null;
}

export interface PaginationButton {
  button_type: string;
  backend_node_id: number;
  text: string;
  selector: string;
  is_disabled?: boolean;
}

interface BrowserStateSummaryInit {
  url: string;
  title: string;
  tabs: TabInfo[];
  screenshot?: string | null;
  page_info?: PageInfo | null;
  pixels_above?: number;
  pixels_below?: number;
  browser_errors?: string[];
  is_pdf_viewer?: boolean;
  loading_status?: string | null;
  recent_events?: string | null;
  pending_network_requests?: NetworkRequest[];
  pagination_buttons?: PaginationButton[];
  closed_popup_messages?: string[];
}

export class BrowserStateSummary extends DOMState {
  url: string;
  title: string;
  tabs: TabInfo[];
  screenshot: string | null;
  page_info: PageInfo | null;
  pixels_above: number;
  pixels_below: number;
  browser_errors: string[];
  is_pdf_viewer: boolean;
  loading_status: string | null;
  recent_events: string | null;
  pending_network_requests: NetworkRequest[];
  pagination_buttons: PaginationButton[];
  closed_popup_messages: string[];

  constructor(dom_state: DOMState, init: BrowserStateSummaryInit) {
    super(dom_state.element_tree, dom_state.selector_map);
    this.url = boundBrowserStateUrl(init.url);
    this.title = boundBrowserStateTitle(init.title);
    this.tabs = (Array.isArray(init.tabs) ? init.tabs : [])
      .slice(0, MAX_BROWSER_STATE_TABS)
      .map((tab) => ({
        ...tab,
        url: boundBrowserStateUrl(tab?.url),
        title: boundBrowserStateTitle(tab?.title),
      }));
    this.screenshot = init.screenshot ?? null;
    this.page_info = init.page_info ?? null;
    this.pixels_above = init.pixels_above ?? 0;
    this.pixels_below = init.pixels_below ?? 0;
    this.browser_errors = (init.browser_errors ?? [])
      .slice(0, MAX_BROWSER_STATE_MESSAGES)
      .map((message) =>
        boundBrowserStateText(message, MAX_BROWSER_STATE_MESSAGE_CHARS)
      );
    this.is_pdf_viewer = init.is_pdf_viewer ?? false;
    this.loading_status = init.loading_status
      ? boundBrowserStateText(
          init.loading_status,
          MAX_BROWSER_STATE_MESSAGE_CHARS
        )
      : null;
    this.recent_events = init.recent_events
      ? boundBrowserStateText(
          init.recent_events,
          MAX_BROWSER_STATE_RECENT_EVENTS_CHARS
        )
      : null;
    this.pending_network_requests = (init.pending_network_requests ?? [])
      .slice(0, MAX_BROWSER_STATE_NETWORK_REQUESTS)
      .map((request) => ({
        ...request,
        url: boundBrowserStateUrl(request?.url),
        method: request?.method
          ? boundBrowserStateText(request.method, 32)
          : undefined,
        resource_type: request?.resource_type
          ? boundBrowserStateText(request.resource_type, 128)
          : null,
      }));
    this.pagination_buttons = (init.pagination_buttons ?? [])
      .slice(0, MAX_BROWSER_STATE_PAGINATION_BUTTONS)
      .map((button) => ({
        ...button,
        button_type: boundBrowserStateText(button?.button_type, 128),
        text: boundBrowserStateText(
          button?.text,
          MAX_BROWSER_STATE_MESSAGE_CHARS
        ),
        selector: boundBrowserStateText(button?.selector, 4 * 1024),
      }));
    this.closed_popup_messages = (init.closed_popup_messages ?? [])
      .slice(-MAX_BROWSER_STATE_MESSAGES)
      .map((message) =>
        boundBrowserStateText(message, MAX_BROWSER_STATE_MESSAGE_CHARS)
      );
  }
}

export class BrowserStateHistory {
  constructor(
    public url: string,
    public title: string,
    public tabs: TabInfo[],
    public interacted_element: Array<DOMHistoryElement | null>,
    public screenshot_path: string | null = null
  ) {}

  get_screenshot() {
    if (!this.screenshot_path) {
      return null;
    }

    return (
      readBoundedScreenshotFileSync(this.screenshot_path)?.data.toString(
        'base64'
      ) ?? null
    );
  }

  to_dict() {
    return {
      tabs: this.tabs,
      screenshot_path: this.screenshot_path,
      interacted_element: this.interacted_element.map(
        (element) => element?.to_dict?.() ?? null
      ),
      url: this.url,
      title: this.title,
    };
  }
}

export interface BrowserErrorInit {
  message: string;
  short_term_memory?: string | null;
  long_term_memory?: string | null;
  details?: Record<string, unknown> | null;
  event?: unknown;
}

export class BrowserError extends Error {
  short_term_memory: string | null;
  long_term_memory: string | null;
  details: Record<string, unknown> | null;
  while_handling_event: unknown;

  constructor(
    messageOrInit: string | BrowserErrorInit,
    options?: Omit<BrowserErrorInit, 'message'>
  ) {
    const init: BrowserErrorInit =
      typeof messageOrInit === 'string'
        ? { message: messageOrInit, ...(options ?? {}) }
        : messageOrInit;
    super(init.message);
    this.name = 'BrowserError';
    this.short_term_memory = init.short_term_memory ?? null;
    this.long_term_memory = init.long_term_memory ?? null;
    this.details = init.details ?? null;
    this.while_handling_event = init.event ?? null;
  }

  override toString() {
    if (this.details) {
      return `${this.message} (${JSON.stringify(this.details)})`;
    }
    if (this.while_handling_event) {
      return `${this.message} (while handling: ${String(this.while_handling_event)})`;
    }
    return this.message;
  }
}

export class URLNotAllowedError extends BrowserError {}
