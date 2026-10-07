/**
 * MCP Server for browser-use - exposes browser automation capabilities via Model Context Protocol.
 *
 * This server provides tools for:
 * - Running autonomous browser tasks with an AI agent
 * - Direct browser control (navigation, clicking, typing, etc.)
 * - Content extraction from web pages
 * - File system operations
 *
 * Usage:
 *     npx browser-use --mcp
 *
 * Or as an MCP server in Claude Desktop or other MCP clients:
 *     {
 *         "mcpServers": {
 *             "browser-use": {
 *                 "command": "npx",
 *                 "args": ["browser-use", "--mcp"],
 *                 "env": {
 *                     "OPENAI_API_KEY": "sk-proj-1234567890"
 *                 }
 *             }
 *         }
 *     }
 */

import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type ToolAnnotations,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createLogger } from '../logging-config.js';
import type { Controller } from '../controller/service.js';
import { Controller as DefaultController } from '../controller/service.js';
import { Agent } from '../agent/service.js';
import { BrowserSession } from '../browser/session.js';
import { BrowserStateRequestEvent } from '../browser/events.js';
import { BrowserProfile } from '../browser/profile.js';
import { FileSystem } from '../filesystem/file-system.js';
import type { BaseChatModel } from '../llm/base.js';
import { getLlmByName } from '../llm/models.js';
import {
  load_browser_use_config,
  get_default_llm,
  get_default_profile,
} from '../config.js';
import { zodSchemaToJsonSchema } from '../llm/schema.js';
import { productTelemetry } from '../telemetry/service.js';
import { MCPServerTelemetryEvent } from '../telemetry/views.js';
import { get_browser_use_version } from '../utils.js';
import { redactMcpLogMessage } from './redaction.js';

const logger = createLogger('browser_use.mcp.server');

const redirectConsoleToStderr = () => {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const writeToStderr = (...args: any[]) => console.error(...args);

  console.log = writeToStderr;
  console.info = writeToStderr;
  console.warn = writeToStderr;

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
  };
};

export interface MCPPromptTemplate {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  template: (args: Record<string, string>) => string;
}

interface MCPTrackedSession {
  session: BrowserSession;
  created_at: number;
  last_activity: number;
}

type MCPToolContent =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      data: string;
      mimeType: 'image/png';
    };

export class MCPServer {
  private server: Server;
  private tools: Record<string, any> = {};
  private prompts: Map<string, MCPPromptTemplate> = new Map();
  private config: Record<string, any>;
  private browserSession: BrowserSession | null = null;
  private controller: Controller<any> | null = null;
  private llm: BaseChatModel | null = null;
  private fileSystem: FileSystem | null = null;
  private startTime: number;
  private isRunning = false;
  private toolExecutionCount = 0;
  private errorCount = 0;
  private abortController: AbortController | null = null;
  private activeSessions: Map<string, MCPTrackedSession> = new Map();
  private sessionTimeoutMinutes = 10;
  private sessionCleanupInterval: NodeJS.Timeout | null = null;
  private restoreConsoleRedirect: (() => void) | null = null;

