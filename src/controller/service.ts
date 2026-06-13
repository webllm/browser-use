import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validate as validateJsonSchema } from '@cfworker/json-schema';
import { z } from 'zod';
import { ActionResult } from '../agent/views.js';
import {
  ClickCoordinateEvent,
  ClickElementEvent,
  CloseTabEvent,
  GetDropdownOptionsEvent,
  GoBackEvent,
  NavigateToUrlEvent,
  ScrollEvent,
  ScrollToTextEvent,
  ScreenshotEvent,
  SelectDropdownOptionEvent,
  SendKeysEvent,
  SwitchTabEvent,
  TypeTextEvent,
  UploadFileEvent,
  WaitEvent,
} from '../browser/events.js';
import { BrowserError } from '../browser/views.js';
import {
  chunkMarkdownByStructure,
  extractCleanMarkdownFromHtml,
} from '../dom/markdown-extractor.js';
import { extractPdfText, FileSystem } from '../filesystem/file-system.js';
import {
  ClickElementActionIndexOnlySchema,
  ClickElementActionSchema,
  CloseTabActionSchema,
  DoneActionSchema,
  EvaluateActionSchema,
  ExtractStructuredDataActionSchema,
  FindElementsActionSchema,
  DropdownOptionsActionSchema,
  SelectDropdownActionSchema,
  GoToUrlActionSchema,
  InputTextActionSchema,
  NoParamsActionSchema,
  ReadFileActionSchema,
  ReplaceFileStrActionSchema,
  ScrollActionSchema,
  ScrollToTextActionSchema,
  SearchActionSchema,
  SearchPageActionSchema,
  SearchGoogleActionSchema,
  ScreenshotActionSchema,
  SaveAsPdfActionSchema,
  StructuredOutputActionSchema,
  SwitchTabActionSchema,
  UploadFileActionSchema,
  WaitActionSchema,
  WriteFileActionSchema,
  SendKeysActionSchema,
  SheetsRangeActionSchema,
  SheetsUpdateActionSchema,
  SheetsInputActionSchema,
} from './views.js';
import { Registry } from './registry/service.js';
import { SystemMessage, UserMessage } from '../llm/messages.js';
import { createLogger } from '../logging-config.js';
import { sanitize_surrogates } from '../utils.js';
import {
  findUnsupportedJsonSchemaKeyword,
  normalizeStructuredDataBySchema,
} from '../tools/extraction/schema-utils.js';
import type { ExtractionResult } from '../tools/extraction/views.js';
import { getClickDescription } from '../tools/utils.js';
import {
  isActionTimeoutError,
  runActionWithTimeout,
} from './action-timeout.js';

type BrowserSession = any;
type Page = any;
type BaseChatModel = {
  ainvoke: (
    messages: any[],
    output_format?: undefined,
    options?: { signal?: AbortSignal }
  ) => Promise<{ completion: string }>;
};

const DEFAULT_WAIT_OFFSET = 1;
const MAX_WAIT_SECONDS = 30;

const chmodPrivateFile = async (filePath: string) => {
  if (process.platform !== 'win32') {
    await fsp.chmod(filePath, 0o600);
  }
};

const writePrivateBinaryFile = async (filePath: string, data: Buffer) => {
  await fsp.writeFile(filePath, data, { mode: 0o600 });
  await chmodPrivateFile(filePath);
};

export interface ControllerOptions<Context = unknown> {
  exclude_actions?: string[];
  output_model?: z.ZodTypeAny | null;
  display_files_in_done_text?: boolean;
  context?: Context;
}

export interface ActParams<Context = unknown> {
  browser_session: BrowserSession;
  page_extraction_llm?: BaseChatModel | null;
  sensitive_data?: Record<string, string | Record<string, string>> | null;
  available_file_paths?: string[] | null;
  file_system?: FileSystem | null;
  context?: Context | null;
  signal?: AbortSignal | null;
  action_timeout?: number | null;
}

const toActionEntries = (action: Record<string, unknown>) => {
  if (!action) {
    return [];
  }
  return Object.entries(action).filter(([, params]) => params != null);
};

const createAbortError = (reason?: unknown) => {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error: unknown): boolean => {
  return error instanceof Error && error.name === 'AbortError';
};

const resolveUniqueOutputPath = async (
  directory: string,
  fileName: string
): Promise<string> => {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let counter = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(
      directory,
      `${parsed.name} (${counter})${parsed.ext}`
    );
    counter += 1;
  }

  return candidate;
};

const throwIfAborted = (signal?: AbortSignal | null) => {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
};

const waitWithSignal = async (
  timeoutMs: number,
  signal?: AbortSignal | null
) => {
  if (timeoutMs <= 0) {
    throwIfAborted(signal);
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
      reject(createAbortError(signal?.reason));
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
};

const dispatchBrowserEventIfAvailable = async <T = unknown>(
  browser_session: any,
  event: any,
  fallback: () => Promise<T>
) => {
  if (typeof browser_session?.dispatch_browser_event === 'function') {
    const dispatchResult = await browser_session.dispatch_browser_event(event);
    return (dispatchResult?.event?.event_result as T) ?? null;
  }
  return fallback();
};

const validateBrowserPageAfterAction = async (
  browser_session: any,
  page: Page | null,
  signal: AbortSignal | null = null
) => {
  if (typeof browser_session?.validate_page_after_action === 'function') {
    await browser_session.validate_page_after_action(page, signal);
    return;
  }

  const assertUrlAllowed =
    browser_session?._assert_page_url_allowed_or_rollback;
  if (typeof assertUrlAllowed === 'function' && page) {
    await assertUrlAllowed.call(browser_session, page);
  }
  const syncCurrentTab = browser_session?._syncCurrentTabFromPage;
  if (typeof syncCurrentTab === 'function') {
    await syncCurrentTab.call(browser_session, page);
  }
};

const runWithTimeoutAndSignal = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal | null,
  timeoutMessage = 'Operation timed out'
): Promise<T> => {
  throwIfAborted(signal);
  if (timeoutMs <= 0) {
    return operation();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(createAbortError(signal?.reason));
    };

    const onTimeout = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(timeoutMessage));
    };

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const timeout = setTimeout(onTimeout, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    void operation()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });
  });
};

const validateAndFixJavaScript = (code: string): string => {
  let fixedCode = code;

  // Fix double-escaped quotes often produced in tool-argument JSON.
  fixedCode = fixedCode.replace(/\\"/g, '"');

  // Fix over-escaped regex tokens (e.g. \\d -> \d).
  fixedCode = fixedCode.replace(/\\\\([dDsSwWbBnrtfv])/g, '\\$1');
  fixedCode = fixedCode.replace(/\\\\([.*+?^${}()|[\]])/g, '\\$1');

  // Convert brittle mixed-quote selectors/XPaths into template literals.
  fixedCode = fixedCode.replace(
    /document\.evaluate\s*\(\s*"([^"]*)"\s*,/g,
    (_match, xpath: string) => `document.evaluate(\`${xpath}\`,`
  );
  fixedCode = fixedCode.replace(
    /(querySelector(?:All)?)\s*\(\s*"([^"]*)"\s*\)/g,
    (_match, methodName: string, selector: string) =>
      `${methodName}(\`${selector}\`)`
  );
  fixedCode = fixedCode.replace(
    /\.closest\s*\(\s*"([^"]*)"\s*\)/g,
    (_match, selector: string) => `.closest(\`${selector}\`)`
  );
  fixedCode = fixedCode.replace(
    /\.matches\s*\(\s*"([^"]*)"\s*\)/g,
    (_match, selector: string) => `.matches(\`${selector}\`)`
  );

  // Auto-wrap bare async function expressions in IIFE so they actually
  // execute. The LLM commonly emits `async () => { ... }` (or
  // `async function () { ... }`) without trailing `()`, which evaluates
  // to a function reference and silently does nothing — this is the
  // root cause behind credential-extraction failures where
  // `clipboard.writeText` etc. never runs. Detect that the trimmed code
  // is exactly one such expression with no trailing call and wrap it.
  const trimmed = fixedCode.trim();
  const startsAsyncArrow = /^async\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(
    trimmed
  );
  const startsAsyncFn = /^async\s+function\b/.test(trimmed);
  if ((startsAsyncArrow || startsAsyncFn) && !/\)\s*;?\s*$/.test(trimmed)) {
    fixedCode = `(${trimmed})()`;
  }

  return fixedCode;
};

export class Controller<Context = unknown> {
  public registry: Registry<Context>;
  private displayFilesInDoneText: boolean;
  private outputModel: z.ZodTypeAny | null;
  private coordinateClickingEnabled: boolean;
  private clickActionHandler:
    | ((
        params: z.infer<typeof ClickElementActionSchema>,
        ctx: {
          browser_session?: any;
          signal?: AbortSignal | null;
        }
      ) => Promise<ActionResult>)
    | null = null;
  private logger: ReturnType<typeof createLogger>;

  constructor(options: ControllerOptions<Context> = {}) {
    const {
      exclude_actions = [],
      output_model = null,
      display_files_in_done_text = true,
    } = options;
    this.registry = new Registry<Context>(exclude_actions);
    this.displayFilesInDoneText = display_files_in_done_text;
    this.outputModel = output_model;
    this.coordinateClickingEnabled = false;
    this.logger = createLogger('browser_use.controller');

    this.registerDefaultActions(output_model);
  }

  private registerDefaultActions(outputModel: z.ZodTypeAny | null) {
    this.registerDoneAction(outputModel);
    this.registerNavigationActions();
    this.registerElementActions();
    this.registerTabActions();
    this.registerContentActions();
    this.registerExplorationActions();
    this.registerScrollActions();
    this.registerFileSystemActions();
    this.registerUtilityActions();
    this.registerKeyboardActions();
    this.registerDropdownActions();
    this.registerSheetsActions();
  }

  private registerNavigationActions() {
    type SearchAction = z.infer<typeof SearchActionSchema>;
    this.registry.action(
      'Search the query on a web search engine (duckduckgo, google, or bing).',
      { param_model: SearchActionSchema, terminates_sequence: true }
    )(async function search(params: SearchAction, { browser_session, signal }) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const requestedEngine = String(params.engine ?? 'duckduckgo');
      const engine = requestedEngine.toLowerCase();
      const encodedQuery = encodeURIComponent(params.query).replace(
        /%20/g,
        '+'
      );
      const searchUrlByEngine: Record<
        'duckduckgo' | 'google' | 'bing',
        string
      > = {
        duckduckgo: `https://duckduckgo.com/?q=${encodedQuery}`,
        google: `https://www.google.com/search?q=${encodedQuery}&udm=14`,
        bing: `https://www.bing.com/search?q=${encodedQuery}`,
      };
      const searchUrl =
        searchUrlByEngine[engine as 'duckduckgo' | 'google' | 'bing'];
      if (!searchUrl) {
        return new ActionResult({
          error: `Unsupported search engine: ${requestedEngine}. Options: duckduckgo, google, bing`,
        });
      }

      try {
        await browser_session.navigate_to(searchUrl, { signal });
        const memory = `Searched ${requestedEngine} for '${params.query}'`;
        return new ActionResult({
          extracted_content: memory,
          long_term_memory: memory,
        });
      } catch (error) {
        return new ActionResult({
          error: `Failed to search ${requestedEngine} for "${params.query}": ${String((error as Error)?.message ?? error)}`,
        });
      }
    });

