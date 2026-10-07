/**
 * Anthropic browser toolset (`browser_toolset_20260801`) backed by Browser Use.
 *
 * Claude calls toolset members (`navigate`, `left_click`, `read_page`, ...) as
 * `tool_use` blocks carrying `toolset_name: "browser"`. This driver executes
 * them against a BrowserSession and builds the matching `tool_result` blocks,
 * including the `browser_state` tab inventory the API expects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { createCanvas, loadImage } from 'canvas';
import type {
  BrowserContext,
  ConsoleMessage,
  Download,
  ElementHandle,
  Frame,
  JSHandle,
  Page,
  Request,
  Response,
} from 'playwright';
import { z } from 'zod';
import { CloudBrowserClient } from '../../browser/cloud/cloud.js';
import type { CreateBrowserRequest } from '../../browser/cloud/views.js';
import { BrowserProfile } from '../../browser/profile.js';
import { BrowserSession } from '../../browser/session.js';
import {
  collectAccessibleEntries,
  createRefRegistry,
  elementClickPoint,
  frameContentOffset,
  resolveRegistryRef,
  type AccessibleEntry,
  type CollectAccessibleArgs,
  type RefRegistry,
} from './page-scripts.js';

export type BrowserToolsetParam =
  Anthropic.Beta.Messages.BetaBrowserToolset20260801;
export type BrowserToolsetConfigs =
  Anthropic.Beta.Messages.BetaBrowserToolsetConfigs;
export type BrowserStateBlock =
  Anthropic.Beta.Messages.BetaBrowserStateBlockParam;
export type BrowserStateChange = Anthropic.Beta.Messages.BetaBrowserStateChange;
export type BrowserStateTab = Anthropic.Beta.Messages.BetaBrowserStateTabEntry;
export type ToolResultBlock = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolResultContent = Exclude<
  ToolResultBlock['content'],
  string | undefined
>;

/** The parts of a `tool_use` block the driver reads. */
export type BrowserToolUse = Pick<
  Anthropic.Beta.Messages.BetaToolUseBlock,
  'id' | 'name' | 'input'
> & { toolset_name?: string | null };

export const BROWSER_TOOLSET_TYPE = 'browser_toolset_20260801';
export const BROWSER_TOOLSET_NAME = 'browser';
export const BATCH_HALT_TEXT =
  'Not executed: an earlier action in this turn failed.';

export const BROWSER_TOOLSET_MEMBERS = [
  'navigate',
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'hover',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'scroll',
  'scroll_to',
  'type',
  'key',
  'hold_key',
  'wait',
  'read_page',
  'find',
  'get_page_text',
  'form_input',
  'file_upload',
  'read_console',
  'read_network',
  'javascript_exec',
  'new_tab',
  'list_tabs',
  'switch_tab',
  'close_tab',
] as const;

export type BrowserToolsetMember = (typeof BROWSER_TOOLSET_MEMBERS)[number];

/** Members the API leaves out of the served schema unless enabled. */
export const DEFAULT_DISABLED_MEMBERS: ReadonlySet<BrowserToolsetMember> =
  new Set(['javascript_exec', 'file_upload', 'read_console', 'read_network']);

const MEMBER_SET: ReadonlySet<string> = new Set(BROWSER_TOOLSET_MEMBERS);
const TAB_MEMBERS: ReadonlySet<string> = new Set([
  'new_tab',
  'list_tabs',
  'switch_tab',
  'close_tab',
]);

const MAX_TABS = 100;
const MAX_STATE_CHANGES = 200;
const MAX_FIELD_CHARS = 4096;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_IMAGE_EDGE = 2000;
const MAX_LOG_LINE_CHARS = 8192;
const MAX_REQUEST_URL_CHARS = 2000;
const READ_PAGE_MAX_ENTRIES = 5000;
const FIND_MAX_ENTRIES = 10_000;
const FIND_MAX_RESULTS = 20;
const MAX_WALKED_FRAMES = 25;
const MAX_FRAME_DEPTH = 4;
const TITLE_TIMEOUT_MS = 1000;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const DEFAULT_ACTION_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Member inputs
// ---------------------------------------------------------------------------

const tabIdSchema = z.string().min(1).nullish();
const modifiersSchema = z.string().nullish();
const coordinateTargetSchema = z.object({
  type: z.literal('coordinate'),
  x: z.number(),
  y: z.number(),
});
const refTargetSchema = z.object({
  type: z.literal('ref'),
  ref: z.string().min(1),
});
const targetSchema = z.discriminatedUnion('type', [
  coordinateTargetSchema,
  refTargetSchema,
]);
const pointerSchema = z.object({
  target: targetSchema,
  modifiers: modifiersSchema,
  tab_id: tabIdSchema,
});
const coordinatePointerSchema = z.object({
  target: coordinateTargetSchema,
  modifiers: modifiersSchema,
  tab_id: tabIdSchema,
});
const tabOnlySchema = z.object({ tab_id: tabIdSchema });

const INPUT_SCHEMAS = {
  navigate: z.object({ url: z.string().min(1), tab_id: tabIdSchema }),
  screenshot: tabOnlySchema,
  zoom: z.object({
    region: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    tab_id: tabIdSchema,
  }),
  left_click: pointerSchema,
  right_click: pointerSchema,
  middle_click: pointerSchema,
  double_click: pointerSchema,
  triple_click: pointerSchema,
  hover: pointerSchema,
  mouse_move: coordinatePointerSchema,
  left_mouse_down: coordinatePointerSchema,
  left_mouse_up: coordinatePointerSchema,
  left_click_drag: z.object({
    from: coordinateTargetSchema,
    target: coordinateTargetSchema,
    modifiers: modifiersSchema,
    tab_id: tabIdSchema,
  }),
  scroll: z.object({
    target: coordinateTargetSchema,
    scroll_direction: z.enum(['up', 'down', 'left', 'right']),
    scroll_amount: z.number().int().min(1).max(10).nullish(),
    modifiers: modifiersSchema,
    tab_id: tabIdSchema,
  }),
  scroll_to: z.object({ target: refTargetSchema, tab_id: tabIdSchema }),
  type: z.object({ text: z.string(), tab_id: tabIdSchema }),
  key: z.object({
    text: z.string().min(1),
    repeat: z.number().int().min(1).max(100).nullish(),
    tab_id: tabIdSchema,
  }),
  hold_key: z.object({
    text: z.string().min(1),
    duration: z.number().min(0).max(30),
    tab_id: tabIdSchema,
  }),
  wait: z.object({ duration: z.number().min(0).max(30), tab_id: tabIdSchema }),
  read_page: z.object({
    filter: z.enum(['default', 'interactive', 'all']).nullish(),
    depth: z.number().int().min(1).nullish(),
    ref: z.string().min(1).nullish(),
    tab_id: tabIdSchema,
  }),
  find: z.object({ query: z.string().min(1), tab_id: tabIdSchema }),
  get_page_text: tabOnlySchema,
  form_input: z.object({
    target: refTargetSchema,
    value: z.union([z.string(), z.number(), z.boolean()]),
    tab_id: tabIdSchema,
  }),
  file_upload: z.object({
    target: refTargetSchema,
    paths: z.array(z.string().min(1)).nullish(),
    document_ids: z.array(z.string().min(1)).nullish(),
    tab_id: tabIdSchema,
  }),
  read_console: tabOnlySchema,
  read_network: tabOnlySchema,
  javascript_exec: z.object({ text: z.string().min(1), tab_id: tabIdSchema }),
  new_tab: z.object({}),
  list_tabs: z.object({}),
  switch_tab: z.object({ tab_id: z.string().min(1) }),
  close_tab: z.object({ tab_id: z.string().min(1) }),
} satisfies Record<BrowserToolsetMember, z.ZodType>;

type MemberInput<M extends BrowserToolsetMember> = z.infer<
  (typeof INPUT_SCHEMAS)[M]
>;
type Target = z.infer<typeof targetSchema>;
type PointerInput = z.infer<typeof pointerSchema>;
type MouseButton = 'left' | 'right' | 'middle';

type MemberOutput = { text: string } | { image: string } | { tabs: true };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrowserToolCall {
  id: string;
  name: BrowserToolsetMember;
  input: unknown;
}