  constructor(name: string, version: string) {
    this.server = new Server(
      {
        name,
        version,
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.config = load_browser_use_config();
    const configuredTimeout = Number(
      process.env.BROWSER_USE_MCP_SESSION_TIMEOUT_MINUTES ?? '10'
    );
    this.sessionTimeoutMinutes =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 10;
    this.startTime = Date.now() / 1000;
    this.setupHandlers();
    this.registerDefaultPrompts();
    this.controller = new DefaultController();
    this.registerControllerActions(this.controller);
    this.registerCoreBrowserTools();
  }

  private resolvePath(input: string): string {
    const expanded = input.replace(/^~(?=$|\/|\\)/, os.homedir());
    return path.resolve(expanded);
  }

  private getDefaultProfileConfig(): Record<string, unknown> {
    const profile = get_default_profile(this.config);
    return profile && typeof profile === 'object' ? { ...profile } : {};
  }

  private getDefaultLlmConfig(): Record<string, unknown> {
    const llm = get_default_llm(this.config);
    return llm && typeof llm === 'object' ? { ...llm } : {};
  }

  private isPlaceholderOpenAiApiKey(apiKey: string): boolean {
    const normalized = apiKey.trim().toLowerCase();
    return (
      normalized === 'your-openai-api-key-here' ||
      normalized === 'your-openai-api-key'
    );
  }

  private seedOpenAiApiKeyFromConfig(llmConfig: Record<string, unknown>) {
    if (
      typeof process.env.OPENAI_API_KEY === 'string' &&
      process.env.OPENAI_API_KEY.trim()
    ) {
      return;
    }

    const configuredApiKey =
      typeof llmConfig.api_key === 'string' ? llmConfig.api_key.trim() : '';
    if (!configuredApiKey || this.isPlaceholderOpenAiApiKey(configuredApiKey)) {
      return;
    }

    process.env.OPENAI_API_KEY = configuredApiKey;
  }

  private createLlmFromModelName(
    modelName: string,
    llmConfig: Record<string, unknown>
  ): BaseChatModel {
    this.seedOpenAiApiKeyFromConfig(llmConfig);
    return getLlmByName(modelName);
  }

  private sanitizeProfileConfig(
    profileConfig: Record<string, unknown>
  ): Record<string, unknown> {
    const sanitized = { ...profileConfig } as Record<string, unknown>;
    delete sanitized.id;
    delete sanitized.default;
    delete sanitized.created_at;
    return sanitized;
  }

  private normalizeDomainList(value: unknown): string[] | null {
    const entries =
      value instanceof Set
        ? Array.from(value)
        : Array.isArray(value)
          ? value
          : null;
    if (!entries) {
      return null;
    }
    const normalized = entries
      .map((entry) => String(entry).trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }

  private buildDirectSessionProfile(
    profileConfig: Record<string, unknown>
  ): BrowserProfile {
    const merged = {
      downloads_path: '~/Downloads/browser-use-mcp',
      wait_between_actions: 0.1,
      keep_alive: true,
      user_data_dir: '~/.config/browseruse/profiles/default',
      is_mobile: false,
      device_scale_factor: 1.0,
      disable_security: false,
      headless: false,
      ...this.sanitizeProfileConfig(profileConfig),
    } as Record<string, unknown>;

    if (typeof merged.user_data_dir === 'string') {
      merged.user_data_dir = this.resolvePath(merged.user_data_dir);
    }
    if (typeof merged.downloads_path === 'string') {
      merged.downloads_path = this.resolvePath(merged.downloads_path);
    }
    if (Array.isArray(merged.allowed_domains)) {
      merged.allowed_domains = merged.allowed_domains
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }
    if (Array.isArray(merged.prohibited_domains)) {
      merged.prohibited_domains = merged.prohibited_domains
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }

    return new BrowserProfile(merged as any);
  }

  private buildRetryProfile(
    profileConfig: Record<string, unknown>,
    allowedDomains: string[] | undefined
  ): BrowserProfile {
    const merged = {
      ...this.sanitizeProfileConfig(profileConfig),
    } as Record<string, unknown>;

    const configuredAllowedDomains = this.normalizeDomainList(
      merged.allowed_domains
    );
    if (configuredAllowedDomains) {
      merged.allowed_domains = configuredAllowedDomains;
    } else if (allowedDomains !== undefined) {
      merged.allowed_domains = allowedDomains;
    }

    if (merged.keep_alive == null) {
      merged.keep_alive = false;
    }

    if (typeof merged.user_data_dir === 'string') {
      merged.user_data_dir = this.resolvePath(merged.user_data_dir);
    }
    if (typeof merged.downloads_path === 'string') {
      merged.downloads_path = this.resolvePath(merged.downloads_path);
    }
    if (Array.isArray(merged.allowed_domains)) {
      merged.allowed_domains = merged.allowed_domains
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }
    if (Array.isArray(merged.prohibited_domains)) {
      merged.prohibited_domains = merged.prohibited_domains
        .map((entry) => String(entry).trim())
        .filter(Boolean);
    }

    return new BrowserProfile(merged as any);
  }

  private initializeLlmForDirectTools() {
    if (this.llm) {
      return;
    }
    const llmConfig = this.getDefaultLlmConfig();
    const model =
      typeof llmConfig.model === 'string' && llmConfig.model.trim()
        ? llmConfig.model.trim()
        : 'gpt-4o-mini';

    try {
      this.llm = this.createLlmFromModelName(model, llmConfig);
    } catch (error) {
      logger.debug(
        `Skipping MCP direct-tools LLM initialization for model "${model}": ${redactMcpLogMessage(error)}`
      );
    }
  }

  private initializeFileSystem(profileConfig: Record<string, unknown>) {
    if (this.fileSystem) {
      return;
    }
    const configuredPath =
      typeof profileConfig.file_system_path === 'string'
        ? profileConfig.file_system_path
        : '~/.browser-use-mcp';
    this.fileSystem = new FileSystem(this.resolvePath(configuredPath));
  }

  private formatRetryResult(history: any): string {
    const results: string[] = [];
    const steps =
      Array.isArray(history?.history) ||
      typeof history?.number_of_steps === 'function'
        ? typeof history?.number_of_steps === 'function'
          ? history.number_of_steps()
          : history.history.length
        : 0;
    results.push(`Task completed in ${steps} steps`);
    results.push(`Success: ${String(history?.is_successful?.())}`);

    const finalResult = history?.final_result?.();
    if (finalResult) {
      results.push(`\nFinal result:\n${finalResult}`);
    }

    const errors = Array.isArray(history?.errors?.())
      ? history.errors().filter((entry: unknown) => entry != null)
      : [];
    if (errors.length > 0) {
      results.push(`\nErrors encountered:\n${JSON.stringify(errors, null, 2)}`);
    }

    const urls = Array.isArray(history?.urls?.())
      ? history
          .urls()
          .filter((entry: unknown) => entry != null)
          .map((entry: unknown) => String(entry))
      : [];
    if (urls.length > 0) {
      results.push(`\nURLs visited: ${urls.join(', ')}`);
    }

    return results.join('\n');
  }

  private trackSession(session: BrowserSession): void {
    const now = Date.now() / 1000;
    const existing = this.activeSessions.get(session.id);
    if (existing) {
      existing.session = session;
      existing.last_activity = now;
      return;
    }
    this.activeSessions.set(session.id, {
      session,
      created_at: now,
      last_activity: now,
    });
  }

  private updateSessionActivity(session: BrowserSession | null): void {
    if (!session) {
      return;
    }
    const tracked = this.activeSessions.get(session.id);
    if (!tracked) {
      this.trackSession(session);
      return;
    }
    tracked.last_activity = Date.now() / 1000;
  }

  private serializeTrackedSessions() {
    const now = Date.now() / 1000;
    return Array.from(this.activeSessions.entries()).map(
      ([session_id, tracked]) => ({
        session_id,
        created_at: tracked.created_at,
        last_activity: tracked.last_activity,
        age_minutes: (now - tracked.created_at) / 60,
        active: Boolean(tracked.session?.initialized),
        current_session: this.browserSession?.id === session_id,
      })
    );
  }

  private async shutdownSession(session: BrowserSession): Promise<void> {
    const withKill = session as BrowserSession & { kill?: () => Promise<void> };
    if (typeof withKill.kill === 'function') {
      await withKill.kill();
      return;
    }
    if (typeof session.stop === 'function') {
      await session.stop();
    }
  }

  private async closeSessionById(
    sessionId: string
  ): Promise<{ session_id: string; closed: boolean; message: string }> {
    const tracked = this.activeSessions.get(sessionId);
    if (!tracked) {
      return {
        session_id: sessionId,
        closed: false,
        message: `Session ${sessionId} not found`,
      };
    }

    try {
      await this.shutdownSession(tracked.session);
      this.activeSessions.delete(sessionId);
      if (this.browserSession?.id === sessionId) {
        this.browserSession = null;
      }
      return {
        session_id: sessionId,
        closed: true,
        message: `Closed session ${sessionId}`,
      };
    } catch (error) {
      return {
        session_id: sessionId,
        closed: false,
        message: `Failed to close session ${sessionId}: ${redactMcpLogMessage(error)}`,
      };
    }
  }

  private async closeAllTrackedSessions(): Promise<{
    closed_count: number;
    total_count: number;
    results: Array<{ session_id: string; closed: boolean; message: string }>;
  }> {
    const sessionIds = Array.from(this.activeSessions.keys());
    const results = await Promise.all(
      sessionIds.map((sessionId) => this.closeSessionById(sessionId))
    );
    const closedCount = results.filter((result) => result.closed).length;
    return {
      closed_count: closedCount,
      total_count: sessionIds.length,
      results,
    };
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now() / 1000;
    const timeoutSeconds = this.sessionTimeoutMinutes * 60;
    const expiredSessionIds: string[] = [];

    for (const [sessionId, tracked] of this.activeSessions.entries()) {
      if (now - tracked.last_activity > timeoutSeconds) {
        expiredSessionIds.push(sessionId);
      }
    }

    for (const sessionId of expiredSessionIds) {
      const result = await this.closeSessionById(sessionId);
      if (!result.closed) {
        logger.warning(result.message);
      }
    }
  }

  private startSessionCleanupLoop(): void {
    if (this.sessionCleanupInterval) {
      return;
    }

    this.sessionCleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        logger.warning(
          `MCP session cleanup failed: ${redactMcpLogMessage(error)}`
        );
      });
    }, 120_000);