    type SearchGoogleAction = z.infer<typeof SearchGoogleActionSchema>;
    this.registry.action('Search the query in Google...', {
      param_model: SearchGoogleActionSchema,
      terminates_sequence: true,
    })(async function search_google(
      params: SearchGoogleAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.query)}&udm=14`;
      const page = await browser_session.get_current_page();
      const currentUrl = page?.url().replace(/\/+$/, '');
      if (currentUrl === 'https://www.google.com') {
        await browser_session.navigate_to(searchUrl, { signal });
      } else {
        await browser_session.create_new_tab(searchUrl, { signal });
      }
      const msg = `🔍  Searched for "${params.query}" in Google`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: `Searched Google for '${params.query}'`,
      });
    });

    type GoToUrlAction = z.infer<typeof GoToUrlActionSchema>;
    const navigateImpl = async function (
      params: GoToUrlAction,
      {
        browser_session,
        signal,
      }: { browser_session?: any; signal?: AbortSignal | null }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      try {
        if (params.new_tab) {
          await browser_session.create_new_tab(params.url, { signal });
          const tabIdx = browser_session.active_tab_index;
          const msg = `🔗  Opened new tab #${tabIdx} with url ${params.url}`;
          return new ActionResult({
            extracted_content: msg,
            include_in_memory: true,
            long_term_memory: `Opened new tab with URL ${params.url}`,
          });
        }
        await dispatchBrowserEventIfAvailable(
          browser_session,
          new NavigateToUrlEvent({ url: params.url, new_tab: false }),
          () => browser_session.navigate_to(params.url, { signal })
        );
        const msg = `🔗 Navigated to ${params.url}`;
        return new ActionResult({
          extracted_content: msg,
          include_in_memory: true,
          long_term_memory: `Navigated to ${params.url}`,
        });
      } catch (error: any) {
        const errorMsg = String(error?.message ?? error ?? '');
        const networkFailures = [
          'ERR_NAME_NOT_RESOLVED',
          'ERR_INTERNET_DISCONNECTED',
          'ERR_CONNECTION_REFUSED',
          'ERR_TIMED_OUT',
          'net::',
        ];
        if (networkFailures.some((needle) => errorMsg.includes(needle))) {
          return new ActionResult({
            error: `Navigation failed - site unavailable: ${params.url}`,
          });
        }
        if (
          error instanceof Error &&
          error.name === 'RuntimeError' &&
          errorMsg.includes('CDP client not initialized')
        ) {
          return new ActionResult({
            error: `Browser connection error: ${errorMsg}`,
          });
        }
        return new ActionResult({
          error: `Navigation failed: ${errorMsg}`,
        });
      }
    };

    this.registry.action('Navigate to URL...', {
      param_model: GoToUrlActionSchema,
      terminates_sequence: true,
    })(async function go_to_url(
      params: GoToUrlAction,
      { browser_session, signal }
    ) {
      return navigateImpl(params, { browser_session, signal });
    });

    this.registry.action('Navigate to URL...', {
      param_model: GoToUrlActionSchema,
      terminates_sequence: true,
    })(async function navigate(
      params: GoToUrlAction,
      { browser_session, signal }
    ) {
      return navigateImpl(params, { browser_session, signal });
    });

    this.registry.action('Go back', {
      param_model: NoParamsActionSchema,
      terminates_sequence: true,
    })(async function go_back(_params, { browser_session, signal }) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      try {
        await dispatchBrowserEventIfAvailable(
          browser_session,
          new GoBackEvent(),
          () => browser_session.go_back({ signal })
        );
        const memory = 'Navigated back';
        return new ActionResult({ extracted_content: memory });
      } catch (error) {
        return new ActionResult({
          error: `Failed to go back: ${String((error as Error)?.message ?? error)}`,
        });
      }
    });

    type WaitAction = z.infer<typeof WaitActionSchema>;
    this.registry.action('Wait for x seconds.', {
      param_model: WaitActionSchema,
    })(async function wait(params: WaitAction, { signal, browser_session }) {
      const seconds = params.seconds ?? 3;
      const actualSeconds = Math.min(
        Math.max(seconds - DEFAULT_WAIT_OFFSET, 0),
        MAX_WAIT_SECONDS
      );
      const msg = `🕒 Waited for ${seconds} second${seconds === 1 ? '' : 's'}`;
      if (actualSeconds > 0) {
        if (browser_session) {
          await dispatchBrowserEventIfAvailable(
            browser_session,
            new WaitEvent({
              seconds: actualSeconds,
              max_seconds: MAX_WAIT_SECONDS,
            }),
            () => waitWithSignal(actualSeconds * 1000, signal)
          );
        } else {
          await waitWithSignal(actualSeconds * 1000, signal);
        }
      }
      return new ActionResult({
        extracted_content: msg,
        long_term_memory: `Waited for ${seconds} second${seconds === 1 ? '' : 's'}`,
      });
    });
  }

  private registerElementActions() {
    type ClickElementAction = z.infer<typeof ClickElementActionSchema>;
    const logger = this.logger;

    const convertLlmCoordinatesToViewport = (
      llmX: number,
      llmY: number,
      browserSession: any
    ): [number, number] => {
      const llmSize = browserSession?.llm_screenshot_size;
      const viewportSize = browserSession?._original_viewport_size;
      if (
        !Array.isArray(llmSize) ||
        llmSize.length !== 2 ||
        !Array.isArray(viewportSize) ||
        viewportSize.length !== 2
      ) {
        return [llmX, llmY];
      }

      const [llmWidth, llmHeight] = llmSize.map((value: unknown) =>
        Number(value)
      );
      const [viewportWidth, viewportHeight] = viewportSize.map(
        (value: unknown) => Number(value)
      );

      if (
        !Number.isFinite(llmWidth) ||
        !Number.isFinite(llmHeight) ||
        !Number.isFinite(viewportWidth) ||
        !Number.isFinite(viewportHeight) ||
        llmWidth <= 0 ||
        llmHeight <= 0 ||
        viewportWidth <= 0 ||
        viewportHeight <= 0
      ) {
        return [llmX, llmY];
      }

      const actualX = Math.floor((llmX / llmWidth) * viewportWidth);
      const actualY = Math.floor((llmY / llmHeight) * viewportHeight);
      logger.info(
        `🔄 Converting coordinates: LLM (${llmX}, ${llmY}) @ ${llmWidth}x${llmHeight} -> Viewport (${actualX}, ${actualY}) @ ${viewportWidth}x${viewportHeight}`
      );
      return [actualX, actualY];
    };

    const clickImpl = async (
      params: ClickElementAction,
      { browser_session, signal }: any
    ) => {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const collectTabIds = (): Set<number> => {
        if (!Array.isArray(browser_session.tabs)) {
          return new Set<number>();
        }
        return new Set<number>(
          browser_session.tabs
            .map((tab: any) => tab?.page_id)
            .filter(
              (pageId: unknown): pageId is number =>
                typeof pageId === 'number' && Number.isFinite(pageId)
            )
        );
      };
      const detectNewTabNote = async (tabsBefore: Set<number>) => {
        try {
          await waitWithSignal(50, signal);
          const tabsAfter = Array.isArray(browser_session.tabs)
            ? browser_session.tabs
            : [];
          const newTab = tabsAfter.find((tab: any) => {
            const pageId = tab?.page_id;
            return typeof pageId === 'number' && !tabsBefore.has(pageId);
          });
          if (!newTab) {
            return '';
          }
          const tabId =
            typeof newTab?.tab_id === 'string' && newTab.tab_id.trim()
              ? newTab.tab_id.trim()
              : String(newTab.page_id).padStart(4, '0').slice(-4);
          return `. Note: This opened a new tab (tab_id: ${tabId}) - switch to it if you need to interact with the new page.`;
        } catch {
          return '';
        }
      };

      if (
        params.coordinate_x != null &&
        params.coordinate_y != null &&
        params.index == null
      ) {
        if (!this.coordinateClickingEnabled) {
          throw new BrowserError(
            'Coordinate clicking is disabled for the current model. Provide an element index.'
          );
        }
        const tabsBefore = collectTabIds();
        const page: Page | null = await browser_session.get_current_page();
        if (!page?.mouse?.click) {
          throw new BrowserError(
            'Unable to perform coordinate click on the current page.'
          );
        }
        await validateBrowserPageAfterAction(browser_session, page, signal);
        const [actualX, actualY] = convertLlmCoordinatesToViewport(
          params.coordinate_x,
          params.coordinate_y,
          browser_session
        );
        try {
          await dispatchBrowserEventIfAvailable(
            browser_session,
            new ClickCoordinateEvent({
              coordinate_x: actualX,
              coordinate_y: actualY,
            }),
            () => page.mouse.click(actualX, actualY)
          );
        } finally {
          await validateBrowserPageAfterAction(browser_session, page, signal);
        }
        const coordinateMessage =
          `🖱️ Clicked at coordinates (${params.coordinate_x}, ${params.coordinate_y})` +
          (await detectNewTabNote(tabsBefore));
        return new ActionResult({
          extracted_content: coordinateMessage,
          include_in_memory: true,
          long_term_memory: coordinateMessage,
          metadata: {
            click_x: actualX,
            click_y: actualY,
          },
        });
      }

      if (params.index == null) {
        return new ActionResult({
          error:
            'Must provide either index or both coordinate_x and coordinate_y',
        });
      }

      const element = await browser_session.get_dom_element_by_index(
        params.index,
        {
          signal,
        }
      );
      if (!element) {
        const msg = `Element index ${params.index} not available - page may have changed. Try refreshing browser state.`;
        logger.warning(`⚠️ ${msg}`);
        return new ActionResult({
          extracted_content: msg,
        });
      }
      const tabsBefore = collectTabIds();
      if (browser_session.is_file_input?.(element)) {
        const msg = `Index ${params.index} - has an element which opens file upload dialog.`;
        return new ActionResult({
          extracted_content: msg,
          include_in_memory: true,
          success: false,
          long_term_memory: msg,
        });
      }

      const downloadPath = await dispatchBrowserEventIfAvailable(
        browser_session,
        new ClickElementEvent({
          node: element,
          button: 'left',
        }),
        () =>
          browser_session._click_element_node(element, {
            signal,
          })
      );
      let msg: string;
      if (downloadPath) {
        msg = `💾 Downloaded file to ${downloadPath}`;
      } else {
        let elementDescription = '';
        if (
          typeof element?.tag_name === 'string' &&
          typeof element?.get_all_text_till_next_clickable_element ===
            'function'
        ) {
          try {
            elementDescription = getClickDescription(element as any);
          } catch {
            elementDescription = '';
          }
        }

        if (elementDescription) {
          msg = `🖱️ Clicked ${elementDescription}`;
        } else {
          const snippet =
            element.get_all_text_till_next_clickable_element?.(2) ?? '';
          msg = `🖱️ Clicked button with index ${params.index}: ${snippet}`;
        }
      }

      msg += await detectNewTabNote(tabsBefore);

      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: msg,
      });
    };

    this.clickActionHandler = clickImpl;
    this.registerClickActions();

    type InputTextAction = z.infer<typeof InputTextActionSchema>;
    const detectSensitiveKeyName = (
      value: string,
      sensitiveData: Record<string, string | Record<string, string>> | null
    ) => {
      if (!value || !sensitiveData) {
        return null;
      }

      for (const [domainOrKey, content] of Object.entries(sensitiveData)) {
        if (typeof content === 'string') {
          if (content === value) {
            return domainOrKey;
          }
          continue;
        }
        if (!content || typeof content !== 'object') {
          continue;
        }
        for (const [key, nestedValue] of Object.entries(content)) {
          if (nestedValue === value) {
            return key;
          }
        }
      }

      return null;
    };

    const inputImpl = async function (
      params: InputTextAction,
      {
        browser_session,
        has_sensitive_data,
        sensitive_data,
        signal,
      }: {
        browser_session?: any;
        has_sensitive_data?: boolean;
        sensitive_data?: Record<string, string | Record<string, string>> | null;
        signal?: AbortSignal | null;
      }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const element = await browser_session.get_dom_element_by_index(
        params.index,
        { signal }
      );
      if (!element) {
        const msg = `Element index ${params.index} not available - page may have changed. Try refreshing browser state.`;
        logger.warning(`⚠️ ${msg}`);
        return new ActionResult({
          extracted_content: msg,
        });
      }

      const isAutocompleteField = (
        node: { attributes?: Record<string, string> } | null | undefined
      ) => {
        const attrs = node?.attributes ?? {};
        const role = String(attrs.role ?? '').toLowerCase();
        const ariaAutocomplete = String(
          attrs['aria-autocomplete'] ?? ''
        ).toLowerCase();
        const hasDatalist = String(attrs.list ?? '').trim().length > 0;
        return (
          role === 'combobox' ||
          (ariaAutocomplete !== '' && ariaAutocomplete !== 'none') ||
          hasDatalist
        );
      };

      const needsAutocompleteDelay = (
        node: { attributes?: Record<string, string> } | null | undefined
      ) => {
        const attrs = node?.attributes ?? {};
        const role = String(attrs.role ?? '').toLowerCase();
        const ariaAutocomplete = String(
          attrs['aria-autocomplete'] ?? ''
        ).toLowerCase();
        return (
          role === 'combobox' ||
          (ariaAutocomplete !== '' && ariaAutocomplete !== 'none')
        );
      };

      await dispatchBrowserEventIfAvailable(
        browser_session,
        new TypeTextEvent({
          node: element,
          text: params.text,
          clear: params.clear ?? true,
        }),
        () =>
          browser_session._input_text_element_node(element, params.text, {
            clear: params.clear,
            signal,
          })
      );

      let actualValue: string | null = null;
      try {
        const locator = await browser_session.get_locate_element?.(element);
        if (locator && typeof locator.inputValue === 'function') {
          const value = await locator.inputValue();
          actualValue = typeof value === 'string' ? value : null;
        }
      } catch {
        actualValue = null;
      }

      let msg = `⌨️  Input ${params.text} into index ${params.index}`;
      if (has_sensitive_data) {
        const sensitiveKeyName = detectSensitiveKeyName(
          params.text,
          sensitive_data ?? null
        );
        msg = sensitiveKeyName
          ? `Typed ${sensitiveKeyName}`
          : 'Typed sensitive data';
      }

      if (
        !has_sensitive_data &&
        actualValue != null &&
        actualValue !== params.text
      ) {
        msg +=
          `\n⚠️ Note: the field's actual value '${actualValue}' differs from typed text '${params.text}'. ` +
          'The page may have reformatted or autocompleted your input.';
      }

      if (isAutocompleteField(element)) {
        msg +=
          '\n💡 This is an autocomplete field. Wait for suggestions to appear, then click the correct suggestion instead of pressing Enter.';
        if (needsAutocompleteDelay(element)) {
          await waitWithSignal(400, signal);
        }
      }

      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: msg,
      });
    };

    this.registry.action(
      'Click and input text into an input interactive element',
      { param_model: InputTextActionSchema }
    )(async function input_text(
      params: InputTextAction,
      { browser_session, has_sensitive_data, sensitive_data, signal }
    ) {
      return inputImpl(params, {
        browser_session,
        has_sensitive_data,
        sensitive_data,
        signal,
      });
    });

    this.registry.action(
      'Click and input text into an input interactive element',
      { param_model: InputTextActionSchema }
    )(async function input(
      params: InputTextAction,
      { browser_session, has_sensitive_data, sensitive_data, signal }
    ) {
      return inputImpl(params, {
        browser_session,
        has_sensitive_data,
        sensitive_data,
        signal,
      });
    });

    type UploadFileAction = z.infer<typeof UploadFileActionSchema>;
    this.registry.action('Upload file to interactive element with file path', {
      param_model: UploadFileActionSchema,
    })(async function upload_file(
      params: UploadFileAction,
      { browser_session, available_file_paths, file_system, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      let uploadPath = params.path;
      const isLocalBrowser = (browser_session as any)?.is_local !== false;

      const allowedPaths = new Set<string>(available_file_paths ?? []);
      const downloadedFiles = Array.isArray(browser_session?.downloaded_files)
        ? browser_session.downloaded_files
        : [];
      for (const downloadedPath of downloadedFiles) {
        allowedPaths.add(downloadedPath);
      }

      if (!allowedPaths.has(uploadPath)) {
        if (!isLocalBrowser) {
          // Remote browser paths may only exist on the remote runtime.
        } else {
          const fsInstance = file_system ?? null;
          const managedFile =
            fsInstance && typeof fsInstance.get_file === 'function'
              ? fsInstance.get_file(uploadPath)
              : null;

          if (managedFile && fsInstance?.get_dir) {
            const fsDir = fsInstance.get_dir();
            const managedFileName = String(
              (managedFile as any).fullName ??
                (managedFile as any).full_name ??
                path.basename(uploadPath)
            );
            const candidatePath = path.join(fsDir, managedFileName);
            const realDir = fs.realpathSync(fsDir);
            const realPath = fs.existsSync(candidatePath)
              ? fs.realpathSync(candidatePath)
              : path.resolve(candidatePath);
            const relativePath = path.relative(realDir, realPath);
            if (
              relativePath === '..' ||
              relativePath.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relativePath)
            ) {
              return new ActionResult({
                error: `Upload of ${params.path} escapes FileSystem directory; refusing.`,
              });
            }
            uploadPath = candidatePath;
          } else {
            return new ActionResult({
              error: `File path ${params.path} is not available. To fix: add this file path to available_file_paths when creating the Agent.`,
            });
          }
        }
      }

      if (isLocalBrowser) {
        if (!fs.existsSync(uploadPath)) {
          return new ActionResult({
            error: `File ${uploadPath} does not exist`,
          });
        }
        if (fs.statSync(uploadPath).size === 0) {
          return new ActionResult({
            error: `File ${uploadPath} is empty (0 bytes). The file may not have been saved correctly.`,
          });
        }
      }

      let selectorMap: Record<string, unknown> | null = null;
      if (typeof browser_session.get_selector_map === 'function') {
        selectorMap = await browser_session.get_selector_map({ signal });
        if (!(params.index in (selectorMap ?? {}))) {
          return new ActionResult({
            error: `Element with index ${params.index} does not exist.`,
          });
        }
      }

      let node = await browser_session.find_file_upload_element_by_index(
        params.index,
        3,
        3,
        { signal }
      );

      if (
        !node &&
        selectorMap &&
        typeof browser_session.is_file_input === 'function'
      ) {
        let currentScrollY = 0;
        try {
          const page = await browser_session.get_current_page?.();
          if (page?.evaluate) {
            await validateBrowserPageAfterAction(browser_session, page, signal);
            let evaluated: unknown;
            try {
              evaluated = await page.evaluate(
                () => window.scrollY || window.pageYOffset || 0
              );
            } finally {
              await validateBrowserPageAfterAction(
                browser_session,
                page,
                signal
              );
            }
            const numeric =
              typeof evaluated === 'number' ? evaluated : Number(evaluated);
            if (Number.isFinite(numeric)) {
              currentScrollY = numeric;
            }
          }
        } catch {
          currentScrollY = 0;
        }

        let closest: any = null;
        let minDistance = Number.POSITIVE_INFINITY;
        for (const element of Object.values(selectorMap)) {
          if (!browser_session.is_file_input(element as any)) {
            continue;
          }
          const y = Number((element as any)?.absolute_position?.y ?? 0);
          const distance = Number.isFinite(y)
            ? Math.abs(y - currentScrollY)
            : 0;
          if (!closest || distance < minDistance) {
            closest = element;
            minDistance = distance;
          }
        }

        if (closest) {
          node = closest;
        }
      }

      if (!node) {
        throw new BrowserError('No file upload element found on the page');
      }

      await dispatchBrowserEventIfAvailable(
        browser_session,
        new UploadFileEvent({
          node,
          file_path: uploadPath,
        }),
        async () => {
          const locator = await browser_session.get_locate_element(node);
          if (!locator) {
            throw new BrowserError('No file upload element found on the page');
          }
          await locator.setInputFiles(uploadPath);
          return null;
        }
      );
      const msg = `📁 Successfully uploaded file to index ${params.index}`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: `Uploaded file ${uploadPath} to element ${params.index}`,
      });
    });
  }

  private registerClickActions() {
    type ClickElementAction = z.infer<typeof ClickElementActionSchema>;
    type ClickElementActionIndexOnly = z.infer<
      typeof ClickElementActionIndexOnlySchema
    >;

    const clickActionHandler = this.clickActionHandler;
    if (!clickActionHandler) {
      return;
    }

    const removeAction = (this.registry as any)?.remove_action;
    if (typeof removeAction === 'function') {
      removeAction.call(this.registry, 'click');
      removeAction.call(this.registry, 'click_element_by_index');
    }

    const registerIndexAlias = () => {
      this.registry.action('Click element by index.', {
        param_model: ClickElementActionIndexOnlySchema,
        action_name: 'click_element_by_index',
      })(async (params: ClickElementActionIndexOnly, ctx) => {
        return await clickActionHandler(params as ClickElementAction, ctx);
      });
    };

    if (this.coordinateClickingEnabled) {
      this.registry.action(
        'Click element by index or coordinates. Use coordinates only if the index is not available. Either provide coordinates or index.',
        {
          param_model: ClickElementActionSchema,
          action_name: 'click',
        }
      )(async (params: ClickElementAction, ctx) => {
        return await clickActionHandler(params, ctx);
      });
      registerIndexAlias();
      return;
    }

    this.registry.action('Click element by index.', {
      param_model: ClickElementActionIndexOnlySchema,
      action_name: 'click',
    })(async (params: ClickElementActionIndexOnly, ctx) => {
      return await clickActionHandler(params as ClickElementAction, ctx);
    });
    registerIndexAlias();
  }

  private registerTabActions() {
    const tabLogger = this.logger;
    type SwitchTabAction = z.infer<typeof SwitchTabActionSchema>;
    const resolveTabIdentifier = (params: {
      tab_id?: string;
      page_id?: number;
    }): string | number => {
      if (typeof params.tab_id === 'string' && params.tab_id.trim()) {
        return params.tab_id.trim();
      }
      if (
        typeof params.page_id === 'number' &&
        Number.isFinite(params.page_id)
      ) {
        return params.page_id;
      }
      return -1;
    };
    const formatTabId = (identifier: string | number, browser_session: any) => {
      if (typeof identifier === 'string' && identifier.trim()) {
        return identifier.trim();
      }
      const numericIdentifier =
        typeof identifier === 'number' && Number.isFinite(identifier)
          ? Math.floor(identifier)
          : -1;
      if (numericIdentifier >= 0) {
        const matchedTab = Array.isArray(browser_session?.tabs)
          ? browser_session.tabs.find(
              (tab: any) => tab?.page_id === numericIdentifier
            )
          : null;
        const matchedTabId =
          typeof matchedTab?.tab_id === 'string' && matchedTab.tab_id.trim()
            ? matchedTab.tab_id.trim()
            : null;
        return (
          matchedTabId ?? String(numericIdentifier).padStart(4, '0').slice(-4)
        );
      }
      return 'unknown';
    };
    const switchImpl = async function (
      params: SwitchTabAction,
      {
        browser_session,
        signal,
      }: {
        browser_session?: any;
        signal?: AbortSignal | null;
      }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const identifier = resolveTabIdentifier(params);
      const tabId = formatTabId(identifier, browser_session);
      try {
        const switchTargetId =
          identifier === -1 ? null : String(identifier).trim();
        await dispatchBrowserEventIfAvailable(
          browser_session,
          new SwitchTabEvent({ target_id: switchTargetId }),
          () => browser_session.switch_to_tab(identifier, { signal })
        );
        const page: Page | null = await browser_session.get_current_page();
        try {
          await page?.wait_for_load_state?.('domcontentloaded', {
            timeout: 5000,
          });
        } catch {
          /* ignore */
        }
        const memory = `Switched to tab #${tabId}`;
        return new ActionResult({
          extracted_content: memory,
          long_term_memory: memory,
        });
      } catch (error) {
        tabLogger.warning(
          `Tab switch may have failed: ${(error as Error).message}`
        );
        const memory = `Attempted to switch to tab #${tabId}`;
        return new ActionResult({
          extracted_content: memory,
          long_term_memory: memory,
        });
      }
    };

    this.registry.action('Switch tab', {
      param_model: SwitchTabActionSchema,
      terminates_sequence: true,
    })(async function switch_tab(
      params: SwitchTabAction,
      { browser_session, signal }
    ) {
      return switchImpl(params, { browser_session, signal });
    });

    this.registry.action('Switch tab', {
      param_model: SwitchTabActionSchema,
      terminates_sequence: true,
      action_name: 'switch',
    })(async function switch_alias(
      params: SwitchTabAction,
      { browser_session, signal }
    ) {
      return switchImpl(params, { browser_session, signal });
    });

    type CloseTabAction = z.infer<typeof CloseTabActionSchema>;
    const closeImpl = async function (
      params: CloseTabAction,
      {
        browser_session,
        signal,
      }: {
        browser_session?: any;
        signal?: AbortSignal | null;
      }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const identifier = resolveTabIdentifier(params);
      const closedTabId = formatTabId(identifier, browser_session);
      try {
        const resolvedCloseTargetId =
          identifier === -1
            ? (browser_session?.active_tab?.target_id ??
              browser_session?.active_tab?.tab_id ??
              null)
            : String(identifier).trim();
        if (!resolvedCloseTargetId) {
          throw new Error('Could not resolve target tab to close');
        }
        await dispatchBrowserEventIfAvailable(
          browser_session,
          new CloseTabEvent({ target_id: resolvedCloseTargetId }),
          () => browser_session.close_tab(identifier)
        );
        const memory = `Closed tab #${closedTabId}`;
        return new ActionResult({
          extracted_content: memory,
          long_term_memory: memory,
        });
      } catch (error) {
        tabLogger.warning(
          `Tab ${closedTabId} may already be closed: ${(error as Error).message}`
        );
        const memory = `Tab #${closedTabId} closed (was already closed or invalid)`;
        return new ActionResult({
          extracted_content: memory,
          long_term_memory: memory,
        });
      }
    };

    this.registry.action('Close an existing tab', {
      param_model: CloseTabActionSchema,
    })(async function close_tab(
      params: CloseTabAction,
      { browser_session, signal }
    ) {
      return closeImpl(params, { browser_session, signal });
    });

    this.registry.action('Close an existing tab', {
      param_model: CloseTabActionSchema,
    })(async function close(
      params: CloseTabAction,
      { browser_session, signal }
    ) {
      return closeImpl(params, { browser_session, signal });
    });
  }

  private registerContentActions() {
    const registry = this.registry;
    const contentLogger = this.logger;

    const extractStructuredDescription =
      "LLM extracts structured data from page markdown. Use when: on right page, know what to extract, haven't called before on same page+query. Can't get interactive elements. Set extract_links=True for URLs. Use start_from_char if previous extraction was truncated to extract data further down the page. When paginating across pages, pass already_collected with item identifiers (names/URLs) from prior pages to avoid duplicates.";

    type ExtractStructuredAction = z.infer<
      typeof ExtractStructuredDataActionSchema
    >;
    this.registry.action(extractStructuredDescription, {
      param_model: ExtractStructuredDataActionSchema,
    })(async function extract_structured_data(
      params: ExtractStructuredAction,
      {
        browser_session,
        page,
        page_extraction_llm,
        extraction_schema,
        file_system,
        signal,
      }
    ) {
      throwIfAborted(signal);
      if (!page) {
        throw new BrowserError('No active page available for extraction.');
      }
      if (!page_extraction_llm) {
        throw new BrowserError('page_extraction_llm is not configured.');
      }
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      await validateBrowserPageAfterAction(browser_session, page, signal);
      const pageHtml = await runWithTimeoutAndSignal(
        async () => {
          try {
            const value = await page.content?.();
            return typeof value === 'string' ? value : '';
          } finally {
            await validateBrowserPageAfterAction(browser_session, page, signal);
          }
        },
        10000,
        signal,
        'Page content extraction timed out'
      );
      if (!pageHtml) {
        throw new BrowserError('Unable to extract page content.');
      }

      let combinedHtml = pageHtml;
      const frames: any[] =
        typeof page.frames === 'function'
          ? page.frames()
          : Array.isArray((page as any).frames)
            ? (page as any).frames
            : [];
      const currentUrl: string = (() => {
        const pageUrlValue = (page as any).url;
        if (typeof pageUrlValue === 'function') {
          return String(pageUrlValue.call(page) ?? '');
        }
        return typeof pageUrlValue === 'string' ? pageUrlValue : '';
      })();

      for (const iframe of frames) {
        throwIfAborted(signal);
        try {
          await runWithTimeoutAndSignal(
            async () => {
              await iframe.waitForLoadState?.('load');
            },
            1000,
            signal,
            'Iframe load timeout'
          );
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
        }

        const iframeUrl =
          typeof iframe.url === 'function'
            ? iframe.url()
            : typeof iframe.url === 'string'
              ? iframe.url
              : '';
        if (
          !iframeUrl ||
          iframeUrl === currentUrl ||
          iframeUrl.startsWith('data:') ||
          iframeUrl.startsWith('about:')
        ) {
          continue;
        }

        try {
          const iframeHtml = await runWithTimeoutAndSignal(
            async () => {
              const value = await iframe.content?.();
              return typeof value === 'string' ? value : '';
            },
            2000,
            signal,
            'Iframe content extraction timeout'
          );
          if (!iframeHtml) {
            continue;
          }
          combinedHtml += `\n<section><h2>IFRAME ${iframeUrl}</h2>${iframeHtml}</section>`;
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
        }
      }

      const extracted = extractCleanMarkdownFromHtml(combinedHtml, {
        extract_links: params.extract_links,
        method: 'page_content',
        url: currentUrl || undefined,
      });
      let content = extracted.content;
      const contentStats = extracted.stats;
      const finalFilteredLength = contentStats.final_filtered_chars;

      const startFromChar = Math.max(0, params.start_from_char ?? 0);
      const maxChars = 100000;
      const chunks = chunkMarkdownByStructure(
        content,
        maxChars,
        5,
        startFromChar
      );
      if (!chunks.length) {
        return new ActionResult({
          error: `start_from_char (${startFromChar}) exceeds content length ${finalFilteredLength} characters.`,
        });
      }

      const chunk = chunks[0]!;
      content = chunk.content;
      const wasTruncated = chunk.has_more;

      if (chunk.overlap_prefix) {
        content = `${chunk.overlap_prefix}\n${content}`;
      }

      if (startFromChar > 0) {
        contentStats.started_from_char = startFromChar;
      }
      if (wasTruncated) {
        contentStats.truncated_at_char = chunk.char_offset_end;
        contentStats.next_start_char = chunk.char_offset_end;
        contentStats.chunk_index = chunk.chunk_index;
        contentStats.total_chunks = chunk.total_chunks;
      }

      const originalHtmlLength = contentStats.original_html_chars;
      const initialMarkdownLength = contentStats.initial_markdown_chars;
      const charsFiltered = contentStats.filtered_chars_removed;

      let statsSummary =
        `Content processed: ${originalHtmlLength.toLocaleString()} HTML chars ` +
        `→ ${initialMarkdownLength.toLocaleString()} initial markdown ` +
        `→ ${finalFilteredLength.toLocaleString()} filtered markdown`;
      if (startFromChar > 0) {
        statsSummary += ` (started from char ${startFromChar.toLocaleString()})`;
      }
      if (
        wasTruncated &&
        contentStats.next_start_char != null &&
        contentStats.chunk_index != null &&
        contentStats.total_chunks != null
      ) {
        const chunkInfo = `chunk ${contentStats.chunk_index + 1} of ${contentStats.total_chunks}, `;
        statsSummary +=
          ` → ${content.length.toLocaleString()} final chars ` +
          `(${chunkInfo}use start_from_char=${contentStats.next_start_char} to continue)`;
      } else if (charsFiltered > 0) {
        statsSummary += ` (filtered ${charsFiltered.toLocaleString()} chars of noise)`;
      }

      content = sanitize_surrogates(content);
      const sanitizedQuery = sanitize_surrogates(params.query);
      const alreadyCollected = Array.isArray(params.already_collected)
        ? params.already_collected
            .map((item) => sanitize_surrogates(String(item)).trim())
            .filter(Boolean)
        : [];

      const parseJsonFromCompletion = (completion: string) => {
        const trimmed = completion.trim();
        const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = fencedMatch?.[1]?.trim() || trimmed;
        return JSON.parse(candidate);
      };

      let effectiveOutputSchema = params.output_schema ?? extraction_schema;
      if (effectiveOutputSchema != null) {
        const unsupportedKeyword = findUnsupportedJsonSchemaKeyword(
          effectiveOutputSchema
        );
        if (unsupportedKeyword) {
          contentLogger.warning(
            `Invalid output_schema, falling back to free-text extraction: unsupported keyword '${unsupportedKeyword}'`
          );
          effectiveOutputSchema = null;
        }
      }
      const pageUrl = currentUrl || '';
      const maxMemoryLength = 10000;

      if (effectiveOutputSchema != null) {
        const systemPrompt = `
You are an expert at extracting structured data from the markdown of a webpage.

<input>
You will be given a query, a JSON Schema, and the markdown of a webpage that has been filtered to remove noise and advertising content.
</input>

<instructions>
- Extract ONLY information present in the webpage. Do not guess or fabricate values.
- Your response MUST conform to the provided JSON Schema exactly.
- If a required field's value cannot be found on the page, use null (if the schema allows it) or an empty string / empty array as appropriate.
- If the content was truncated, extract what is available from the visible portion.
- If <already_collected> items are provided, skip any items whose name/title/URL matches those listed. Do not include duplicates.
</instructions>`.trim();
        const schemaJson = JSON.stringify(effectiveOutputSchema, null, 2);
        const alreadyCollectedSection =
          alreadyCollected.length > 0
            ? `\n\n<already_collected>\nSkip items whose name/title/URL matches any of these already-collected identifiers:\n${alreadyCollected
                .slice(0, 100)
                .map((item) => `- ${item}`)
                .join('\n')}\n</already_collected>`
            : '';
        const prompt =
          `<query>\n${sanitizedQuery}\n</query>\n\n` +
          `<output_schema>\n${schemaJson}\n</output_schema>\n\n` +
          `<content_stats>\n${statsSummary}\n</content_stats>\n\n` +
          `<webpage_content>\n${content}\n</webpage_content>` +
          alreadyCollectedSection;

        const response = await (page_extraction_llm as any).ainvoke(
          [new SystemMessage(systemPrompt), new UserMessage(prompt)],
          undefined,
          { signal: signal ?? undefined }
        );
        throwIfAborted(signal);
        const completion = response?.completion;
        const completionText =
          typeof completion === 'string'
            ? completion
            : JSON.stringify(completion ?? {});

        let parsedResult: Record<string, unknown>;
        try {
          parsedResult = parseJsonFromCompletion(completionText);
        } catch (error) {
          throw new BrowserError(
            `Structured extraction returned invalid JSON: ${(error as Error).message}`
          );
        }

        const schemaValidation = validateJsonSchema(
          parsedResult as any,
          effectiveOutputSchema as any
        );
        if (!schemaValidation.valid) {
          const details = (schemaValidation.errors ?? [])
            .slice(0, 3)
            .map((item) => String((item as any)?.error ?? '').trim())
            .filter(Boolean)
            .join('; ');
          const suffix = details ? `: ${details}` : '';
          throw new BrowserError(
            `Structured extraction result does not match output_schema${suffix}`
          );
        }

        const normalizedResult = normalizeStructuredDataBySchema(
          parsedResult,
          effectiveOutputSchema
        ) as Record<string, unknown>;
        const resultJson = JSON.stringify(normalizedResult);
        const extractedContent =
          `<url>\n${pageUrl}\n</url>\n` +
          `<query>\n${sanitizedQuery}\n</query>\n` +
          `<structured_result>\n${resultJson}\n</structured_result>`;
        const extractionMeta: ExtractionResult = {
          data: normalizedResult,
          schema_used: effectiveOutputSchema,
          is_partial: wasTruncated,
          source_url: pageUrl,
          content_stats: contentStats as unknown as Record<string, unknown>,
        };

        const includeOnce = extractedContent.length >= maxMemoryLength;
        const memory = includeOnce
          ? `Query: ${sanitizedQuery}\nContent in ${await fsInstance.save_extracted_content(extractedContent)} and once in <read_state>.`
          : extractedContent;
        return new ActionResult({
          extracted_content: extractedContent,
          include_extracted_content_only_once: includeOnce,
          long_term_memory: memory,
          metadata: {
            structured_extraction: true,
            extraction_result: extractionMeta,
          },
        });
      }

      const systemPrompt = `
You are an expert at extracting data from the markdown of a webpage.

<input>
You will be given a query and the markdown of a webpage that has been filtered to remove noise and advertising content.
</input>

<instructions>
- You are tasked to extract information from the webpage that is relevant to the query.
- You should ONLY use the information available in the webpage to answer the query. Do not make up information or provide guess from your own knowledge.
- If the information relevant to the query is not available in the page, your response should mention that.
- If the query asks for all items, products, etc., make sure to directly list all of them.
- If the content was truncated and you need more information, note that the user can use start_from_char parameter to continue from where truncation occurred.
- If <already_collected> items are provided, exclude any results whose name/title/URL matches those already collected. Do not include duplicates.
</instructions>

<output>
- Your output should present ALL the information relevant to the query in a concise way.
- Do not answer in conversational format - directly output the relevant information or that the information is unavailable.
</output>`.trim();
      const prompt =
        `<query>\n${sanitizedQuery}\n</query>\n\n` +
        `<content_stats>\n${statsSummary}\n</content_stats>\n\n` +
        `<webpage_content>\n${content}\n</webpage_content>` +
        (alreadyCollected.length > 0
          ? `\n\n<already_collected>\nSkip items whose name/title/URL matches any of these already-collected identifiers:\n${alreadyCollected
              .slice(0, 100)
              .map((item) => `- ${item}`)
              .join('\n')}\n</already_collected>`
          : '');
      const response = await (page_extraction_llm as any).ainvoke(
        [new SystemMessage(systemPrompt), new UserMessage(prompt)],
        undefined,
        { signal: signal ?? undefined }
      );
      throwIfAborted(signal);
      const completion = response?.completion;
      const completionText =
        typeof completion === 'string'
          ? completion
          : JSON.stringify(completion ?? {});
      const extractedContent =
        `<url>\n${pageUrl}\n</url>\n` +
        `<query>\n${sanitizedQuery}\n</query>\n` +
        `<result>\n${completionText}\n</result>`;
      const includeOnce = extractedContent.length >= maxMemoryLength;
      const memory = includeOnce
        ? `Query: ${sanitizedQuery}\nContent in ${await fsInstance.save_extracted_content(extractedContent)} and once in <read_state>.`
        : extractedContent;

      return new ActionResult({
        extracted_content: extractedContent,
        include_extracted_content_only_once: includeOnce,
        long_term_memory: memory,
      });
    });

    this.registry.action(extractStructuredDescription, {
      param_model: ExtractStructuredDataActionSchema,
      action_name: 'extract',
    })(async function extract(
      params: ExtractStructuredAction,
      {
        browser_session,
        page_extraction_llm,
        extraction_schema,
        file_system,
        available_file_paths,
        sensitive_data,
        signal,
      }
    ) {
      return registry.execute_action('extract_structured_data', params as any, {
        browser_session,
        page_extraction_llm,
        extraction_schema,
        file_system,
        available_file_paths,
        sensitive_data,
        signal,
      });
    });
  }

  private registerExplorationActions() {
    type SearchPageAction = z.infer<typeof SearchPageActionSchema>;
    this.registry.action(
      'Search page text for a pattern (like grep). Zero LLM cost and instant.',
      { param_model: SearchPageActionSchema }
    )(async function search_page(
      params: SearchPageAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('No active page for search_page.');
      }

      type SearchPageResult = {
        error?: string;
        matches?: Array<{
          position: number;
          match: string;
          snippet: string;
        }>;
        total?: number;
        truncated?: boolean;
      };
      let searchResult: SearchPageResult | null = null;
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        searchResult = (await page.evaluate(
          ({
            pattern,
            regex,
            caseSensitive,
            contextChars,
            cssScope,
            maxResults,
          }: {
            pattern: string;
            regex: boolean;
            caseSensitive: boolean;
            contextChars: number;
            cssScope: string | null;
            maxResults: number;
          }) => {
            const sourceNode = cssScope
              ? document.querySelector(cssScope)
              : document.body;
            if (!sourceNode) {
              return {
                error: `CSS scope not found: ${cssScope}`,
                matches: [],
                total: 0,
              };
            }
            const sourceText =
              (sourceNode as HTMLElement).innerText ||
              sourceNode.textContent ||
              '';
            if (!sourceText.trim()) {
              return {
                matches: [],
                total: 0,
              };
            }

            const safePattern = regex
              ? pattern
              : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flags = caseSensitive ? 'g' : 'gi';

            let matcher: RegExp;
            try {
              matcher = new RegExp(safePattern, flags);
            } catch (error: unknown) {
              return {
                error: `Invalid regex pattern: ${String(error)}`,
                matches: [],
                total: 0,
              };
            }

            const matches: Array<{
              position: number;
              match: string;
              snippet: string;
            }> = [];
            let foundTotal = 0;
            let m: RegExpExecArray | null;
            while ((m = matcher.exec(sourceText)) !== null) {
              foundTotal += 1;
              if (matches.length < Math.max(1, maxResults)) {
                const start = Math.max(0, m.index - Math.max(0, contextChars));
                const end = Math.min(
                  sourceText.length,
                  m.index + m[0].length + Math.max(0, contextChars)
                );
                matches.push({
                  position: m.index,
                  match: m[0],
                  snippet: sourceText.slice(start, end),
                });
              }
              if (m[0].length === 0) {
                matcher.lastIndex += 1;
              }
            }

            return {
              matches,
              total: foundTotal,
              truncated: foundTotal > matches.length,
            };
          },
          {
            pattern: params.pattern,
            regex: params.regex,
            caseSensitive: params.case_sensitive,
            contextChars: params.context_chars,
            cssScope: params.css_scope ?? null,
            maxResults: params.max_results,
          }
        )) as SearchPageResult | null;
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }

      if (!searchResult) {
        return new ActionResult({ error: 'search_page returned no result' });
      }
      if (searchResult.error) {
        return new ActionResult({
          error: `search_page: ${searchResult.error}`,
        });
      }

      const total = searchResult.total ?? 0;
      const matches = searchResult.matches ?? [];
      if (total === 0 || !matches.length) {
        const noMatchMessage = `No matches found for "${params.pattern}".`;
        return new ActionResult({
          extracted_content: noMatchMessage,
          long_term_memory: `Searched page for "${params.pattern}": 0 matches found.`,
        });
      }

      const lines: string[] = [
        `Found ${total} matches for "${params.pattern}" in page text:`,
      ];
      for (let i = 0; i < matches.length; i += 1) {
        const match = matches[i];
        const compactSnippet = match.snippet.replace(/\s+/g, ' ').trim();
        lines.push(
          `${i + 1}. [pos ${match.position}] "${match.match}" -> ${compactSnippet}`
        );
      }
      if (searchResult.truncated) {
        lines.push(
          `... showing first ${matches.length} matches (increase max_results to see more).`
        );
      }

      const memory = `Searched page for "${params.pattern}": ${total} match${total === 1 ? '' : 'es'} found.`;
      return new ActionResult({
        extracted_content: lines.join('\n'),
        long_term_memory: memory,
      });
    });

    type FindElementsAction = z.infer<typeof FindElementsActionSchema>;
    this.registry.action(
      'Query DOM elements by CSS selector (like find). Zero LLM cost and instant.',
      { param_model: FindElementsActionSchema }
    )(async function find_elements(
      params: FindElementsAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('No active page for find_elements.');
      }

      type FindElementsResult = {
        error?: string;
        elements?: Array<{
          index: number;
          tag: string;
          text: string;
          attributes: Record<string, string>;
        }>;
        total?: number;
        truncated?: boolean;
      };
      let result: FindElementsResult | null = null;
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        result = (await page.evaluate(
          ({
            selector,
            attributes,
            maxResults,
            includeText,
          }: {
            selector: string;
            attributes: string[] | null;
            maxResults: number;
            includeText: boolean;
          }) => {
            let elements: Element[];
            try {
              elements = Array.from(document.querySelectorAll(selector));
            } catch (error: unknown) {
              return {
                error: `Invalid selector: ${String(error)}`,
                elements: [],
                total: 0,
              };
            }

            const selected = elements.slice(0, Math.max(1, maxResults));
            const payload = selected.map((el, idx) => {
              const attrs: Record<string, string> = {};
              if (attributes?.length) {
                for (const attr of attributes) {
                  const value = el.getAttribute(attr);
                  if (value != null) {
                    attrs[attr] = value;
                  }
                }
              }
              return {
                index: idx + 1,
                tag: el.tagName.toLowerCase(),
                text: includeText
                  ? (el.textContent || '').replace(/\s+/g, ' ').trim()
                  : '',
                attributes: attrs,
              };
            });

            return {
              elements: payload,
              total: elements.length,
              truncated: elements.length > selected.length,
            };
          },
          {
            selector: params.selector,
            attributes: params.attributes ?? null,
            maxResults: params.max_results,
            includeText: params.include_text,
          }
        )) as FindElementsResult | null;
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }

      if (!result) {
        return new ActionResult({ error: 'find_elements returned no result' });
      }
      if (result.error) {
        return new ActionResult({ error: `find_elements: ${result.error}` });
      }

      const elements = result.elements ?? [];
      const total = result.total ?? 0;
      if (!elements.length) {
        const msg = `No elements found for selector "${params.selector}".`;
        return new ActionResult({
          extracted_content: msg,
          long_term_memory: msg,
        });
      }

      const lines: string[] = [
        `Found ${total} element${total === 1 ? '' : 's'} for selector "${params.selector}":`,
      ];
      for (const el of elements) {
        const attrs = Object.entries(el.attributes || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ');
        const text =
          params.include_text && el.text
            ? ` text=${JSON.stringify(el.text)}`
            : '';
        lines.push(
          `${el.index}. <${el.tag}>${text}${attrs ? ` ${attrs}` : ''}`.trim()
        );
      }
      if (result.truncated) {
        lines.push(
          `... showing first ${elements.length} elements (increase max_results to see more).`
        );
      }

      return new ActionResult({
        extracted_content: lines.join('\n'),
        long_term_memory: `Queried selector "${params.selector}" and found ${total} element${total === 1 ? '' : 's'}.`,
      });
    });
  }

  private registerScrollActions() {
    const registry = this.registry;
    const scrollLogger = this.logger; // Capture logger reference for use in named function
    type ScrollAction = z.infer<typeof ScrollActionSchema>;

    // Define the scroll handler implementation (shared by multiple action names for LLM compatibility)
    const scrollImpl = async (
      params: ScrollAction,
      { browser_session, signal }: any
    ) => {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      if (!page || !page.evaluate) {
        throw new BrowserError('Unable to access current page for scrolling.');
      }

      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        // Helper function to get window height with retries
        const getWindowHeight = async (retries = 3): Promise<number> => {
          for (let i = 0; i < retries; i++) {
            throwIfAborted(signal);
            try {
              const height = await page.evaluate(() => window.innerHeight);
              return height || 0;
            } catch (error) {
              if (i === retries - 1) {
                throw new Error(`Scroll failed due to an error: ${error}`, {
                  cause: error,
                });
              }
              await waitWithSignal(1000, signal);
            }
          }
          return 0;
        };

        const windowHeight = await getWindowHeight();
        const pagesScrolled = params.pages ?? params.num_pages ?? 1;
        const scrollAmount = Math.floor(windowHeight * pagesScrolled);
        const dy = params.down ? scrollAmount : -scrollAmount;
        const direction = params.down ? 'down' : 'up';
        let scrollTarget = 'the page';

        // Element-specific scrolling if index is provided
        if (params.index !== undefined && params.index !== null) {
          try {
            const elementNode = await browser_session.get_dom_element_by_index(
              params.index,
              { signal }
            );
            if (!elementNode) {
              return new ActionResult({
                error: `Element index ${params.index} not found in browser state`,
              });
            }

            // Try direct container scrolling (no events that might close dropdowns)
            const containerScrollJs = `
						(params) => {
							const { dy, elementXPath } = params;

							// Get the target element by XPath
							const targetElement = document.evaluate(elementXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
							if (!targetElement) {
								return { success: false, reason: 'Element not found by XPath' };
							}

							// Try to find scrollable containers in the hierarchy (starting from element itself)
							let currentElement = targetElement;
							let scrollSuccess = false;
							let scrolledElement = null;
							let scrollDelta = 0;
							let attempts = 0;

							// Check up to 10 elements in hierarchy (including the target element itself)
							while (currentElement && attempts < 10) {
								const computedStyle = window.getComputedStyle(currentElement);
								const hasScrollableY = /(auto|scroll|overlay)/.test(computedStyle.overflowY);
								const canScrollVertically = currentElement.scrollHeight > currentElement.clientHeight;

								if (hasScrollableY && canScrollVertically) {
									const beforeScroll = currentElement.scrollTop;
									const maxScroll = currentElement.scrollHeight - currentElement.clientHeight;

									// Calculate scroll amount (1/3 of provided dy for gentler scrolling)
									let scrollAmount = dy / 3;

									// Ensure we don't scroll beyond bounds
									if (scrollAmount > 0) {
										scrollAmount = Math.min(scrollAmount, maxScroll - beforeScroll);
									} else {
										scrollAmount = Math.max(scrollAmount, -beforeScroll);
									}

									// Try direct scrollTop manipulation (most reliable)
									currentElement.scrollTop = beforeScroll + scrollAmount;

									const afterScroll = currentElement.scrollTop;
									const actualScrollDelta = afterScroll - beforeScroll;

									if (Math.abs(actualScrollDelta) > 0.5) {
										scrollSuccess = true;
										scrolledElement = currentElement;
										scrollDelta = actualScrollDelta;
										break;
									}
								}

								// Move to parent (but don't go beyond body for dropdown case)
								if (currentElement === document.body || currentElement === document.documentElement) {
									break;
								}
								currentElement = currentElement.parentElement;
								attempts++;
							}

							if (scrollSuccess) {
								// Successfully scrolled a container
								return {
									success: true,
									method: 'direct_container_scroll',
									containerType: 'element',
									containerTag: scrolledElement.tagName.toLowerCase(),
									containerClass: scrolledElement.className || '',
									containerId: scrolledElement.id || '',
									scrollDelta: scrollDelta
								};
							} else {
								// No container found or could scroll
								return {
									success: false,
									reason: 'No scrollable container found',
									needsPageScroll: true
								};
							}
						}
						`;

            const scrollParams = { dy, elementXPath: elementNode.xpath };
            const result = (await page.evaluate(
              containerScrollJs,
              scrollParams
            )) as any;

            if (result.success) {
              if (result.containerType === 'element') {
                let containerInfo = result.containerTag;
                if (result.containerId) {
                  containerInfo += `#${result.containerId}`;
                } else if (result.containerClass) {
                  containerInfo += `.${result.containerClass.split(' ')[0]}`;
                }
                scrollTarget = `element ${params.index}'s scroll container (${containerInfo})`;
                // Don't do additional page scrolling since we successfully scrolled the container
              } else {
                scrollTarget = `the page (fallback from element ${params.index})`;
              }
            } else {
              // Container scroll failed, need page-level scrolling
              scrollLogger.debug(
                `Container scroll failed for element ${params.index}: ${result.reason || 'Unknown'}`
              );
              scrollTarget = `the page (no container found for element ${params.index})`;
              // This will trigger page-level scrolling below
            }
          } catch (error) {
            scrollLogger.debug(
              `Element-specific scrolling failed for index ${params.index}: ${error}`
            );
            scrollTarget = `the page (fallback from element ${params.index})`;
            // Fall through to page-level scrolling
          }
        }

        // Page-level scrolling (default or fallback)
        if (
          scrollTarget === 'the page' ||
          scrollTarget.includes('fallback') ||
          scrollTarget.includes('no container found') ||
          scrollTarget.includes('mouse wheel failed')
        ) {
          scrollLogger.debug(
            `🔄 Performing page-level scrolling. Reason: ${scrollTarget}`
          );
          try {
            await dispatchBrowserEventIfAvailable(
              browser_session,
              new ScrollEvent({
                direction,
                amount: Math.abs(dy),
              }),
              () => (browser_session as any)._scrollContainer(dy)
            );
          } catch (error) {
            // Hard fallback: always works on root scroller
            await page.evaluate((y: number) => window.scrollBy(0, y), dy);
            scrollLogger.debug(
              'Smart scroll failed; used window.scrollBy fallback',
              error
            );
          }
        }

        // Create descriptive message
        let longTermMemory: string;
        if (pagesScrolled === 1.0) {
          longTermMemory = `Scrolled ${direction} ${scrollTarget} by one page`;
        } else {
          longTermMemory = `Scrolled ${direction} ${scrollTarget} by ${pagesScrolled} pages`;
        }

        const msg = `🔍 ${longTermMemory}`;
        scrollLogger.info(msg);

        return new ActionResult({
          extracted_content: msg,
          include_in_memory: true,
          long_term_memory: longTermMemory,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    };

    // Register scroll action with multiple names for LLM compatibility
    // Different LLMs may use different names: scroll, scroll_page, scroll_down
    const scrollDescription =
      'Scroll the page by specified number of pages (set down=True to scroll down, down=False to scroll up, num_pages=number of pages to scroll like 0.5 for half page, 1.0 for one page, etc.). Optional index parameter to scroll within a specific element or its scroll container (works well for dropdowns and custom UI components).';

    // Create named functions that wrap the implementation
    // Different LLMs may use different names: scroll, scroll_page, scroll_down, scroll_by, scroll_page_by, scroll_up
    const scrollAction = async function scroll(p: ScrollAction, ctx: any) {
      return scrollImpl(p, ctx);
    };
    const scrollPageAction = async function scroll_page(
      p: ScrollAction,
      ctx: any
    ) {
      return scrollImpl(p, ctx);
    };
    const scrollDownAction = async function scroll_down(
      p: ScrollAction,
      ctx: any
    ) {
      return scrollImpl(p, ctx);
    };
    const scrollByAction = async function scroll_by(p: ScrollAction, ctx: any) {
      return scrollImpl(p, ctx);
    };
    const scrollPageByAction = async function scroll_page_by(
      p: ScrollAction,
      ctx: any
    ) {
      return scrollImpl(p, ctx);
    };
    const scrollUpAction = async function scroll_up(p: ScrollAction, ctx: any) {
      return scrollImpl(p, ctx);
    };

    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollPageAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollDownAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollByAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollPageByAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollUpAction);

    type ScrollToTextAction = z.infer<typeof ScrollToTextActionSchema>;
    this.registry.action('Scroll to a text in the current page', {
      param_model: ScrollToTextActionSchema,
    })(async function scroll_to_text(
      params: ScrollToTextAction,
      { browser_session }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      await dispatchBrowserEventIfAvailable(
        browser_session,
        new ScrollToTextEvent({
          text: params.text,
          direction: 'down',
        }),
        async () => {
          const page: Page | null = await browser_session.get_current_page();
          if (!page?.evaluate) {
            throw new BrowserError('Unable to access page for scrolling.');
          }

          await validateBrowserPageAfterAction(browser_session, page);
          let success = false;
          try {
            success = await page.evaluate(
              ({ text }: { text: string }) => {
                const iterator = document.createNodeIterator(
                  document.body,
                  NodeFilter.SHOW_ELEMENT
                );
                let node: Node | null;
                while ((node = iterator.nextNode())) {
                  const el = node as HTMLElement;
                  if (!el || !el.textContent) continue;
                  if (
                    el.textContent.toLowerCase().includes(text.toLowerCase())
                  ) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return true;
                  }
                }
                return false;
              },
              { text: params.text }
            );
          } finally {
            await validateBrowserPageAfterAction(browser_session, page);
          }

          if (!success) {
            throw new BrowserError(`Text '${params.text}' not found on page`);
          }
          return null;
        }
      );

      const msg = `🔍  Scrolled to text: ${params.text}`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: msg,
      });
    });

    this.registry.action('Scroll to text.', {
      param_model: ScrollToTextActionSchema,
      action_name: 'find_text',
    })(async function find_text(params: ScrollToTextAction, ctx) {
      try {
        return await registry.execute_action(
          'scroll_to_text',
          params as any,
          ctx as any
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const msg = `Text '${params.text}' not found or not visible on page`;
        return new ActionResult({
          extracted_content: msg,
          long_term_memory: `Tried scrolling to text '${params.text}' but it was not found`,
        });
      }
    });
  }

  private registerFileSystemActions() {
    const registry = this.registry;
    type ReadFileAction = z.infer<typeof ReadFileActionSchema>;
    this.registry.action(
      'Read the complete content of a file. Use this to view file contents before editing or to retrieve data from files. Supports text files (txt, md, json, csv, jsonl), documents (pdf, docx), and images (jpg, png).',
      {
        param_model: ReadFileActionSchema,
      }
    )(async function read_file(
      params: ReadFileAction,
      { file_system, available_file_paths }
    ) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      const allowed =
        Array.isArray(available_file_paths) &&
        available_file_paths.includes(params.file_name);
      const structuredResult =
        typeof (fsInstance as any).read_file_structured === 'function'
          ? await (fsInstance as any).read_file_structured(
              params.file_name,
              allowed
            )
          : {
              message: await fsInstance.read_file(params.file_name, allowed),
              images: null,
            };
      const result = String(structuredResult?.message ?? '');
      const images = Array.isArray(structuredResult?.images)
        ? structuredResult.images
        : null;
      const MAX_MEMORY_SIZE = 1000;
      let memory = result;
      if (images && images.length > 0) {
        memory = `Read image file ${params.file_name}`;
      } else if (result.length > MAX_MEMORY_SIZE) {
        const lines = result.split('\n');
        let preview = '';
        let used = 0;
        for (const line of lines) {
          if (preview.length + line.length > MAX_MEMORY_SIZE) break;
          preview += `${line}\n`;
          used += 1;
        }
        const remaining = lines.length - used;
        memory =
          remaining > 0 ? `${preview}${remaining} more lines...` : preview;
      }
      return new ActionResult({
        extracted_content: result,
        long_term_memory: memory,
        images,
        include_extracted_content_only_once: true,
      });
    });

    type WriteFileAction = z.infer<typeof WriteFileActionSchema>;
    this.registry.action(
      'Write content to a file. By default this OVERWRITES the entire file - use append=true to add to an existing file, or use replace_file for targeted edits within a file. ' +
        'FILENAME RULES: Use only letters, numbers, underscores, hyphens, dots, parentheses. Spaces are auto-converted to hyphens. ' +
        'SUPPORTED EXTENSIONS: .txt, .md, .json, .jsonl, .csv, .html, .xml, .pdf, .docx. ' +
        'CANNOT write binary/image files (.png, .jpg, .mp4, etc.) - do not attempt to save screenshots as files. ' +
        'For PDF files, write content in markdown format and it will be auto-converted to PDF.',
      {
        param_model: WriteFileActionSchema,
      }
    )(async function write_file(params: WriteFileAction, { file_system }) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      let content = params.content;
      const trailing = params.trailing_newline ?? true;
      const leading = params.leading_newline ?? false;
      if (trailing) {
        content = `${content}\n`;
      }
      if (leading) {
        content = `\n${content}`;
      }
      const append = params.append ?? false;
      const result = append
        ? await fsInstance.append_file(params.file_name, content)
        : await fsInstance.write_file(params.file_name, content);
      return new ActionResult({
        extracted_content: result,
        long_term_memory: result,
      });
    });

    type ReplaceAction = z.infer<typeof ReplaceFileStrActionSchema>;
    this.registry.action(
      'Replace specific text within a file by searching for old_str and replacing with new_str. Use this for targeted edits like updating todo checkboxes or modifying specific lines without rewriting the entire file.',
      {
        param_model: ReplaceFileStrActionSchema,
      }
    )(async function replace_file_str(params: ReplaceAction, { file_system }) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      const result = await fsInstance.replace_file_str(
        params.file_name,
        params.old_str,
        params.new_str
      );
      return new ActionResult({
        extracted_content: result,
        long_term_memory: result,
      });
    });

    this.registry.action(
      'Replace specific text within a file by searching for old_str and replacing with new_str. Use this for targeted edits like updating todo checkboxes or modifying specific lines without rewriting the entire file.',
      {
        param_model: ReplaceFileStrActionSchema,
        action_name: 'replace_file',
      }
    )(async function replace_file(params: ReplaceAction, ctx) {
      return registry.execute_action(
        'replace_file_str',
        params as any,
        ctx as any
      );
    });
  }

  private registerUtilityActions() {
    type ScreenshotAction = z.infer<typeof ScreenshotActionSchema>;
    type SaveAsPdfAction = z.infer<typeof SaveAsPdfActionSchema>;
    this.registry.action(
      'Take a screenshot of the current viewport. If file_name is provided, saves to that file and returns the path. Otherwise, screenshot is included in the next browser_state observation.',
      { param_model: ScreenshotActionSchema }
    )(async function screenshot(
      params: ScreenshotAction,
      { browser_session, file_system, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      if (params.file_name) {
        const screenshotB64 = await dispatchBrowserEventIfAvailable<
          string | null
        >(
          browser_session,
          new ScreenshotEvent({
            full_page: false,
          }),
          async () => (await browser_session.take_screenshot?.(false)) ?? null
        );
        if (!screenshotB64) {
          return new ActionResult({
            error: 'Failed to capture screenshot.',
          });
        }

        const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
        let fileName = params.file_name;
        if (!fileName.toLowerCase().endsWith('.png')) {
          fileName = `${fileName}.png`;
        }
        fileName = FileSystem.sanitize_filename(fileName);
        const filePath = path.join(fsInstance.get_dir(), fileName);
        await writePrivateBinaryFile(
          filePath,
          Buffer.from(screenshotB64, 'base64')
        );
        const msg = `📸 Saved screenshot to ${filePath}`;
        return new ActionResult({
          extracted_content: msg,
          long_term_memory: msg,
          attachments: [filePath],
        });
      }

      return new ActionResult({
        extracted_content: 'Requested screenshot for next observation',
        metadata: {
          include_screenshot: true,
        },
      });
    });

    this.registry.action(
      'Save the current page as a PDF file. Returns the file path of the saved PDF. Use this to capture the full page content as a printable document.',
      { param_model: SaveAsPdfActionSchema }
    )(async function save_as_pdf(
      params: SaveAsPdfAction,
      { browser_session, file_system, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const paperSizes: Record<string, { width: number; height: number }> = {
        letter: { width: 8.5, height: 11 },
        legal: { width: 8.5, height: 14 },
        a4: { width: 8.27, height: 11.69 },
        a3: { width: 11.69, height: 16.54 },
        tabloid: { width: 11, height: 17 },
      };

      const page = await browser_session.get_current_page?.();
      if (!page) {
        throw new BrowserError('No active page available for save_as_pdf.');
      }

      await validateBrowserPageAfterAction(browser_session, page, signal);
      const paperKey = String(params.paper_format ?? 'Letter').toLowerCase();
      const paperSize = paperSizes[paperKey] ?? paperSizes.letter;
      const cdpSession =
        await browser_session.get_or_create_cdp_session?.(page);
      if (!cdpSession?.send) {
        throw new BrowserError('CDP session unavailable for save_as_pdf.');
      }
      await validateBrowserPageAfterAction(browser_session, page, signal);

      let result: { data?: unknown } | null = null;
      try {
        result = await cdpSession.send('Page.printToPDF', {
          printBackground: params.print_background,
          landscape: params.landscape,
          scale: params.scale,
          paperWidth: paperSize.width,
          paperHeight: paperSize.height,
          preferCSSPageSize: true,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }

      const pdfData =
        result && typeof result.data === 'string' ? result.data : null;
      if (!pdfData) {
        throw new BrowserError('CDP Page.printToPDF returned no data.');
      }

      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);

      let fileName = params.file_name?.trim();
      if (!fileName) {
        await validateBrowserPageAfterAction(browser_session, page, signal);
        try {
          const titlePromise =
            typeof page.title === 'function'
              ? page.title()
              : Promise.resolve('');
          const pageTitle = await Promise.race([
            titlePromise,
            new Promise<string>((_, reject) => {
              setTimeout(() => reject(new Error('timeout')), 2000);
            }),
          ]);
          const safeTitle = String(pageTitle)
            .replace(/[^\w\s-]+/g, '')
            .trim()
            .slice(0, 50);
          fileName = safeTitle || 'page';
        } catch {
          fileName = 'page';
        } finally {
          await validateBrowserPageAfterAction(browser_session, page, signal);
        }
      }

      if (!fileName.toLowerCase().endsWith('.pdf')) {
        fileName = `${fileName}.pdf`;
      }
      fileName = FileSystem.sanitize_filename(fileName);

      const filePath = await resolveUniqueOutputPath(
        fsInstance.get_dir(),
        fileName
      );
      await validateBrowserPageAfterAction(browser_session, page, signal);
      await writePrivateBinaryFile(filePath, Buffer.from(pdfData, 'base64'));
      const fileSize = (await fsp.stat(filePath)).size;
      const baseName = path.basename(filePath);
      const msg = `Saved page as PDF: ${baseName} (${fileSize.toLocaleString()} bytes)`;

      return new ActionResult({
        extracted_content: msg,
        long_term_memory: `${msg}. Full path: ${filePath}`,
        attachments: [filePath],
      });
    });

    type EvaluateAction = z.infer<typeof EvaluateActionSchema>;
    const evaluateLogger = this.logger;
    this.registry.action(
      'Execute browser JavaScript on the current page and return the result.',
      { param_model: EvaluateActionSchema }
    )(async function evaluate(
      params: EvaluateAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('No active page available for evaluate.');
      }

      const validatedCode = validateAndFixJavaScript(params.code);
      if (validatedCode !== params.code) {
        evaluateLogger.info(
          `🛠 evaluate: auto-fixed input (len ${params.code.length} → ${validatedCode.length})`
        );
      }

      let payload: { ok: boolean; result?: unknown; error?: string } | null =
        null;
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        payload = (await page.evaluate(
          async ({ code }: { code: string }) => {
            try {
              const raw = await Promise.resolve((0, eval)(code));
              let serializedResult: unknown;
              if (raw === undefined) {
                serializedResult = null;
              } else {
                try {
                  serializedResult = JSON.parse(JSON.stringify(raw));
                } catch {
                  serializedResult = String(raw);
                }
              }
              return { ok: true, result: serializedResult };
            } catch (error: unknown) {
              return {
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : String(error ?? 'Unknown evaluate error'),
              };
            }
          },
          { code: validatedCode }
        )) as { ok: boolean; result?: unknown; error?: string } | null;
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }

      if (!payload) {
        return new ActionResult({ error: 'evaluate returned no result' });
      }
      if (!payload.ok) {
        const codePreview =
          validatedCode.length > 500
            ? `${validatedCode.slice(0, 500)}...`
            : validatedCode;
        return new ActionResult({
          error:
            `JavaScript Execution Failed:\n` +
            `JavaScript execution error: ${payload.error ?? 'Unknown error'}\n\n` +
            `Validated Code (after quote fixing):\n${codePreview}`,
        });
      }

      let rendered =
        typeof payload.result === 'string'
          ? payload.result
          : JSON.stringify(payload.result);

      const imagePattern = /(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/g;
      const foundImages = rendered.match(imagePattern) ?? [];
      let metadata: Record<string, unknown> | null = null;
      if (foundImages.length > 0) {
        metadata = { images: foundImages };
        for (const imageData of foundImages) {
          rendered = rendered.split(imageData).join('[Image]');
        }
      }

      const maxChars = 20000;
      if (rendered.length > maxChars) {
        rendered = `${rendered.slice(0, maxChars - 50)}\n... [Truncated after 20000 characters]`;
      }

      // Log the evaluate return value so callers (and trace consumers) can
      // see whether the executed code actually produced a result. Truncate
      // aggressively — the agent already has the full value via
      // extracted_content; this log is for debugging the "code ran but did
      // nothing" failure mode (e.g. unwrapped async fn expressions).
      const previewMax = 500;
      const preview =
        rendered.length > previewMax
          ? `${rendered.slice(0, previewMax)}... [+${rendered.length - previewMax} chars]`
          : rendered;
      evaluateLogger.info(`🧪 evaluate result (${rendered.length} chars): ${preview}`);

      const maxMemoryChars = 10000;
      const includeExtractedContentOnlyOnce = rendered.length >= maxMemoryChars;
      const longTermMemory = includeExtractedContentOnlyOnce
        ? `JavaScript executed successfully, result length: ${rendered.length} characters.`
        : rendered;

      return new ActionResult({
        extracted_content: rendered,
        long_term_memory: longTermMemory,
        include_extracted_content_only_once: includeExtractedContentOnlyOnce,
        metadata,
      });
    });
  }

  private registerKeyboardActions() {
    type SendKeysAction = z.infer<typeof SendKeysActionSchema>;
    this.registry.action('Send keys to the active page', {
      param_model: SendKeysActionSchema,
    })(async function send_keys(params: SendKeysAction, { browser_session }) {
      if (!browser_session) throw new Error('Browser session missing');
      await dispatchBrowserEventIfAvailable(
        browser_session,
        new SendKeysEvent({ keys: params.keys }),
        async () => {
          const page: Page | null = await browser_session.get_current_page();
          const keyboard = page?.keyboard;
          if (!keyboard) {
            throw new BrowserError(
              'Keyboard input is not available on the current page.'
            );
          }
          await validateBrowserPageAfterAction(browser_session, page);
          try {
            await keyboard.press(params.keys);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes('Unknown key')
            ) {
              for (const char of params.keys) {
                await keyboard.press(char);
              }
            } else {
              throw error;
            }
          } finally {
            await validateBrowserPageAfterAction(browser_session, page);
          }
          return null;
        }
      );
      const msg = `⌨️  Sent keys: ${params.keys}`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: msg,
      });
    });
  }

  private registerDropdownActions() {
    const registry = this.registry;
    const dropdownLogger = this.logger;
    const formatAvailableOptions = (
      options: Array<{ index: number; text: string; value: string }>
    ) =>
      options
        .map(
          (opt) =>
            `  - [${opt.index}] text=${JSON.stringify(opt.text)} value=${JSON.stringify(opt.value)}`
        )
        .join('\n');

    type DropdownAction = z.infer<typeof DropdownOptionsActionSchema>;
    this.registry.action(
      'Get all options from a native dropdown or ARIA menu',
      { param_model: DropdownOptionsActionSchema }
    )(async function get_dropdown_options(
      params: DropdownAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const domElement = await browser_session.get_dom_element_by_index(
        params.index,
        { signal }
      );
      if (!domElement) {
        const msg = `Element index ${params.index} not available - page may have changed. Try refreshing browser state.`;
        dropdownLogger.warning(`⚠️ ${msg}`);
        return new ActionResult({
          extracted_content: msg,
        });
      }
      if (typeof browser_session.dispatch_browser_event === 'function') {
        const dispatchResult = await browser_session.dispatch_browser_event(
          new GetDropdownOptionsEvent({ node: domElement })
        );
        const eventResult = dispatchResult?.event?.event_result as
          | Record<string, string>
          | null
          | undefined;
        const eventMessage =
          eventResult?.message ??
          eventResult?.short_term_memory ??
          eventResult?.formatted_options ??
          null;
        if (eventMessage) {
          const memory =
            eventResult?.long_term_memory ??
            `Found dropdown options for index ${params.index}.`;
          return new ActionResult({
            extracted_content: eventMessage,
            include_in_memory: true,
            include_extracted_content_only_once: true,
            long_term_memory: memory,
          });
        }
      }

      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError(
          'Unable to evaluate dropdown options on current page.'
        );
      }
      if (!domElement.xpath) {
        throw new BrowserError(
          'DOM element does not include an XPath selector.'
        );
      }

      await validateBrowserPageAfterAction(browser_session, page, signal);
      let payload: any = null;
      try {
        payload = await page.evaluate(
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
          { xpath: domElement.xpath }
        );
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }

      if (!payload || !payload.options?.length) {
        throw new BrowserError('No options found for the specified dropdown.');
      }

      const formatted = payload.options.map(
        (opt: any) =>
          `${opt.index}: text=${JSON.stringify(opt.text ?? '')}, value=${JSON.stringify(opt.value ?? '')}`
      );
      formatted.push(
        'Prefer exact text first; if needed select_dropdown_option also supports case-insensitive text/value matching.'
      );

      const message = formatted.join('\n');
      return new ActionResult({
        extracted_content: message,
        include_in_memory: true,
        include_extracted_content_only_once: true,
        long_term_memory: `Found dropdown options for index ${params.index}.`,
      });
    });

    this.registry.action(
      'Get all options from a native dropdown or ARIA menu',
      {
        param_model: DropdownOptionsActionSchema,
        action_name: 'dropdown_options',
      }
    )(async function dropdown_options(params: DropdownAction, ctx) {
      return registry.execute_action(
        'get_dropdown_options',
        params as any,
        ctx as any
      );
    });

    type SelectAction = z.infer<typeof SelectDropdownActionSchema>;
    this.registry.action('Select dropdown option or ARIA menu item by text', {
      param_model: SelectDropdownActionSchema,
    })(async function select_dropdown_option(
      params: SelectAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const domElement = await browser_session.get_dom_element_by_index(
        params.index,
        { signal }
      );
      if (!domElement) {
        const msg = `Element index ${params.index} not available - page may have changed. Try refreshing browser state.`;
        dropdownLogger.warning(`⚠️ ${msg}`);
        return new ActionResult({
          extracted_content: msg,
        });
      }
      if (!domElement?.xpath) {
        throw new BrowserError(
          'DOM element does not include an XPath selector.'
        );
      }
      if (typeof browser_session.dispatch_browser_event === 'function') {
        const dispatchResult = await browser_session.dispatch_browser_event(
          new SelectDropdownOptionEvent({
            node: domElement,
            text: params.text,
          })
        );
        const eventResult = dispatchResult?.event?.event_result as
          | Record<string, string>
          | null
          | undefined;
        const eventMessage =
          eventResult?.message ??
          eventResult?.short_term_memory ??
          eventResult?.matched_text ??
          null;
        if (eventMessage) {
          const memory = eventResult?.long_term_memory ?? eventMessage;
          return new ActionResult({
            extracted_content: eventMessage,
            include_in_memory: true,
            long_term_memory: memory,
          });
        }
      }

      const page: Page | null = await browser_session.get_current_page();
      if (!page) {
        throw new BrowserError('No active page for selection.');
      }

      await validateBrowserPageAfterAction(browser_session, page, signal);
      for (const frame of page.frames ?? []) {
        try {
          const typeInfo = await frame.evaluate((xpath: string) => {
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
          }, domElement.xpath);

          if (!typeInfo?.found) continue;

          if (typeInfo.type === 'select') {
            const selection = await frame.evaluate(
              ({ xpath, text }: { xpath: string; text: string }) => {
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
                const targetRaw = text.trim();
                const targetLower = text.trim().toLowerCase();

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
              { xpath: domElement.xpath, text: params.text }
            );

            if (selection?.found && selection.success) {
              const matchedText = selection.matched?.text ?? params.text;
              const matchedValue = selection.matched?.value ?? '';
              const msg = `Selected option ${matchedText} (${matchedValue})`;
              return new ActionResult({
                extracted_content: msg,
                include_in_memory: true,
                long_term_memory: msg,
              });
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
                `Could not select option '${params.text}' for index ${params.index}.\nAvailable options:\n${details}`
              );
            }
            continue;
          }

          const clicked = await frame.evaluate(
            ({ xpath, text }: { xpath: string; text: string }) => {
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
              const targetRaw = text.trim();
              const targetLower = text.trim().toLowerCase();

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
            { xpath: domElement.xpath, text: params.text }
          );

          if (clicked?.found && clicked.success) {
            const matchedText = clicked.matched?.text ?? params.text;
            const msg = `Selected menu item ${matchedText}`;
            return new ActionResult({
              extracted_content: msg,
              include_in_memory: true,
              long_term_memory: msg,
            });
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
              `Could not select option '${params.text}' for index ${params.index}.\nAvailable options:\n${details}`
            );
          }
        } catch (error) {
          if (error instanceof BrowserError) {
            throw error;
          }
          continue;
        } finally {
          await validateBrowserPageAfterAction(browser_session, page, signal);
        }
      }

      throw new BrowserError(
        `Could not select option '${params.text}' for index ${params.index}`
      );
    });

    this.registry.action('Select dropdown option or ARIA menu item by text', {
      param_model: SelectDropdownActionSchema,
      action_name: 'select_dropdown',
    })(async function select_dropdown(params: SelectAction, ctx) {
      return registry.execute_action(
        'select_dropdown_option',
        params as any,
        ctx as any
      );
    });
  }

  private registerSheetsActions() {
    const gotoSheetsRange = this.gotoSheetsRange.bind(this);

    this.registry.action(
      'Google Sheets: Get the contents of the entire sheet',
      {
        domains: ['https://docs.google.com'],
      }
    )(async function sheets_get_contents(_params, { browser_session, signal }) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        await page?.keyboard?.press('Enter');
        await page?.keyboard?.press('Escape');
        await page?.keyboard?.press('ControlOrMeta+A');
        await page?.keyboard?.press('ControlOrMeta+C');
        const content = await page?.evaluate?.(() =>
          navigator.clipboard.readText()
        );
        return new ActionResult({
          extracted_content: content ?? '',
          include_in_memory: true,
          long_term_memory: 'Retrieved sheet contents',
          include_extracted_content_only_once: true,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    });

    type SheetsRange = z.infer<typeof SheetsRangeActionSchema>;
    this.registry.action(
      'Google Sheets: Get the contents of a cell or range of cells',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsRangeActionSchema,
      }
    )(async function sheets_get_range(
      params: SheetsRange,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        await gotoSheetsRange(page, params.cell_or_range, signal);
        await page?.keyboard?.press('ControlOrMeta+C');
        await waitWithSignal(100, signal);
        const content = await page?.evaluate?.(() =>
          navigator.clipboard.readText()
        );
        return new ActionResult({
          extracted_content: content ?? '',
          include_in_memory: true,
          long_term_memory: `Retrieved contents from ${params.cell_or_range}`,
          include_extracted_content_only_once: true,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    });

    type SheetsUpdate = z.infer<typeof SheetsUpdateActionSchema>;
    this.registry.action(
      'Google Sheets: Update the content of a cell or range of cells',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsUpdateActionSchema,
      }
    )(async function sheets_update(
      params: SheetsUpdate,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        await gotoSheetsRange(page, params.cell_or_range, signal);
        await page?.evaluate?.((value: string) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', value);
          document.activeElement?.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData })
          );
        }, params.value);
        return new ActionResult({
          extracted_content: `Updated cells: ${params.cell_or_range} = ${params.value}`,
          long_term_memory: `Updated cells ${params.cell_or_range} with ${params.value}`,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    });

    this.registry.action(
      'Google Sheets: Clear whatever cells are currently selected',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsRangeActionSchema,
      }
    )(async function sheets_clear(
      params: SheetsRange,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        await gotoSheetsRange(page, params.cell_or_range, signal);
        await page?.keyboard?.press('Backspace');
        return new ActionResult({
          extracted_content: `Cleared cells: ${params.cell_or_range}`,
          long_term_memory: `Cleared cells ${params.cell_or_range}`,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    });

    this.registry.action(
      'Google Sheets: Select a specific cell or range of cells',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsRangeActionSchema,
      }
    )(async function sheets_select(
      params: SheetsRange,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        await gotoSheetsRange(page, params.cell_or_range, signal);
        return new ActionResult({
          extracted_content: `Selected cells: ${params.cell_or_range}`,
          long_term_memory: `Selected cells ${params.cell_or_range}`,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    });

    this.registry.action(
      'Google Sheets: Fallback method to type text into the currently selected cell',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsInputActionSchema,
      }
    )(async function sheets_input(
      params: z.infer<typeof SheetsInputActionSchema>,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await validateBrowserPageAfterAction(browser_session, page, signal);
      try {
        await page?.keyboard?.type(params.text, { delay: 100 });
        await page?.keyboard?.press('Enter');
        await page?.keyboard?.press('ArrowUp');
        return new ActionResult({
          extracted_content: `Inputted text ${params.text}`,
          long_term_memory: `Inputted text '${params.text}' into cell`,
        });
      } finally {
        await validateBrowserPageAfterAction(browser_session, page, signal);
      }
    });
  }

  private async gotoSheetsRange(
    page: Page | null,
    cell_or_range: string,
    signal: AbortSignal | null = null
  ) {
    if (!page?.keyboard) {
      throw new BrowserError(
        'No keyboard available for Google Sheets actions.'
      );
    }
    throwIfAborted(signal);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await waitWithSignal(100, signal);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    await waitWithSignal(100, signal);
    await page.keyboard.press('Control+G');
    await waitWithSignal(200, signal);
    await page.keyboard.type(cell_or_range, { delay: 50 });
    await page.keyboard.press('Enter');
    await waitWithSignal(200, signal);
    await page.keyboard.press('Escape');
  }

  private registerDoneAction(outputModel: z.ZodTypeAny | null) {
    const displayFilesInDoneText = this.displayFilesInDoneText;

    if (outputModel) {
      const structuredSchema = StructuredOutputActionSchema(outputModel);
      type StructuredParams = z.infer<typeof structuredSchema>;
      this.registry.action(
        'Complete task - with return text and success flag.',
        { param_model: structuredSchema }
      )(async function done(params: StructuredParams) {
        const payload =
          params.data &&
          typeof params.data === 'object' &&
          !Array.isArray(params.data)
            ? (params.data as Record<string, unknown>)
            : {};
        return new ActionResult({
          is_done: true,
          success: params.success,
          extracted_content: JSON.stringify(payload),
          long_term_memory: `Task completed. Success Status: ${params.success}`,
        });
      });
      return;
    }

    type DoneAction = z.infer<typeof DoneActionSchema>;
    this.registry.action('Complete task - provide a summary to the user.', {
      param_model: DoneActionSchema,
    })(async function done(params: DoneAction, { file_system }) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      let userMessage = params.text;
      const lenMaxMemory = 100;
      let memory = `Task completed: ${params.success} - ${params.text.slice(0, lenMaxMemory)}`;
      if (params.text.length > lenMaxMemory) {
        memory += ` - ${params.text.length - lenMaxMemory} more characters`;
      }

      const attachments: string[] = [];
      if (params.files_to_display) {
        if (displayFilesInDoneText) {
          let attachmentText = '';
          for (const fileName of params.files_to_display) {
            const content = fsInstance.display_file(fileName);
            if (content) {
              attachmentText += `\n\n${fileName}:\n${content}`;
              attachments.push(fileName);
            }
          }
          if (attachmentText) {
            userMessage += '\n\nAttachments:';
            userMessage += attachmentText;
          }
        } else {
          for (const fileName of params.files_to_display) {
            const content = fsInstance.display_file(fileName);
            if (content) {
              attachments.push(fileName);
            }
          }
        }
      }

      const attachmentPaths = attachments.map(
        (name) => `${fsInstance.get_dir()}/${name}`
      );
      return new ActionResult({
        is_done: true,
        success: params.success,
        extracted_content: userMessage,
        long_term_memory: memory,
        attachments: attachmentPaths,
      });
    });
  }

  use_structured_output_action(outputModel: z.ZodTypeAny) {
    this.outputModel = outputModel;
    this.registerDoneAction(outputModel);
  }

  get_output_model(): z.ZodTypeAny | null {
    return this.outputModel;
  }

  exclude_action(actionName: string) {
    this.registry.exclude_action(actionName);
  }

  set_coordinate_clicking(enabled: boolean) {
    const resolved = Boolean(enabled);
    if (resolved === this.coordinateClickingEnabled) {
      return;
    }
    this.coordinateClickingEnabled = resolved;
    this.registerClickActions();
    this.logger.debug(
      `Coordinate clicking ${resolved ? 'enabled' : 'disabled'}`
    );
  }

  action(description: string, options = {}) {
    return this.registry.action(description, options);
  }

  async act(
    action: Record<string, unknown>,
    {
      browser_session,
      page_extraction_llm = null,
      sensitive_data = null,
      available_file_paths = null,
      file_system = null,
      context = null,
      signal = null,
      action_timeout = null,
    }: ActParams<Context>
  ) {
    const entries = toActionEntries(action);
    for (const [actionName, params] of entries) {
      try {
        const result = await runActionWithTimeout(
          actionName,
          action_timeout,
          signal,
          (actionSignal) =>
            this.registry.execute_action(
              actionName,
              params as Record<string, unknown>,
              {
                browser_session,
                page_extraction_llm,
                sensitive_data,
                available_file_paths,
                file_system,
                context,
                signal: actionSignal,
              }
            )
        );
        if (typeof result === 'string') {
          return new ActionResult({ extracted_content: result });
        }
        if (result instanceof ActionResult) {
          return result;
        }
        if (result == null) {
          return new ActionResult();
        }
        const resultType =
          result && typeof result === 'object'
            ? (result.constructor?.name ?? typeof result)
            : typeof result;
        throw new Error(
          `Invalid action result type: ${resultType} of ${String(result)}`
        );
      } catch (error: any) {
        if (error instanceof BrowserError) {
          if (error.long_term_memory != null) {
            if (error.short_term_memory != null) {
              return new ActionResult({
                extracted_content: error.short_term_memory,
                error: error.long_term_memory,
                include_extracted_content_only_once: true,
              });
            }
            return new ActionResult({
              error: error.long_term_memory,
            });
          }
          throw error;
        }
        if (isActionTimeoutError(error)) {
          return new ActionResult({
            error: error.message,
          });
        }
        const message = String(error?.message ?? error ?? '');
        if (
          error instanceof Error &&
          message === `Error executing action ${actionName} due to timeout.`
        ) {
          return new ActionResult({
            error: `${actionName} was not executed due to timeout.`,
          });
        }
        return new ActionResult({
          error: message,
        });
      }
    }

    return new ActionResult();
  }
}