export interface BrowserUseToolsetOptions {
  /**
   * A started BrowserSession to borrow. The application keeps responsibility
   * for stopping it. When omitted the toolset launches and owns a session.
   */
  browser?: BrowserSession;
  /** Profile for the session the toolset launches when `browser` is omitted. */
  browserProfile?: BrowserProfile;
  /**
   * Launch and own a Browser Use Cloud browser instead of a local one.
   * Requires BROWSER_USE_API_KEY. Pass an object to set creation options.
   */
  useCloud?: boolean | CreateBrowserRequest;
  /**
   * Per-member overrides sent with the toolset. `javascript_exec`,
   * `file_upload`, `read_console`, and `read_network` are disabled unless
   * enabled here.
   */
  configs?: BrowserToolsetConfigs;
  /**
   * Approve each browser action before it runs. Returning false fails the
   * call, which also halts the remaining calls of that turn.
   */
  confirm?: (call: BrowserToolCall) => boolean | Promise<boolean>;
  /**
   * Directories `file_upload` may read local `paths` from. Local paths are
   * refused when no roots are configured.
   */
  uploadRoots?: string[];
  /** Maps `file_upload` document IDs to files on the browser host. */
  documentResolver?: (documentId: string) => string | Promise<string>;
  /**
   * Where completed downloads are saved. Defaults to the browser profile's
   * downloads_path.
   */
  downloadsPath?: string | null;
  /** Console and network entries kept per tab (default 1000). */
  maxLogEntries?: number;
  /** Upper bound for a single member call (default 120s). */
  actionTimeoutMs?: number;
}

/** An expected failure whose message is returned to Claude verbatim. */
export class BrowserToolsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserToolsetError';
  }
}

interface RefOwner {
  page: Page;
  frame: Frame;
  registry: JSHandle<RefRegistry>;
}

interface PageState {
  console: string[];
  network: string[];
  status: number | null;
  held: { x: number; y: number; buttons: Set<MouseButton> } | null;
  detach: () => void;
}

interface TabEntry {
  tab_id: string;
  title: string;
  url: string;
  page: Page;
  active: boolean;
}

interface WalkBudget {
  entries: number;
  frames: number;
  truncated: boolean;
}

type WalkArgs = Omit<CollectAccessibleArgs, 'maxEntries' | 'nextRef'>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isMember = (name: string): name is BrowserToolsetMember =>
  MEMBER_SET.has(name);

// Tab fields must not contain control characters or line separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

const cleanField = (value: string) =>
  value.replace(CONTROL_CHARS, ' ').slice(0, MAX_FIELD_CHARS);

const firstLine = (message: string) =>
  (message.split('\n').find((line) => line.trim()) ?? message).trim();

const describeError = (error: unknown) => {
  if (error instanceof BrowserToolsetError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${firstLine(message).slice(0, 2000) || 'Browser action failed'}`;
};

const truncateOutput = (text: string, note: string) =>
  text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS - 100)}\n[${note}]`
    : text;

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);

const pngSize = (buffer: Buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

const resizePng = async (buffer: Buffer, width: number, height: number) => {
  const size = pngSize(buffer);
  if (size.width === width && size.height === height) {
    return buffer;
  }
  const image = await loadImage(buffer);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.quality = 'best';
  context.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer('image/png');
};

const MODIFIER_ALIASES: Record<string, string> = {
  alt: 'Alt',
  option: 'Alt',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  shift: 'Shift',
};

const parseModifiers = (text: string | null | undefined): string[] => {
  if (!text || !text.trim()) {
    return [];
  }
  const keys: string[] = [];
  for (const part of text.split('+')) {
    const key = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!key) {
      throw new BrowserToolsetError(`Unsupported modifier ${part.trim()}`);
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
};

const KEY_ALIASES: Record<string, string> = {
  ...MODIFIER_ALIASES,
  enter: 'Enter',
  return: 'Enter',
  kpenter: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  prior: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  next: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  capslock: 'CapsLock',
  contextmenu: 'ContextMenu',
  menu: 'ContextMenu',
};

const normalizeKey = (key: string) => {
  if (key.length === 1) {
    return key;
  }
  const lookup = key.toLowerCase().replace(/[_\-\s]/g, '');
  if (KEY_ALIASES[lookup]) {
    return KEY_ALIASES[lookup];
  }
  if (/^f([1-9]|1\d|2[0-4])$/.test(lookup)) {
    return lookup.toUpperCase();
  }
  return key;
};

/** Split a chord such as `ctrl+shift+t` or `ctrl++` into Playwright keys. */
const parseChord = (chord: string): string[] => {
  const parts: string[] = [];
  let rest = chord;
  if (rest.endsWith('++')) {
    rest = rest.slice(0, -2);
    parts.push(...(rest ? rest.split('+') : []), '+');
  } else if (rest === '+') {
    parts.push('+');
  } else {
    parts.push(...rest.split('+'));
  }
  if (parts.some((part) => !part)) {
    throw new BrowserToolsetError(`Invalid key chord ${chord}`);
  }
  const keys = parts.map(normalizeKey);
  const modifiers = keys.slice(0, -1);
  const last = keys[keys.length - 1]!;
  // Shift+letter should produce the shifted character, as a user would type.
  if (
    last.length === 1 &&
    modifiers.includes('Shift') &&
    !modifiers.some((key) => ['Control', 'Alt', 'Meta'].includes(key))
  ) {
    keys[keys.length - 1] = last.toUpperCase();
  }
  return keys;
};

const withScheme = (url: string) => {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) {
    return url;
  }
  if (/^(about|data|blob|file|chrome|javascript|mailto):/i.test(url)) {
    return url;
  }
  return `https://${url}`;
};

const FIND_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'for',
  'with',
  'please',
  'find',
  'element',
  'on',
  'this',
  'page',
]);

const FIND_SYNONYMS: Record<string, string[]> = {
  bar: ['textbox', 'searchbox', 'input'],
  field: ['textbox', 'searchbox', 'combobox', 'input'],
  input: ['textbox', 'searchbox', 'combobox'],
  dropdown: ['combobox', 'listbox'],
  search: ['searchbox'],
  box: ['textbox', 'checkbox', 'searchbox'],
};

const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

const formatEntries = (entries: AccessibleEntry[], truncated: boolean) => {
  let text = entries
    .map(
      (entry) =>
        `${'  '.repeat(entry.depth)}${entry.ref ? `[${entry.ref}] ` : ''}${entry.description}`
    )
    .join('\n');
  if (!text) {
    return '(No matching accessible elements.)';
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS - 100);
    truncated = true;
  }
  return truncated
    ? `${text}\n[Truncated: narrow with ref or smaller depth.]`
    : text;
};

const pathInside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Executes Anthropic browser toolset calls with Browser Use.
 *
 * Send `toolset.toolParam()` in the request's `tools`, run each browser
 * `tool_use` block with `execute()` (or a whole turn with `executeBatch()`),
 * and send the returned `tool_result` blocks back. `runBrowserToolsetConversation`
 * wraps that loop.
 */
export class BrowserUseToolset {
  readonly name = BROWSER_TOOLSET_NAME;
  /** Files saved by completed downloads, in completion order. */
  readonly completedDownloadPaths: string[] = [];

  private _browser: BrowserSession | null;
  private readonly _ownsBrowser: boolean;
  private readonly _browserProfile: BrowserProfile | null;
  private readonly _cloudRequest: CreateBrowserRequest | null;
  private _cloudClient: CloudBrowserClient | null = null;
  private _cloudBrowserId: string | null = null;
  private readonly _configs: BrowserToolsetConfigs;
  private readonly _confirm: BrowserUseToolsetOptions['confirm'] | null;
  private readonly _uploadRoots: string[] | null;
  private readonly _documentResolver:
    | BrowserUseToolsetOptions['documentResolver']
    | null;
  private readonly _downloadsPathOption: string | null | undefined;
  private readonly _maxLogEntries: number;
  private readonly _actionTimeoutMs: number;

  private _startPromise: Promise<void> | null = null;
  private _started = false;
  private _closed = false;
  private _queue: Promise<unknown> = Promise.resolve();
  private _context: BrowserContext | null = null;
  private _onContextPage: ((page: Page) => void) | null = null;
  private readonly _pages = new Map<Page, PageState>();
  private readonly _refs = new Map<string, RefOwner>();
  private readonly _registries = new Map<Frame, JSHandle<RefRegistry>>();
  private _nextRef = 1;
  private _reportedTabIds = new Set<string>();
  private _lastSignature: string | null = null;
  private _pendingChanges: BrowserStateChange[] = [];
  private _nextDownload = 1;
  private readonly _background = new Set<Promise<unknown>>();