    // Do not keep the Node process alive solely because of the cleanup loop.
    this.sessionCleanupInterval.unref?.();
  }

  private stopSessionCleanupLoop(): void {
    if (!this.sessionCleanupInterval) {
      return;
    }
    clearInterval(this.sessionCleanupInterval);
    this.sessionCleanupInterval = null;
  }

  private formatToolResult(
    toolName: string,
    result: unknown
  ): { content: MCPToolContent[] } {
    if (
      toolName === 'browser_get_state' &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result)
    ) {
      const payload = {
        ...(result as Record<string, unknown>),
      } as Record<string, unknown>;
      const screenshot =
        typeof payload.screenshot === 'string' && payload.screenshot.trim()
          ? payload.screenshot
          : null;
      delete payload.screenshot;

      const pageInfo =
        payload.page_info &&
        typeof payload.page_info === 'object' &&
        !Array.isArray(payload.page_info)
          ? (payload.page_info as Record<string, unknown>)
          : null;
      const viewportWidth =
        typeof pageInfo?.viewport_width === 'number'
          ? pageInfo.viewport_width
          : null;
      const viewportHeight =
        typeof pageInfo?.viewport_height === 'number'
          ? pageInfo.viewport_height
          : null;
      if (
        screenshot &&
        viewportWidth !== null &&
        viewportHeight !== null &&
        payload.screenshot_dimensions == null
      ) {
        payload.screenshot_dimensions = {
          width: viewportWidth,
          height: viewportHeight,
        };
      }

      const content: MCPToolContent[] = [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ];
      if (screenshot) {
        content.push({
          type: 'image',
          data: screenshot,
          mimeType: 'image/png',
        });
      }
      return { content };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: Object.entries(this.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      };
    });

    // Execute tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const startTime = Date.now() / 1000;
      let errorMsg: string | null = null;

      try {
        const tool = this.tools[request.params.name];
        if (!tool) {
          throw new Error(`Tool not found: ${request.params.name}`);
        }

        logger.debug(`Executing tool: ${request.params.name}`);
        this.toolExecutionCount++;
        const result = await tool.handler(request.params.arguments || {});

        return this.formatToolResult(request.params.name, result);
      } catch (error) {
        this.errorCount++;
        errorMsg = redactMcpLogMessage(error);
        logger.error(`Tool execution failed: ${errorMsg}`);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      } finally {
        // Capture telemetry for tool calls
        const duration = Date.now() / 1000 - startTime;
        productTelemetry.capture(
          new MCPServerTelemetryEvent({
            version: get_browser_use_version(),
            action: 'tool_call',
            tool_name: request.params.name,
            duration_seconds: duration,
            error_message: errorMsg,
          })
        );
      }
    });

    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: Array.from(this.prompts.values()).map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          arguments: prompt.arguments,
        })),
      };
    });

    // Get prompt with arguments
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = this.prompts.get(request.params.name);
      if (!prompt) {
        throw new Error(`Prompt not found: ${request.params.name}`);
      }

      const args = request.params.arguments || {};
      const message = prompt.template(args);

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: message,
            },
          },
        ],
      };
    });
  }

  private async ensureController(): Promise<Controller<any>> {
    if (!this.controller) {
      this.controller = new DefaultController();
      this.registerControllerActions(this.controller);
    }
    return this.controller;
  }

  private async ensureBrowserSession(): Promise<BrowserSession> {
    if (!this.browserSession) {
      const profileConfig = this.getDefaultProfileConfig();
      const profile = this.buildDirectSessionProfile(profileConfig);
      this.browserSession = new BrowserSession({ browser_profile: profile });
      this.trackSession(this.browserSession);
      this.initializeLlmForDirectTools();
      this.initializeFileSystem(profileConfig);
    }

    if (!this.browserSession.initialized) {
      await this.browserSession.start();
    }
    this.trackSession(this.browserSession);
    this.updateSessionActivity(this.browserSession);

    return this.browserSession;
  }

  private async executeControllerAction(
    actionName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const controller = await this.ensureController();
    const browserSession = await this.ensureBrowserSession();
    this.updateSessionActivity(browserSession);
    if (actionName === 'extract_structured_data' && !this.llm) {
      throw new Error(
        'LLM not initialized. Set provider API key env vars and configure BROWSER_USE_LLM_MODEL/DEFAULT_LLM to a supported model.'
      );
    }

    return await controller.registry.execute_action(actionName, args, {
      browser_session: browserSession,
      page_extraction_llm: this.llm,
      file_system: this.fileSystem,
      available_file_paths: Array.isArray(browserSession.downloaded_files)
        ? [...browserSession.downloaded_files]
        : null,
      context: undefined,
    });
  }

  private registerCoreBrowserTools() {
    this.registerTool(
      'browser_navigate',
      'Navigate to a URL in the browser',
      z.object({
        url: z.string(),
        new_tab: z.boolean().default(false),
      }),
      async (args) =>
        this.executeControllerAction('go_to_url', {
          url: String(args?.url ?? ''),
          new_tab: Boolean(args?.new_tab),
        })
    );

    this.registerTool(
      'browser_click',
      'Click an element on the page by index from browser_get_state',
      z.object({
        index: z.number().int(),
        new_tab: z.boolean().optional().default(false),
      }),
      async (args) => {
        const browserSession = await this.ensureBrowserSession();
        const index = Number(args?.index);
        const openInNewTab = Boolean(args?.new_tab);

        if (!openInNewTab) {
          return this.executeControllerAction('click_element_by_index', {
            index,
          });
        }

        const element = await browserSession.get_dom_element_by_index(index);
        if (!element) {
          throw new Error(`Element with index ${index} not found`);
        }

        const href = (element as any)?.attributes?.href;
        if (typeof href === 'string' && href.trim()) {
          const currentPage = await browserSession.get_current_page();
          const currentUrl =
            typeof currentPage?.url === 'function' ? currentPage.url() : '';
          let targetUrl = href.trim();

          try {
            if (currentUrl) {
              targetUrl = new URL(targetUrl, currentUrl).toString();
            }
          } catch {
            // Keep the original href if URL resolution fails.
          }

          await browserSession.create_new_tab(targetUrl);
          const tabIndex =
            typeof (browserSession as any).active_tab_index === 'number'
              ? (browserSession as any).active_tab_index
              : null;
          if (tabIndex !== null) {
            return `Clicked element ${index} and opened in new tab #${tabIndex}: ${targetUrl}`;
          }
          return `Clicked element ${index} and opened new tab: ${targetUrl}`;
        }

        const locator =
          typeof (browserSession as any).get_locate_element === 'function'
            ? await (browserSession as any).get_locate_element(element)
            : null;
        if (locator && typeof locator.click === 'function') {
          const modifier: 'Meta' | 'Control' =
            process.platform === 'darwin' ? 'Meta' : 'Control';
          const pageBeforeClick = await browserSession.get_current_page();
          try {
            await locator.click({ modifiers: [modifier] });
            await new Promise((resolve) => setTimeout(resolve, 500));
          } finally {
            const pageAfterClick =
              (await browserSession.get_current_page()) ?? pageBeforeClick;
            await browserSession.validate_page_after_action(pageAfterClick);
          }
          return `Clicked element ${index} with ${modifier} key (new tab if supported)`;
        }

        // Fallback: if no href exists, perform a normal click.
        return this.executeControllerAction('click_element_by_index', {
          index,
        });
      }
    );

    this.registerTool(
      'browser_type',
      'Type text into an input field by index from browser_get_state',
      z.object({
        index: z.number().int(),
        text: z.string(),
      }),
      async (args) =>
        this.executeControllerAction('input_text', {
          index: Number(args?.index),
          text: String(args?.text ?? ''),
        })
    );

    this.registerTool(
      'browser_get_state',
      'Get the current state of the page including interactive elements',
      z
        .object({
          include_screenshot: z.boolean().default(false),
          include_recent_events: z.boolean().default(false),
        })
        .default({ include_screenshot: false, include_recent_events: false }),
      async (args) => {
        const browserSession = await this.ensureBrowserSession();
        let state: any = null;
        if (
          typeof (browserSession as any).dispatch_browser_event === 'function'
        ) {
          const dispatchResult = await (
            browserSession as any
          ).dispatch_browser_event(
            new BrowserStateRequestEvent({
              include_dom: true,
              include_screenshot: Boolean(args?.include_screenshot),
              include_recent_events: Boolean(args?.include_recent_events),
            })
          );
          state = dispatchResult?.event?.event_result ?? null;
        }

        if (!state) {
          state = await browserSession.get_browser_state_with_recovery({
            include_screenshot: Boolean(args?.include_screenshot),
            include_recent_events: Boolean(args?.include_recent_events),
            cache_clickable_elements_hashes: true,
          });
        }

        return {
          url: state.url,
          title: state.title,
          tabs: state.tabs,
          page_info: state.page_info,
          pixels_above: state.pixels_above,
          pixels_below: state.pixels_below,
          browser_errors: state.browser_errors,
          loading_status: state.loading_status,
          recent_events: state.recent_events,
          pending_network_requests: state.pending_network_requests,
          pagination_buttons: state.pagination_buttons,
          closed_popup_messages: state.closed_popup_messages,
          screenshot: state.screenshot,
          interactive_elements:
            state.element_tree.clickable_elements_to_string(),
          interactive_count: Object.keys(state.selector_map ?? {}).length,
        };
      },
      { readOnly: true }
    );

    this.registerTool(
      'browser_extract_content',
      'Extract structured content from the current page',
      z.object({
        query: z.string(),
        extract_links: z.boolean().default(false),
      }),
      async (args) =>
        this.executeControllerAction('extract_structured_data', {
          query: String(args?.query ?? ''),
          extract_links: Boolean(args?.extract_links),
        })
    );

    this.registerTool(
      'browser_scroll',
      'Scroll the page up or down',
      z
        .object({
          direction: z.enum(['up', 'down']).default('down'),
        })
        .default({ direction: 'down' }),
      async (args) =>
        this.executeControllerAction('scroll', {
          down: (args?.direction ?? 'down') !== 'up',
          num_pages: 1,
        })
    );

    this.registerTool(
      'browser_go_back',
      'Go back to the previous page',
      z.object({}).strict(),
      async () => this.executeControllerAction('go_back', {})
    );

    this.registerTool(
      'browser_list_tabs',
      'List all open tabs',
      z.object({}).strict(),
      async () => {
        const browserSession = await this.ensureBrowserSession();
        return browserSession.get_tabs_info();
      },
      { readOnly: true }
    );

    this.registerTool(
      'browser_switch_tab',
      'Switch to a tab by tab_id (or page_id/tab_index for compatibility)',
      z
        .object({
          tab_id: z.string().trim().length(4).optional(),
          page_id: z.number().int().optional(),
          tab_index: z.number().int().optional(),
        })
        .refine(
          (value) =>
            value.tab_id != null ||
            value.page_id != null ||
            value.tab_index != null,
          { message: 'Provide tab_id, page_id, or tab_index' }
        ),
      async (args) => {
        const tabId =
          typeof args?.tab_id === 'string' && args.tab_id.trim()
            ? args.tab_id.trim()
            : null;
        if (tabId) {
          return this.executeControllerAction('switch_tab', { tab_id: tabId });
        }
        const pageId =
          typeof args?.page_id === 'number' && Number.isFinite(args.page_id)
            ? Number(args.page_id)
            : Number(args?.tab_index);
        return this.executeControllerAction('switch_tab', {
          page_id: pageId,
        });
      }
    );

    this.registerTool(
      'browser_close_tab',
      'Close a tab by tab_id (or page_id/tab_index for compatibility)',
      z
        .object({
          tab_id: z.string().trim().length(4).optional(),
          page_id: z.number().int().optional(),
          tab_index: z.number().int().optional(),
        })
        .refine(
          (value) =>
            value.tab_id != null ||
            value.page_id != null ||
            value.tab_index != null,
          { message: 'Provide tab_id, page_id, or tab_index' }
        ),
      async (args) => {
        const tabId =
          typeof args?.tab_id === 'string' && args.tab_id.trim()
            ? args.tab_id.trim()
            : null;
        if (tabId) {
          return this.executeControllerAction('close_tab', { tab_id: tabId });
        }
        const pageId =
          typeof args?.page_id === 'number' && Number.isFinite(args.page_id)
            ? Number(args.page_id)
            : Number(args?.tab_index);
        return this.executeControllerAction('close_tab', {
          page_id: pageId,
        });
      }
    );

    this.registerTool(
      'browser_list_sessions',
      'List active browser sessions managed by this MCP server',
      z.object({}).strict(),
      async () => {
        return this.serializeTrackedSessions();
      },
      { readOnly: true }
    );

    this.registerTool(
      'browser_close_session',
      'Close a specific browser session by session_id',
      z.object({
        session_id: z.string().trim().min(1),
      }),
      async (args) => this.closeSessionById(String(args?.session_id ?? ''))
    );

    this.registerTool(
      'browser_close_all',
      'Close all active browser sessions managed by this MCP server',
      z.object({}).strict(),
      async () => this.closeAllTrackedSessions()
    );

    this.registerTool(
      'retry_with_browser_use_agent',
      'Retry a complex task with the browser-use autonomous agent',
      z.object({
        task: z.string(),
        max_steps: z.number().int().optional().default(100),
        model: z.string().optional(),
        allowed_domains: z.array(z.string()).optional(),
        use_vision: z.boolean().optional().default(true),
      }),
      async (args) => {
        const task = String(args?.task ?? '').trim();
        if (!task) {
          throw new Error('task is required');
        }

        const requestedModel =
          typeof args?.model === 'string' ? args.model.trim() : '';
        const maxSteps = Number(args?.max_steps ?? 100);
        const useVision = Boolean(args?.use_vision ?? true);
        const allowedDomainValues = Array.isArray(args?.allowed_domains)
          ? args.allowed_domains
              .map((entry: unknown) => String(entry).trim())
              .filter(Boolean)
          : [];
        const allowedDomains =
          allowedDomainValues.length > 0 ? allowedDomainValues : undefined;

        const llmConfig = this.getDefaultLlmConfig();
        const configuredModel =
          typeof llmConfig.model === 'string' && llmConfig.model.trim()
            ? llmConfig.model.trim()
            : 'gpt-4o';
        const llmModel = requestedModel || configuredModel;
        let llm: BaseChatModel;
        try {
          llm = this.createLlmFromModelName(llmModel, llmConfig);
        } catch (error) {
          return `Error: Failed to initialize LLM "${llmModel}": ${redactMcpLogMessage(error)}`;
        }

        const profileConfig = this.getDefaultProfileConfig();
        const profile = this.buildRetryProfile(profileConfig, allowedDomains);
        const retryBrowserSession = new BrowserSession({
          browser_profile: profile,
        });
        const agent = new Agent({
          task,
          llm,
          browser_session: retryBrowserSession,
          use_vision: useVision,
        });

        try {
          const history = await agent.run(maxSteps);
          return this.formatRetryResult(history);
        } catch (error) {
          return `Agent task failed: ${redactMcpLogMessage(error)}`;
        } finally {
          await agent.close();
        }
      }
    );
  }

  /**
   * Register default prompts for common browser automation tasks
   */
  private registerDefaultPrompts() {
    // Scrape data prompt
    this.registerPrompt({
      name: 'scrape_data',
      description: 'Extract structured data from a website',
      arguments: [
        { name: 'url', description: 'URL to scrape', required: true },
        {
          name: 'data_type',
          description: 'Type of data to extract',
          required: true,
        },
      ],
      template: (args) =>
        `Use browser_navigate to go to ${args.url}, then use browser_extract_content to extract ${args.data_type}. If the page requires interaction, use browser_get_state to find elements and browser_click/browser_type as needed.`,
    });

    // Fill form prompt
    this.registerPrompt({
      name: 'fill_form',
      description: 'Fill out and submit a web form',
      arguments: [
        { name: 'url', description: 'URL of the form', required: true },
        {
          name: 'field_data',
          description: 'JSON object with field values',
          required: true,
        },
      ],
      template: (args) =>
        `Navigate to ${args.url}, use browser_get_state to identify form fields, then use browser_type to fill in: ${args.field_data}. Finally, click the submit button.`,
    });

    // Multi-step task prompt
    this.registerPrompt({
      name: 'multi_step_task',
      description: 'Execute a complex multi-step task',
      arguments: [
        {
          name: 'task_description',
          description: 'Detailed description of the task',
          required: true,
        },
        {
          name: 'max_steps',
          description: 'Maximum number of steps (default: 100)',
          required: false,
        },
      ],
      template: (args) =>
        `Use retry_with_browser_use_agent with task: '${args.task_description}'. Set max_steps=${args.max_steps || '100'} and use_vision=true for better understanding.`,
    });

    // Research topic prompt
    this.registerPrompt({
      name: 'research_topic',
      description: 'Research a topic across multiple websites',
      arguments: [
        { name: 'topic', description: 'Topic to research', required: true },
        {
          name: 'sites',
          description: 'Comma-separated list of websites',
          required: true,
        },
      ],
      template: (args) =>
        `Open multiple tabs using browser_navigate with new_tab=true for sites: ${args.sites}. Use browser_extract_content on each to gather information about ${args.topic}. Switch between tabs with browser_switch_tab.`,
    });
  }

  /**
   * Register a tool with the MCP server
   */
  public registerTool(
    name: string,
    description: string,
    inputSchema: z.ZodType | Record<string, any>,
    handler: (args: any) => Promise<any>,
    options: { readOnly?: boolean } = {}
  ) {
    this.tools[name] = {
      description,
      inputSchema:
        inputSchema instanceof z.ZodType
          ? zodSchemaToJsonSchema(inputSchema as any)
          : inputSchema,
      handler,
      ...(options.readOnly
        ? { annotations: { readOnlyHint: true } as ToolAnnotations }
        : {}),
    };
    logger.debug(`Registered tool: ${name}`);
  }

  /**
   * Register all Controller actions as MCP tools
   */
  public async registerControllerActions(
    controller: Controller<any>
  ): Promise<void> {
    this.controller = controller;

    // Get all registered actions from the controller
    const actions = controller.registry.get_all_actions();

    for (const [actionName, actionInfo] of actions.entries()) {
      // Aliases hidden from models are not exposed as duplicate MCP tools.
      if ((actionInfo as { hidden_from_model?: boolean }).hidden_from_model) {
        continue;
      }
      // Create a wrapper for the action
      const handler = async (args: any) => {
        return this.executeControllerAction(actionName, args || {});
      };

      // Register the action as a tool
      this.registerTool(
        actionName,
        actionInfo.description || `Execute ${actionName} action`,
        actionInfo.paramSchema ?? z.object({}).strict(),
        handler
      );
    }

    logger.info(
      `✅ Registered ${actions.size} controller actions as MCP tools`
    );
  }

  /**
   * Initialize the browser session
   */
  public async initBrowserSession(
    browserSession: BrowserSession
  ): Promise<void> {
    this.browserSession = browserSession;
    this.trackSession(browserSession);
    await this.browserSession.start();
    this.trackSession(this.browserSession);
    this.updateSessionActivity(this.browserSession);
    logger.info('Browser session initialized');
  }

  /**
   * Start the MCP server
   */
  public async start() {
    if (this.isRunning) {
      logger.warning('MCP Server is already running');
      return;
    }
    this.restoreConsoleRedirect ??= redirectConsoleToStderr();

    // Capture telemetry for server start
    productTelemetry.capture(
      new MCPServerTelemetryEvent({
        version: get_browser_use_version(),
        action: 'start',
      })
    );

    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.isRunning = true;
      this.startSessionCleanupLoop();
      logger.info(
        `🔌 MCP Server started (${this.getToolCount()} tools, ${this.getPromptCount()} prompts registered)`
      );
    } catch (error) {
      this.isRunning = false;
      this.restoreConsoleRedirect?.();
      this.restoreConsoleRedirect = null;
      logger.error(`Failed to start MCP server: ${redactMcpLogMessage(error)}`);
      throw error;
    }
  }

  /**
   * Stop the MCP server and cleanup resources
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warning('MCP Server is not running');
      this.restoreConsoleRedirect?.();
      this.restoreConsoleRedirect = null;
      return;
    }

    try {
      this.isRunning = false;
      this.stopSessionCleanupLoop();

      // Cancel any pending operations
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      // Close browser session if active
      if (this.activeSessions.size > 0) {
        await this.closeAllTrackedSessions();
        this.browserSession = null;
        logger.info('Browser session closed');
      }

      // Capture telemetry for server stop
      const duration = Date.now() / 1000 - this.startTime;
      productTelemetry.capture(
        new MCPServerTelemetryEvent({
          version: get_browser_use_version(),
          action: 'stop',
          duration_seconds: duration,
        })
      );
      productTelemetry.flush();

      const stats = this.getStats();
      logger.info(
        `🔌 MCP Server stopped (uptime: ${Math.floor(stats.uptime)}s, executions: ${stats.executionCount}, success rate: ${(stats.successRate * 100).toFixed(1)}%)`
      );
    } catch (error) {
      logger.error(`Error stopping MCP server: ${redactMcpLogMessage(error)}`);
    } finally {
      this.restoreConsoleRedirect?.();
      this.restoreConsoleRedirect = null;
    }
  }

  /**
   * Register a prompt template
   */
  public registerPrompt(prompt: MCPPromptTemplate): void {
    this.prompts.set(prompt.name, prompt);
    logger.debug(`Registered prompt: ${prompt.name}`);
  }

  /**
   * Get the number of registered tools
   */
  public getToolCount(): number {
    return Object.keys(this.tools).length;
  }

  /**
   * Get the number of registered prompts
   */
  public getPromptCount(): number {
    return this.prompts.size;
  }

  /**
   * Get server health status
   */
  public getHealth(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    toolExecutionCount: number;
    errorCount: number;
    errorRate: number;
    browserSessionActive: boolean;
  } {
    const uptime = Date.now() / 1000 - this.startTime;
    const errorRate =
      this.toolExecutionCount > 0
        ? this.errorCount / this.toolExecutionCount
        : 0;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (errorRate > 0.5) {
      status = 'unhealthy';
    } else if (errorRate > 0.2) {
      status = 'degraded';
    }

    return {
      status,
      uptime,
      toolExecutionCount: this.toolExecutionCount,
      errorCount: this.errorCount,
      errorRate,
      browserSessionActive: this.browserSession !== null,
    };
  }

  /**
   * Get server statistics
   */
  public getStats(): {
    toolsRegistered: number;
    promptsRegistered: number;
    uptime: number;
    executionCount: number;
    errorCount: number;
    successRate: number;
  } {
    const health = this.getHealth();
    return {
      toolsRegistered: this.getToolCount(),
      promptsRegistered: this.getPromptCount(),
      uptime: health.uptime,
      executionCount: this.toolExecutionCount,
      errorCount: this.errorCount,
      successRate: health.toolExecutionCount > 0 ? 1 - health.errorRate : 1,
    };
  }

  /**
   * Reset statistics
   */
  public resetStats(): void {
    this.toolExecutionCount = 0;
    this.errorCount = 0;
    logger.info('Statistics reset');
  }

  /**
   * Check if server is running
   */
  public isServerRunning(): boolean {
    return this.isRunning;
  }
}