  constructor(options: BrowserUseToolsetOptions = {}) {
    if (options.browser && options.useCloud) {
      throw new Error('Pass either a BrowserSession or useCloud, not both.');
    }
    this._browser = options.browser ?? null;
    this._ownsBrowser = !options.browser;
    this._browserProfile = options.browserProfile ?? null;
    this._cloudRequest = options.useCloud
      ? options.useCloud === true
        ? {}
        : { ...options.useCloud }
      : null;
    const configs: Record<string, Record<string, unknown>> = {};
    for (const [member, config] of Object.entries(options.configs ?? {})) {
      if (!isMember(member)) {
        throw new Error(`Unknown browser toolset member in configs: ${member}`);
      }
      if (config) {
        configs[member] = { ...config };
      }
    }
    // Explicit, like the upstream driver: uploads stay off unless enabled.
    configs.file_upload = { enabled: false, ...configs.file_upload };
    this._configs = configs as BrowserToolsetConfigs;
    this._confirm = options.confirm ?? null;
    this._uploadRoots = options.uploadRoots
      ? options.uploadRoots.map((root) => path.resolve(root))
      : null;
    this._documentResolver = options.documentResolver ?? null;
    this._downloadsPathOption = options.downloadsPath;
    this._maxLogEntries = Math.max(1, options.maxLogEntries ?? 1000);
    this._actionTimeoutMs =
      options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** The BrowserSession actions run against. */
  get browser(): BrowserSession {
    if (!this._browser) {
      if (this._cloudRequest) {
        throw new Error(
          'The cloud browser is created when the toolset starts.'
        );
      }
      this._browser = new BrowserSession({
        browser_profile: this._browserProfile ?? new BrowserProfile({}),
      });
    }
    return this._browser;
  }

  /** The `tools[]` entry that declares this toolset to the API. */
  toolParam(): BrowserToolsetParam {
    return {
      type: BROWSER_TOOLSET_TYPE,
      configs: structuredClone(this._configs),
    };
  }

  /** Whether a member is offered to Claude under the current configs. */
  isEnabled(member: BrowserToolsetMember): boolean {
    const enabled = (
      this._configs as Record<string, { enabled?: boolean | null } | undefined>
    )[member]?.enabled;
    return enabled ?? !DEFAULT_DISABLED_MEMBERS.has(member);
  }

  /** Whether a `tool_use` block belongs to this toolset. */
  handles(block: BrowserToolUse): boolean {
    return block.toolset_name === BROWSER_TOOLSET_NAME;
  }

  async start(): Promise<this> {
    if (this._closed) {
      throw new Error('The browser toolset is closed.');
    }
    if (!this._startPromise) {
      this._startPromise = this._start().catch(async (error) => {
        this._startPromise = null;
        await this._releaseBrowser().catch(() => undefined);
        throw error;
      });
    }
    await this._startPromise;
    return this;
  }

  private async _start() {
    if (this._ownsBrowser) {
      if (this._cloudRequest) {
        const client = new CloudBrowserClient();
        const cloudBrowser = await client.create_browser(this._cloudRequest);
        this._cloudClient = client;
        this._cloudBrowserId = cloudBrowser.id;
        this._browser = new BrowserSession({
          browser_profile: this._browserProfile ?? new BrowserProfile({}),
          cdp_url: cloudBrowser.cdpUrl,
        });
      }
      await this.browser.start();
    } else if (!this.browser.initialized || !this.browser.browser_context) {
      throw new Error(
        'Start the borrowed BrowserSession before using the browser toolset.'
      );
    }
    const context = this.browser.browser_context;
    if (context) {
      this._context = context;
      this._onContextPage = (page: Page) => {
        this._observePage(page);
      };
      context.on('page', this._onContextPage);
      for (const page of context.pages()) {
        this._observePage(page);
      }
    }
    const tabs = await this._tabs();
    this._reportedTabIds = new Set(tabs.map((tab) => tab.tab_id));
    this._lastSignature = this._signature(tabs);
    this._started = true;
  }

  /**
   * Release held input, stop listening to the browser, and stop the browser
   * when the toolset launched it. A borrowed session stays open.
   */
  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    await this._queue.catch(() => undefined);
    const errors: unknown[] = [];
    for (const page of this._pages.keys()) {
      try {
        await this._releaseMouse(page);
      } catch (error) {
        errors.push(error);
      }
    }
    const timer = new AbortController();
    await Promise.race([
      Promise.allSettled([...this._background]),
      sleep(2000, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
    timer.abort();
    if (this._context && this._onContextPage) {
      this._context.off('page', this._onContextPage);
    }
    for (const state of this._pages.values()) {
      state.detach();
    }
    this._pages.clear();
    for (const registry of this._registries.values()) {
      void registry.dispose().catch(() => undefined);
    }
    this._registries.clear();
    this._refs.clear();
    try {
      await this._releaseBrowser();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw errors[0];
    }
  }

  private async _releaseBrowser() {
    if (!this._ownsBrowser) {
      return;
    }
    let failure: unknown = null;
    if (this._browser) {
      try {
        await this._browser.kill();
      } catch (error) {
        failure = error;
      }
    }
    if (this._cloudClient && this._cloudBrowserId) {
      try {
        await this._cloudClient.stop_browser(this._cloudBrowserId);
        this._cloudBrowserId = null;
      } catch (error) {
        failure = failure ?? error;
      }
    }
    if (failure) {
      throw failure;
    }
  }

  /** The result for a call skipped because an earlier call failed. */
  haltResult(block: BrowserToolUse): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      toolset_name: BROWSER_TOOLSET_NAME,
      is_error: true,
      content: BATCH_HALT_TEXT,
    };
  }

  /**
   * Run one turn's browser calls in order. After the first failure the
   * remaining calls are not executed and report the batch halt text.
   */
  async executeBatch(blocks: BrowserToolUse[]): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let halted = false;
    for (const block of blocks) {
      if (halted) {
        results.push(this.haltResult(block));
        continue;
      }
      const result = await this.execute(block);
      results.push(result);
      halted = Boolean(result.is_error);
    }
    return results;
  }

  /** Execute one member call. Failures become error results; this never throws. */
  execute(block: BrowserToolUse): Promise<ToolResultBlock> {
    const run = this._queue.then(
      () => this._execute(block),
      () => this._execute(block)
    );
    this._queue = run.catch(() => undefined);
    return run;
  }

  private async _execute(block: BrowserToolUse): Promise<ToolResultBlock> {
    const name = block.name;
    if (this._closed) {
      return this._errorResult(block, 'The browser toolset is closed.');
    }
    if (!isMember(name)) {
      return this._errorResult(block, `Unknown browser action: ${name}`);
    }
    if (!this.isEnabled(name)) {
      return this._errorResult(
        block,
        `${name} is disabled in this toolset's configs.`
      );
    }
    const parsed = INPUT_SCHEMAS[name].safeParse(block.input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ');
      return this._errorResult(block, `Invalid ${name} input: ${issues}`);
    }
    try {
      if (
        this._confirm &&
        !(await this._confirm({ id: block.id, name, input: parsed.data }))
      ) {
        return this._errorResult(
          block,
          'This browser action was not approved.'
        );
      }
      await this.start();
      const output = await this._withTimeout(
        this._run(name, parsed.data),
        name
      );
      return await this._successResult(block, name, output);
    } catch (error) {
      await this._syncAfterFailure();
      return this._errorResult(block, describeError(error));
    }
  }

  private async _withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new BrowserToolsetError(
              `${name} did not finish within ${Math.round(this._actionTimeoutMs / 1000)}s.`
            )
          ),
        this._actionTimeoutMs
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private _errorResult(
    block: BrowserToolUse,
    message: string
  ): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      toolset_name: BROWSER_TOOLSET_NAME,
      is_error: true,
      content: message,
    };
  }

  private async _successResult(
    block: BrowserToolUse,
    name: BrowserToolsetMember,
    output: MemberOutput
  ): Promise<ToolResultBlock> {
    const content: ToolResultContent = [];
    if ('text' in output) {
      content.push({ type: 'text', text: output.text || '(empty)' });
    } else if ('image' in output) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: output.image },
      });
    }
    const state = await this._browserState(TAB_MEMBERS.has(name));
    if (state) {
      content.push(state);
    }
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      toolset_name: BROWSER_TOOLSET_NAME,
      content,
    };
  }

  private _run(
    name: BrowserToolsetMember,
    input: unknown
  ): Promise<MemberOutput> {
    switch (name) {
      case 'navigate':
        return this._navigate(input as MemberInput<'navigate'>);
      case 'screenshot':
        return this._screenshotMember(input as MemberInput<'screenshot'>);
      case 'zoom':
        return this._zoom(input as MemberInput<'zoom'>);
      case 'left_click':
        return this._click(input as PointerInput, 'left', 1);
      case 'right_click':
        return this._click(input as PointerInput, 'right', 1);
      case 'middle_click':
        return this._click(input as PointerInput, 'middle', 1);
      case 'double_click':
        return this._click(input as PointerInput, 'left', 2);
      case 'triple_click':
        return this._click(input as PointerInput, 'left', 3);
      case 'hover':
      case 'mouse_move':
        return this._hover(input as PointerInput);
      case 'left_mouse_down':
        return this._leftMouseDown(input as MemberInput<'left_mouse_down'>);
      case 'left_mouse_up':
        return this._leftMouseUp(input as MemberInput<'left_mouse_up'>);
      case 'left_click_drag':
        return this._drag(input as MemberInput<'left_click_drag'>);
      case 'scroll':
        return this._scroll(input as MemberInput<'scroll'>);
      case 'scroll_to':
        return this._scrollTo(input as MemberInput<'scroll_to'>);
      case 'type':
        return this._type(input as MemberInput<'type'>);
      case 'key':
        return this._key(input as MemberInput<'key'>);
      case 'hold_key':
        return this._holdKey(input as MemberInput<'hold_key'>);
      case 'wait':
        return this._wait(input as MemberInput<'wait'>);
      case 'read_page':
        return this._readPage(input as MemberInput<'read_page'>);
      case 'find':
        return this._find(input as MemberInput<'find'>);
      case 'get_page_text':
        return this._getPageText(input as MemberInput<'get_page_text'>);
      case 'form_input':
        return this._formInput(input as MemberInput<'form_input'>);
      case 'file_upload':
        return this._fileUpload(input as MemberInput<'file_upload'>);
      case 'read_console':
        return this._readLog(input as MemberInput<'read_console'>, 'console');
      case 'read_network':
        return this._readLog(input as MemberInput<'read_network'>, 'network');
      case 'javascript_exec':
        return this._javascript(input as MemberInput<'javascript_exec'>);
      case 'new_tab':
        return this._newTab();
      case 'list_tabs':
        return Promise.resolve({ tabs: true });
      case 'switch_tab':
        return this._switchTab(input as MemberInput<'switch_tab'>);
      case 'close_tab':
        return this._closeTab(input as MemberInput<'close_tab'>);
    }
  }

  // -------------------------------------------------------------------------
  // Tabs and browser state
  // -------------------------------------------------------------------------

  private async _tabEntries(): Promise<TabEntry[]> {
    const read = () =>
      this.browser
        .get_tab_pages()
        .filter(
          (entry): entry is typeof entry & { page: Page } =>
            Boolean(entry.page) && !entry.page!.isClosed()
        );
    let entries = read();
    if (entries.length && !entries.some((entry) => entry.active)) {
      // The focused page closed itself; focus the first remaining tab so the
      // inventory keeps exactly one active tab.
      await this.browser.switch_to_tab(entries[0]!.tab_id);
      entries = read();
    }
    return entries.map((entry) => ({
      tab_id: entry.tab_id,
      title: entry.title,
      url: entry.url,
      page: entry.page,
      active: entry.active,
    }));
  }

  private async _tabs(): Promise<BrowserStateTab[]> {
    const entries = (await this._tabEntries()).slice(0, MAX_TABS);
    return Promise.all(
      entries.map(async (entry) => {
        this._observePage(entry.page);
        let url = entry.url;
        try {
          url = entry.page.url();
        } catch {
          // Keep the session's last known URL.
        }
        const title = await this._title(entry.page, entry.title);
        return {
          tab_id: cleanField(entry.tab_id),
          title: cleanField(title),
          url: cleanField(url),
          active: entry.active,
        };
      })
    );
  }

  private async _title(page: Page, fallback: string) {
    // Abort the fallback timer once the race settles so it cannot keep the
    // process alive.
    const timer = new AbortController();
    try {
      return await Promise.race([
        page.title(),
        sleep(TITLE_TIMEOUT_MS, fallback, { signal: timer.signal }),
      ]);
    } catch {
      return fallback;
    } finally {
      timer.abort();
    }
  }

  private _signature(tabs: BrowserStateTab[]) {
    return JSON.stringify(tabs.map((tab) => [tab.tab_id, tab.url, tab.active]));
  }

  /**
   * Build the browser_state block for a successful call. Tab members always
   * carry one; other members carry one only when the inventory changed or
   * there are state changes to report.
   */
  private async _browserState(
    force: boolean
  ): Promise<BrowserStateBlock | null> {
    const tabs = await this._tabs();
    const changes: BrowserStateChange[] = [];
    for (const tab of tabs) {
      if (!this._reportedTabIds.has(tab.tab_id)) {
        changes.push({ type: 'tab_opened', tab_id: tab.tab_id });
      }
    }
    changes.push(...this._drainDownloadChanges());
    this._reportedTabIds = new Set(tabs.map((tab) => tab.tab_id));
    const signature = this._signature(tabs);
    const changed = signature !== this._lastSignature;
    this._lastSignature = signature;
    if (!force && !changed && changes.length === 0) {
      return null;
    }
    const block: BrowserStateBlock = { type: 'browser_state', tabs };
    if (changes.length) {
      block.state_changes = changes.slice(0, MAX_STATE_CHANGES);
    }
    return block;
  }

  private async _syncAfterFailure() {
    // A tab opened during a failed call gets no deferred tab_opened; it simply
    // appears in the next inventory.
    try {
      if (this._started) {
        const tabs = await this._tabs();
        this._reportedTabIds = new Set(tabs.map((tab) => tab.tab_id));
      }
    } catch {
      // State reporting must keep working after a failed action.
    }
  }

  private _drainDownloadChanges(): BrowserStateChange[] {
    // At most one state change per download in a result: the latest wins.
    const latest = new Map<string, BrowserStateChange>();
    for (const change of this._pendingChanges) {
      if ('download_id' in change) {
        latest.delete(change.download_id);
        latest.set(change.download_id, change);
      }
    }
    this._pendingChanges = [];
    return [...latest.values()];
  }

  private async _page(tabId?: string | null): Promise<Page> {
    const entries = await this._tabEntries();
    const entry = tabId
      ? entries.find((candidate) => candidate.tab_id === tabId)
      : entries.find((candidate) => candidate.active);
    if (!entry) {
      throw new BrowserToolsetError(
        tabId
          ? `Tab ${tabId} is not open. Call list_tabs to see open tabs.`
          : 'No tab is open. Call new_tab first.'
      );
    }
    if (!entry.active) {
      await this.browser.switch_to_tab(entry.tab_id);
    }
    this._observePage(entry.page);
    return entry.page;
  }

  private _observePage(page: Page): PageState {
    const existing = this._pages.get(page);
    if (existing) {
      return existing;
    }
    const state: PageState = {
      console: [],
      network: [],
      status: null,
      held: null,
      detach: () => undefined,
    };
    const onConsole = (message: ConsoleMessage) => {
      this._pushLog(state.console, `${message.type()}: ${message.text()}`);
    };
    const onPageError = (error: Error) => {
      this._pushLog(state.console, `error: ${error.stack || error.message}`);
    };
    const onRequestFinished = (request: Request) => {
      void this._recordRequest(state, request, null);
    };
    const onRequestFailed = (request: Request) => {
      void this._recordRequest(
        state,
        request,
        request.failure()?.errorText || 'Failed'
      );
    };
    const onResponse = (response: Response) => {
      try {
        if (
          response.request().isNavigationRequest() &&
          response.frame() === page.mainFrame()
        ) {
          state.status = response.status();
        }
      } catch {
        // Responses of detached frames are irrelevant to navigation status.
      }
    };
    const onDownload = (download: Download) => {
      this._trackDownload(download);
    };
    const onClose = () => {
      this._forgetPage(page);
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);
    page.on('download', onDownload);
    page.on('close', onClose);
    state.detach = () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
      page.off('download', onDownload);
      page.off('close', onClose);
    };
    this._pages.set(page, state);
    return state;
  }

  private _forgetPage(page: Page) {
    const state = this._pages.get(page);
    state?.detach();
    this._pages.delete(page);
    this._invalidateRefs(page);
  }

  private _pushLog(buffer: string[], line: string) {
    buffer.push(line.slice(0, MAX_LOG_LINE_CHARS));
    if (buffer.length > this._maxLogEntries) {
      buffer.splice(0, buffer.length - this._maxLogEntries);
    }
  }

  private async _recordRequest(
    state: PageState,
    request: Request,
    error: string | null
  ) {
    const row: Record<string, unknown> = {
      method: request.method(),
      url: request.url().slice(0, MAX_REQUEST_URL_CHARS),
    };
    if (!error) {
      const response = await request.response().catch(() => null);
      if (response) {
        row.status = response.status();
        const contentType = response.headers()['content-type'];
        if (contentType) {
          row.mime = contentType.split(';')[0]!.trim();
        }
      }
    }
    const timing = request.timing();
    if (timing.responseEnd >= 0) {
      row.duration_ms = Math.round(timing.responseEnd * 10) / 10;
    }
    if (error) {
      row.error = error;
    }
    this._pushLog(state.network, JSON.stringify(row));
  }

  private _downloadsPath() {
    if (this._downloadsPathOption !== undefined) {
      return this._downloadsPathOption;
    }
    return this._browser?.browser_profile.downloads_path ?? null;
  }

  private _trackDownload(download: Download) {
    const downloadId = `download_${this._nextDownload++}`;
    const url = download.url();
    this._pendingChanges.push({
      type: 'download_started',
      download_id: downloadId,
      url,
    });
    const task = (async () => {
      let savedPath: string | null = null;
      try {
        const directory = this._downloadsPath();
        if (directory) {
          fs.mkdirSync(directory, { recursive: true });
          const fileName = await BrowserSession.get_unique_filename(
            directory,
            download.suggestedFilename()
          );
          savedPath = path.join(directory, fileName);
          await download.saveAs(savedPath);
        } else {
          savedPath = await download.path().catch(() => null);
        }
      } catch {
        savedPath = null;
      }
      const failure = await download
        .failure()
        .catch((error: unknown) =>
          error instanceof Error ? error.message : String(error)
        );
      if (failure) {
        this._pendingChanges.push({
          type: 'download_failed',
          download_id: downloadId,
          url,
          error: cleanField(failure),
        });
        return;
      }
      let size: number | null = null;
      if (savedPath) {
        try {
          size = fs.statSync(savedPath).size;
          this.completedDownloadPaths.push(savedPath);
        } catch {
          savedPath = null;
        }
      }
      this._pendingChanges.push({
        type: 'download_completed',
        download_id: downloadId,
        url,
        ...(savedPath ? { path: cleanField(savedPath) } : {}),
        ...(size !== null ? { size_bytes: size } : {}),
      });
    })();
    this._background.add(task);
    void task.finally(() => this._background.delete(task));
  }

  // -------------------------------------------------------------------------
  // Element references
  // -------------------------------------------------------------------------

  private async _registry(frame: Frame): Promise<JSHandle<RefRegistry>> {
    const existing = this._registries.get(frame);
    if (existing) {
      try {
        await existing.evaluate(() => 0);
        return existing;
      } catch {
        // The document was replaced; its refs are stale.
        this._dropRegistry(frame, existing);
      }
    }
    const registry = await frame.evaluateHandle(createRefRegistry);
    this._registries.set(frame, registry);
    return registry;
  }

  private _dropRegistry(frame: Frame, registry: JSHandle<RefRegistry>) {
    this._registries.delete(frame);
    for (const [ref, owner] of this._refs) {
      if (owner.registry === registry) {
        this._refs.delete(ref);
      }
    }
    void registry.dispose().catch(() => undefined);
  }

  private _invalidateRefs(page: Page) {
    for (const [frame, registry] of [...this._registries]) {
      if (frame.page() === page) {
        this._dropRegistry(frame, registry);
      }
    }
    for (const [ref, owner] of this._refs) {
      if (owner.page === page) {
        this._refs.delete(ref);
      }
    }
  }

  private async _resolve(
    page: Page,
    ref: string
  ): Promise<{ element: ElementHandle<Element>; owner: RefOwner }> {
    const owner = this._refs.get(ref);
    if (!owner || owner.page !== page) {
      throw new BrowserToolsetError(
        `${ref} is stale or belongs to another tab. Call read_page or find again.`
      );
    }
    let element: ElementHandle<Element> | null = null;
    try {
      const handle = await owner.registry.evaluateHandle(
        resolveRegistryRef,
        ref
      );
      element = handle.asElement() as ElementHandle<Element> | null;
      if (!element) {
        await handle.dispose();
      }
    } catch {
      element = null;
    }
    if (!element) {
      this._refs.delete(ref);
      throw new BrowserToolsetError(
        `${ref} is stale. Call read_page or find again.`
      );
    }
    return { element, owner };
  }

  private async _walkFrame(
    page: Page,
    frame: Frame,
    args: WalkArgs,
    depthOffset: number,
    frameDepth: number,
    budget: WalkBudget
  ): Promise<AccessibleEntry[]> {
    const registry = await this._registry(frame);
    const result = await registry.evaluate(collectAccessibleEntries, {
      ...args,
      maxEntries: Math.max(1, budget.entries),
      nextRef: this._nextRef,
    });
    this._nextRef = Math.max(this._nextRef, result.nextRef);
    for (const ref of result.newRefs) {
      this._refs.set(ref, { page, frame, registry });
    }
    if (result.missingRoot) {
      this._refs.delete(args.rootRef ?? '');
      throw new BrowserToolsetError(
        `${args.rootRef} is stale. Call read_page or find again.`
      );
    }
    budget.entries -= result.entries.length;
    budget.truncated ||= result.truncated;
    const entries = result.entries.map((entry) => ({
      ...entry,
      depth: entry.depth + depthOffset,
    }));
    if (!result.frames.length || frameDepth >= MAX_FRAME_DEPTH) {
      return entries;
    }
    const children = await this._frameSlots(frame, registry);
    // Insert from the last slot so earlier insertion indices stay valid.
    for (const slot of [...result.frames].reverse()) {
      const child = children.get(slot.ref);
      if (!child || budget.frames <= 0 || budget.entries <= 0) {
        continue;
      }
      budget.frames -= 1;
      try {
        const childEntries = await this._walkFrame(
          page,
          child,
          { ...args, rootRef: null },
          slot.depth + depthOffset,
          frameDepth + 1,
          budget
        );
        entries.splice(slot.index, 0, ...childEntries);
      } catch {
        // Frames that navigate or detach mid-walk are skipped.
      }
    }
    return entries;
  }

  /** Map iframe element refs in `frame` to their Playwright child frames. */
  private async _frameSlots(frame: Frame, registry: JSHandle<RefRegistry>) {
    const slots = new Map<string, Frame>();
    for (const child of frame.childFrames()) {
      if (child.isDetached()) {
        continue;
      }
      let element: ElementHandle | null = null;
      try {
        element = await child.frameElement();
        const ref = await registry.evaluate(
          (value, frameElement) =>
            value.refs.get(frameElement as Element) ?? null,
          element
        );
        if (ref) {
          slots.set(ref, child);
        }
      } catch {
        // Detached or inaccessible frames are skipped.
      } finally {
        await element?.dispose().catch(() => undefined);
      }
    }
    return slots;
  }

  // -------------------------------------------------------------------------
  // Coordinates, screenshots, and input
  // -------------------------------------------------------------------------

  private async _viewport(page: Page) {
    const size = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (!size.width || !size.height) {
      throw new BrowserToolsetError('The page has no visible viewport.');
    }
    return size;
  }

  /** Screenshots larger than the image limit are downscaled by this factor. */
  private _imageScale(viewport: { width: number; height: number }) {
    return Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(viewport.width, viewport.height)
    );
  }

  /** Convert a frame-local point to top-level viewport coordinates. */
  private async _toTopCoordinates(
    frame: Frame,
    point: { x: number; y: number }
  ) {
    let { x, y } = point;
    let current: Frame | null = frame;
    while (current?.parentFrame()) {
      const element = await current.frameElement();
      try {
        const offset = await element.evaluate(frameContentOffset);
        x += offset.x;
        y += offset.y;
      } finally {
        await element.dispose().catch(() => undefined);
      }
      current = current.parentFrame();
    }
    return { x, y };
  }

  /** Resolve a target to top-level viewport coordinates (CSS pixels). */
  private async _point(page: Page, target: Target) {
    const viewport = await this._viewport(page);
    const scale = this._imageScale(viewport);
    let x: number;
    let y: number;
    if (target.type === 'coordinate') {
      x = target.x / scale;
      y = target.y / scale;
    } else {
      const { element, owner } = await this._resolve(page, target.ref);
      try {
        const local = await element.evaluate(elementClickPoint);
        ({ x, y } = await this._toTopCoordinates(owner.frame, local));
      } catch (error) {
        throw new BrowserToolsetError(
          `${target.ref} has no clickable point: ${firstLine(
            error instanceof Error ? error.message : String(error)
          )}`
        );
      } finally {
        await element.dispose().catch(() => undefined);
      }
    }
    if (!(x >= 0 && y >= 0 && x < viewport.width && y < viewport.height)) {
      throw new BrowserToolsetError(
        'Target lies outside the current viewport. Use scroll_to or a fresh screenshot.'
      );
    }
    return { x, y, scale };
  }

  private _formatPoint(point: { x: number; y: number; scale: number }) {
    return `(${formatNumber(point.x * point.scale)}, ${formatNumber(point.y * point.scale)})`;
  }

  private _state(page: Page) {
    return this._observePage(page);
  }

  private async _withModifiers<T>(
    page: Page,
    modifiers: string | null | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    const keys = parseModifiers(modifiers);
    const pressed: string[] = [];
    try {
      for (const key of keys) {
        await page.keyboard.down(key);
        pressed.push(key);
      }
      return await action();
    } finally {
      for (const key of pressed.reverse()) {
        await page.keyboard.up(key).catch(() => undefined);
      }
    }
  }

  private async _mouseDown(
    page: Page,
    x: number,
    y: number,
    button: MouseButton,
    clickCount: number
  ) {
    const state = this._state(page);
    await page.mouse.down({ button, clickCount });
    const held = state.held ?? { x, y, buttons: new Set<MouseButton>() };
    held.x = x;
    held.y = y;
    held.buttons.add(button);
    state.held = held;
  }

  private async _mouseUp(
    page: Page,
    x: number,
    y: number,
    button: MouseButton,
    clickCount: number
  ) {
    const state = this._state(page);
    await page.mouse.up({ button, clickCount });
    if (state.held) {
      state.held.x = x;
      state.held.y = y;
      state.held.buttons.delete(button);
      if (!state.held.buttons.size) {
        state.held = null;
      }
    }
  }

  private async _releaseMouse(page: Page) {
    const state = this._pages.get(page);
    if (!state?.held || page.isClosed()) {
      if (state) {
        state.held = null;
      }
      return;
    }
    const { x, y, buttons } = state.held;
    try {
      await page.mouse.move(x, y);
      for (const button of [...buttons]) {
        await page.mouse.up({ button, clickCount: 1 });
      }
    } finally {
      state.held = null;
    }
  }

  private _assertNoHeldButtons(page: Page, action: string) {
    if (this._state(page).held?.buttons.size) {
      throw new BrowserToolsetError(
        `Release held mouse buttons before starting a ${action}.`
      );
    }
  }

  private async _screenshot(page: Page) {
    const viewport = await this._viewport(page);
    const scale = this._imageScale(viewport);
    const buffer = await page.screenshot({
      type: 'png',
      scale: 'css',
      timeout: SCREENSHOT_TIMEOUT_MS,
    });
    const width = Math.max(1, Math.round(viewport.width * scale));
    const height = Math.max(1, Math.round(viewport.height * scale));
    return resizePng(buffer, width, height);
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  private async _navigate(
    input: MemberInput<'navigate'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    await this._releaseMouse(page);
    const state = this._state(page);
    state.status = null;
    const target = input.url.trim();
    try {
      if (target === 'back') {
        await this.browser.go_back();
      } else if (target === 'forward') {
        await this.browser.go_forward();
      } else if (target === 'reload') {
        await this.browser.refresh();
      } else {
        await this.browser.navigate_to(withScheme(target));
      }
    } finally {
      this._invalidateRefs(page);
    }
    const current = await this._page();
    const lines = [
      `url: ${current.url()}`,
      `title: ${await this._title(current, '')}`,
    ];
    const status = this._state(current).status;
    if (status !== null) {
      lines.push(`status: ${status}`);
    }
    return { text: lines.join('\n') };
  }

  private async _screenshotMember(
    input: MemberInput<'screenshot'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    return { image: (await this._screenshot(page)).toString('base64') };
  }

  private async _zoom(input: MemberInput<'zoom'>): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const viewport = await this._viewport(page);
    const scale = this._imageScale(viewport);
    const imageWidth = Math.round(viewport.width * scale);
    const imageHeight = Math.round(viewport.height * scale);
    const [x0, y0, x1, y1] = input.region;
    if (
      !(
        x0 >= 0 &&
        y0 >= 0 &&
        x0 < x1 &&
        y0 < y1 &&
        x1 <= imageWidth &&
        y1 <= imageHeight
      )
    ) {
      throw new BrowserToolsetError(
        'Zoom region must lie inside the full viewport screenshot.'
      );
    }
    const buffer = await page.screenshot({
      type: 'png',
      scale: 'device',
      timeout: SCREENSHOT_TIMEOUT_MS,
      clip: {
        x: x0 / scale,
        y: y0 / scale,
        width: (x1 - x0) / scale,
        height: (y1 - y0) / scale,
      },
    });
    const regionWidth = x1 - x0;
    const regionHeight = y1 - y0;
    const factor = Math.min(
      2,
      MAX_IMAGE_EDGE / Math.max(regionWidth, regionHeight)
    );
    const output = await resizePng(
      buffer,
      Math.max(1, Math.round(regionWidth * factor)),
      Math.max(1, Math.round(regionHeight * factor))
    );
    return { image: output.toString('base64') };
  }

  private async _click(
    input: PointerInput,
    button: MouseButton,
    count: number
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    this._assertNoHeldButtons(page, 'click');
    const point = await this._point(page, input.target);
    await this._withModifiers(page, input.modifiers, async () => {
      await page.mouse.move(point.x, point.y);
      try {
        for (let clickCount = 1; clickCount <= count; clickCount += 1) {
          await this._mouseDown(page, point.x, point.y, button, clickCount);
          await this._mouseUp(page, point.x, point.y, button, clickCount);
        }
      } finally {
        await this._releaseMouse(page);
      }
    });
    const verb =
      count === 3
        ? 'Triple-clicked'
        : count === 2
          ? 'Double-clicked'
          : button === 'left'
            ? 'Clicked'
            : `${button[0]!.toUpperCase()}${button.slice(1)}-clicked`;
    const where =
      input.target.type === 'ref'
        ? `${input.target.ref} at ${this._formatPoint(point)}`
        : this._formatPoint(point);
    return { text: `${verb} ${where}.` };
  }

  private async _hover(input: PointerInput): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const point = await this._point(page, input.target);
    await this._withModifiers(page, input.modifiers, async () => {
      await page.mouse.move(point.x, point.y);
    });
    const state = this._state(page);
    if (state.held) {
      state.held.x = point.x;
      state.held.y = point.y;
    }
    return { text: `Moved the mouse to ${this._formatPoint(point)}.` };
  }

  private async _leftMouseDown(
    input: MemberInput<'left_mouse_down'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    if (this._state(page).held?.buttons.has('left')) {
      throw new BrowserToolsetError('Left mouse button is already held.');
    }
    const point = await this._point(page, input.target);
    await this._withModifiers(page, input.modifiers, async () => {
      await page.mouse.move(point.x, point.y);
      await this._mouseDown(page, point.x, point.y, 'left', 1);
    });
    return {
      text: `Pressed the left mouse button at ${this._formatPoint(point)}.`,
    };
  }

  private async _leftMouseUp(
    input: MemberInput<'left_mouse_up'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    try {
      const point = await this._point(page, input.target);
      await this._withModifiers(page, input.modifiers, async () => {
        await page.mouse.move(point.x, point.y);
        await this._mouseUp(page, point.x, point.y, 'left', 1);
      });
      return {
        text: `Released the left mouse button at ${this._formatPoint(point)}.`,
      };
    } finally {
      await this._releaseMouse(page);
    }
  }

  private async _drag(
    input: MemberInput<'left_click_drag'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    this._assertNoHeldButtons(page, 'drag');
    const from = await this._point(page, input.from);
    const to = await this._point(page, input.target);
    await this._withModifiers(page, input.modifiers, async () => {
      await page.mouse.move(from.x, from.y);
      try {
        await this._mouseDown(page, from.x, from.y, 'left', 1);
        const steps = 10;
        for (let step = 1; step <= steps; step += 1) {
          const x = from.x + ((to.x - from.x) * step) / steps;
          const y = from.y + ((to.y - from.y) * step) / steps;
          await page.mouse.move(x, y);
          const held = this._state(page).held;
          if (held) {
            held.x = x;
            held.y = y;
          }
          await sleep(15);
        }
        await this._mouseUp(page, to.x, to.y, 'left', 1);
      } finally {
        await this._releaseMouse(page);
      }
    });
    return {
      text: `Dragged from ${this._formatPoint(from)} to ${this._formatPoint(to)}.`,
    };
  }

  private async _scroll(input: MemberInput<'scroll'>): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const point = await this._point(page, input.target);
    const amount = (input.scroll_amount ?? 3) * 100;
    const direction = input.scroll_direction;
    const dx =
      direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    await this._withModifiers(page, input.modifiers, async () => {
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(dx, dy);
    });
    await sleep(150);
    return {
      text: `Scrolled ${direction} by ${amount}px at ${this._formatPoint(point)}.`,
    };
  }

  private async _scrollTo(
    input: MemberInput<'scroll_to'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const { element } = await this._resolve(page, input.target.ref);
    try {
      await element.evaluate((node) =>
        node.scrollIntoView({
          block: 'center',
          inline: 'center',
          behavior: 'instant' as ScrollBehavior,
        })
      );
    } finally {
      await element.dispose().catch(() => undefined);
    }
    return { text: `Scrolled ${input.target.ref} into view.` };
  }

  private async _type(input: MemberInput<'type'>): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    await page.keyboard.insertText(input.text);
    return { text: `Typed ${[...input.text].length} characters.` };
  }

  private async _key(input: MemberInput<'key'>): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const chords = input.text.trim().split(/\s+/).filter(Boolean);
    if (!chords.length) {
      throw new BrowserToolsetError('Provide a key or chord to press.');
    }
    const parsed = chords.map(parseChord);
    const repeat = input.repeat ?? 1;
    for (let index = 0; index < repeat; index += 1) {
      for (const keys of parsed) {
        await page.keyboard.press(keys.join('+'));
      }
    }
    return {
      text: `Pressed ${chords.join(' ')}${repeat > 1 ? ` ${repeat} times` : ''}.`,
    };
  }

  private async _holdKey(
    input: MemberInput<'hold_key'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const text = input.text.trim();
    if (/\s/.test(text)) {
      throw new BrowserToolsetError(
        'hold_key accepts one key or chord, not a sequence.'
      );
    }
    const keys = parseChord(text);
    const pressed: string[] = [];
    try {
      for (const key of keys) {
        await page.keyboard.down(key);
        pressed.push(key);
      }
      await sleep(input.duration * 1000);
    } finally {
      for (const key of pressed.reverse()) {
        await page.keyboard.up(key).catch(() => undefined);
      }
    }
    return { text: `Held ${text} for ${formatNumber(input.duration)}s.` };
  }

  private async _wait(input: MemberInput<'wait'>): Promise<MemberOutput> {
    await this._page(input.tab_id);
    await sleep(input.duration * 1000);
    return { text: `Waited ${formatNumber(input.duration)}s.` };
  }

  private async _readPage(
    input: MemberInput<'read_page'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const filter = input.filter ?? 'default';
    let frame = page.mainFrame();
    if (input.ref) {
      const owner = this._refs.get(input.ref);
      if (!owner || owner.page !== page) {
        throw new BrowserToolsetError(
          `${input.ref} is stale or belongs to another tab. Call read_page or find again.`
        );
      }
      frame = owner.frame;
    }
    const budget: WalkBudget = {
      entries: READ_PAGE_MAX_ENTRIES,
      frames: MAX_WALKED_FRAMES,
      truncated: false,
    };
    const entries = await this._walkFrame(
      page,
      frame,
      {
        rootRef: input.ref ?? null,
        filter,
        depthLimit: input.depth ?? 15,
        includeText: filter !== 'interactive',
      },
      0,
      0,
      budget
    );
    return { text: formatEntries(entries, budget.truncated) };
  }

  private async _find(input: MemberInput<'find'>): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const terms = [...words(input.query)].filter(
      (term) => !FIND_STOP_WORDS.has(term)
    );
    if (!terms.length) {
      throw new BrowserToolsetError('Use a meaningful element description.');
    }
    const budget: WalkBudget = {
      entries: FIND_MAX_ENTRIES,
      frames: MAX_WALKED_FRAMES,
      truncated: false,
    };
    const entries = await this._walkFrame(
      page,
      page.mainFrame(),
      { rootRef: null, filter: 'all', depthLimit: 1000, includeText: false },
      0,
      0,
      budget
    );
    const matches: Array<{ score: number; entry: AccessibleEntry }> = [];
    for (const entry of entries) {
      if (!entry.ref) {
        continue;
      }
      const haystack = entry.description.toLowerCase();
      const entryWords = words(haystack);
      let score = 0;
      for (const term of terms) {
        if (entryWords.has(term)) {
          score += 2;
        } else if (
          haystack.includes(term) ||
          (FIND_SYNONYMS[term] ?? []).some((synonym) => entryWords.has(synonym))
        ) {
          score += 1;
        }
      }
      if (score && score >= terms.length) {
        matches.push({ score, entry });
      }
    }
    // Stable sort keeps document order among equal scores.
    matches.sort((left, right) => right.score - left.score);
    const lines = matches
      .slice(0, FIND_MAX_RESULTS)
      .map(({ entry }) => `[${entry.ref}] ${entry.description}`);
    return {
      text:
        lines.join('\n') ||
        'No matching elements. Try visible label text or read_page.',
    };
  }

  private async _getPageText(
    input: MemberInput<'get_page_text'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const text = await page.evaluate(
      () =>
        (
          (document.querySelector('article,main') as HTMLElement | null) ??
          document.body
        )?.innerText ?? ''
    );
    return {
      text: truncateOutput(
        text,
        'Page text truncated: use find or read_page to narrow.'
      ),
    };
  }

  private async _formInput(
    input: MemberInput<'form_input'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const ref = input.target.ref;
    const { element } = await this._resolve(page, ref);
    try {
      const kind = await element.evaluate((node) => {
        const field = node as HTMLInputElement;
        return {
          tag: node.tagName,
          type: typeof field.type === 'string' ? field.type.toLowerCase() : '',
          disabled: Boolean(field.disabled),
          readOnly: Boolean(field.readOnly),
          editable: (node as HTMLElement).isContentEditable,
          checked: Boolean(field.checked),
        };
      });
      if (kind.disabled || kind.readOnly) {
        throw new BrowserToolsetError('Form element is disabled or read-only.');
      }
      const value = input.value;
      const text =
        typeof value === 'boolean'
          ? String(value)
          : typeof value === 'number' && Number.isInteger(value)
            ? String(Math.trunc(value))
            : String(value);
      const nonText = [
        'checkbox',
        'radio',
        'file',
        'button',
        'submit',
        'reset',
        'image',
        'hidden',
      ];
      if (kind.tag === 'INPUT' && ['range', 'color'].includes(kind.type)) {
        const actual = await element.evaluate((node, next) => {
          const field = node as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(field),
            'value'
          )?.set;
          if (setter) {
            setter.call(field, next);
          } else {
            field.value = next;
          }
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
          return field.value;
        }, text);
        if (actual !== text) {
          throw new BrowserToolsetError(
            `The page did not retain the requested form value (it holds ${JSON.stringify(actual)}).`
          );
        }
        return { text: `Set ${ref} to ${JSON.stringify(text)}.` };
      }
      if (
        ((kind.tag === 'INPUT' || kind.tag === 'TEXTAREA') &&
          !nonText.includes(kind.type)) ||
        kind.editable
      ) {
        await element.fill(text, { timeout: 10_000 });
        const actual = await element.evaluate((node) =>
          (node as HTMLElement).isContentEditable
            ? ((node as HTMLElement).innerText ?? '')
            : (node as HTMLInputElement).value
        );
        if (actual.trim() !== text.trim()) {
          throw new BrowserToolsetError(
            'The page did not retain the requested form value.'
          );
        }
        return { text: `Set ${ref} to ${JSON.stringify(text)}.` };
      }
      if (kind.tag === 'SELECT') {
        const match = await element.evaluate((node, wanted) => {
          const select = node as HTMLSelectElement;
          const options = Array.from(select.options);
          const normalize = (label: string) =>
            label.replace(/\s+/g, ' ').trim();
          const option =
            options.find((candidate) => candidate.value === wanted) ??
            options.find(
              (candidate) =>
                normalize(candidate.label || candidate.text) ===
                normalize(wanted)
            ) ??
            options.find(
              (candidate) =>
                normalize(candidate.label || candidate.text).toLowerCase() ===
                normalize(wanted).toLowerCase()
            );
          return {
            value: option ? option.value : null,
            disabled: option ? option.disabled : false,
            available: options
              .slice(0, 25)
              .map((candidate) => normalize(candidate.label || candidate.text)),
          };
        }, text);
        if (match.value === null) {
          throw new BrowserToolsetError(
            `No option matches ${JSON.stringify(text)}. Options: ${JSON.stringify(match.available)}`
          );
        }
        if (match.disabled) {
          throw new BrowserToolsetError(
            `Option ${JSON.stringify(text)} is disabled.`
          );
        }
        await element.selectOption({ value: match.value }, { timeout: 10_000 });
        return { text: `Selected ${JSON.stringify(text)} in ${ref}.` };
      }
      if (
        kind.tag === 'INPUT' &&
        (kind.type === 'checkbox' || kind.type === 'radio')
      ) {
        if (typeof value !== 'boolean') {
          throw new BrowserToolsetError(
            'Checkbox and radio inputs require a boolean value.'
          );
        }
        if (kind.type === 'radio' && !value) {
          throw new BrowserToolsetError(
            'Choose another radio option to clear a selected radio.'
          );
        }
        if (kind.checked !== value) {
          await this._toggle(page, ref, element);
        }
        const checked = await element.evaluate(
          (node) => (node as HTMLInputElement).checked
        );
        if (checked !== value) {
          throw new BrowserToolsetError('The page refused the checked state.');
        }
        return { text: `Set ${ref} checked=${value}.` };
      }
      throw new BrowserToolsetError(
        'Reference is not a supported form element.'
      );
    } finally {
      await element.dispose().catch(() => undefined);
    }
  }

  /** Click a checkbox or radio like a user, falling back to a DOM click. */
  private async _toggle(
    page: Page,
    ref: string,
    element: ElementHandle<Element>
  ) {
    const before = await element.evaluate(
      (node) => (node as HTMLInputElement).checked
    );
    try {
      const point = await this._point(page, { type: 'ref', ref });
      this._assertNoHeldButtons(page, 'click');
      await page.mouse.click(point.x, point.y);
    } catch {
      // Fall through to the DOM click below.
    }
    const after = await element.evaluate(
      (node) => (node as HTMLInputElement).checked
    );
    if (after === before) {
      await element.evaluate((node) => (node as HTMLInputElement).click());
    }
  }

  private async _resolveUploadPath(candidate: string) {
    if (!this._uploadRoots?.length) {
      throw new BrowserToolsetError(
        'Local upload paths are not allowed: configure uploadRoots, or use document_ids with a documentResolver.'
      );
    }
    let resolved: string;
    try {
      resolved = fs.realpathSync(path.resolve(candidate));
    } catch {
      throw new BrowserToolsetError(`Upload file not found: ${candidate}`);
    }
    const roots = this._uploadRoots.map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    });
    if (!roots.some((root) => pathInside(resolved, root))) {
      throw new BrowserToolsetError(
        `Upload path is outside the allowed upload roots: ${candidate}`
      );
    }
    if (!fs.statSync(resolved).isFile()) {
      throw new BrowserToolsetError(`Upload path is not a file: ${candidate}`);
    }
    return resolved;
  }

  private async _fileUpload(
    input: MemberInput<'file_upload'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const ref = input.target.ref;
    const { element } = await this._resolve(page, ref);
    try {
      const target = await element.evaluate((node) => {
        const field = node as HTMLInputElement;
        return {
          valid:
            node.tagName === 'INPUT' &&
            field.type === 'file' &&
            !field.disabled,
          multiple: Boolean(field.multiple),
        };
      });
      if (!target.valid) {
        throw new BrowserToolsetError(
          'Upload target must be an enabled file input.'
        );
      }
      const paths: string[] = [];
      for (const candidate of input.paths ?? []) {
        paths.push(await this._resolveUploadPath(candidate));
      }
      if (input.document_ids?.length) {
        if (!this._documentResolver) {
          throw new BrowserToolsetError(
            'Document IDs require an application documentResolver to stage files on the browser host.'
          );
        }
        for (const documentId of input.document_ids) {
          paths.push(await this._documentResolver(documentId));
        }
      }
      if (!paths.length) {
        throw new BrowserToolsetError('No upload paths were resolved.');
      }
      if (paths.length > 1 && !target.multiple) {
        throw new BrowserToolsetError('This file input accepts only one file.');
      }
      await element.setInputFiles(paths, { timeout: 30_000 });
      return {
        text: `Attached ${paths.length} file${paths.length === 1 ? '' : 's'} to ${ref}.`,
      };
    } finally {
      await element.dispose().catch(() => undefined);
    }
  }

  private async _readLog(
    input: { tab_id?: string | null },
    kind: 'console' | 'network'
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const buffer = this._state(page)[kind];
    const lines =
      kind === 'console'
        ? buffer.map((line) => line.replace(/\n/g, '\\n'))
        : [...buffer];
    buffer.length = 0;
    const text = lines.join('\n');
    return {
      text: truncateOutput(
        text || `(No ${kind} entries.)`,
        `${kind === 'console' ? 'Console' : 'Network'} output truncated.`
      ),
    };
  }

  private async _javascript(
    input: MemberInput<'javascript_exec'>
  ): Promise<MemberOutput> {
    const page = await this._page(input.tab_id);
    const result: unknown = await page.evaluate(input.text);
    let text: string;
    if (typeof result === 'string') {
      text = result;
    } else if (result === undefined) {
      text = 'undefined';
    } else {
      try {
        text = JSON.stringify(result) ?? String(result);
      } catch {
        text = String(result);
      }
    }
    return { text: truncateOutput(text, 'JavaScript output truncated.') };
  }

  private async _newTab(): Promise<MemberOutput> {
    const entries = await this._tabEntries();
    if (entries.length >= MAX_TABS) {
      throw new BrowserToolsetError(`At most ${MAX_TABS} tabs are supported.`);
    }
    const context = this.browser.browser_context;
    if (!context) {
      throw new BrowserToolsetError('The browser has no open context.');
    }
    const page = await context.newPage();
    this._observePage(page);
    const created = (await this._tabEntries()).find(
      (entry) => entry.page === page
    );
    if (!created) {
      throw new BrowserToolsetError(
        'New tab opened, but it is missing from the tab list; call list_tabs before retrying.'
      );
    }
    await this.browser.switch_to_tab(created.tab_id);
    await this._assertActive(created.tab_id, 'New tab opened');
    return { tabs: true };
  }

  private async _assertActive(tabId: string, action: string) {
    const entries = await this._tabEntries();
    const active = entries.filter((entry) => entry.active);
    if (active.length !== 1 || active[0]!.tab_id !== tabId) {
      throw new BrowserToolsetError(
        `${action}, but active-tab state did not converge; call list_tabs before retrying.`
      );
    }
  }

  private async _switchTab(
    input: MemberInput<'switch_tab'>
  ): Promise<MemberOutput> {
    const entries = await this._tabEntries();
    if (!entries.some((entry) => entry.tab_id === input.tab_id)) {
      throw new BrowserToolsetError(
        `Tab ${input.tab_id} is not open. Call list_tabs to see open tabs.`
      );
    }
    await this.browser.switch_to_tab(input.tab_id);
    await this._assertActive(input.tab_id, 'Tab switch completed');
    return { tabs: true };
  }

  private async _closeTab(
    input: MemberInput<'close_tab'>
  ): Promise<MemberOutput> {
    const entry = (await this._tabEntries()).find(
      (candidate) => candidate.tab_id === input.tab_id
    );
    if (!entry) {
      throw new BrowserToolsetError(
        `Tab ${input.tab_id} is not open. Call list_tabs to see open tabs.`
      );
    }
    await this._releaseMouse(entry.page).catch(() => undefined);
    await this.browser.close_tab(input.tab_id);
    this._forgetPage(entry.page);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const entries = await this._tabEntries();
      if (!entries.some((candidate) => candidate.tab_id === input.tab_id)) {
        return { tabs: true };
      }
      await sleep(20);
    }
    throw new BrowserToolsetError(
      'Close was sent but tab state has not caught up; call list_tabs before retrying.'
    );
  }
}

/** Upload roots must exist; resolve them eagerly for clearer errors. */
export const resolveUploadRoots = (roots: string[]) =>
  roots.map((root) => fs.realpathSync(path.resolve(root)));
