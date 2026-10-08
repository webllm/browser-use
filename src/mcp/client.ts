/**
 * MCP (Model Context Protocol) client integration for browser-use.
 *
 * This module provides integration between external MCP servers and browser-use's action registry.
 * MCP tools are dynamically discovered and registered as browser-use actions.
 *
 * Example usage:
 *     import { Tools } from './tools/service.js';
 *     import { MCPClient } from './mcp/client.js';
 *
 *     const tools = new Tools();
 *
 *     // Connect to an MCP server
 *     const mcpClient = new MCPClient(
 *         'my-server',
 *         'npx',
 *         ['@mycompany/mcp-server@latest']
 *     );
 *
 *     // Register all MCP tools as browser-use actions
 *     await mcpClient.registerToTools(tools);
 *
 *     // Now use with Agent as normal - MCP tools are available as actions
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createLogger } from '../logging-config.js';
import type { Controller } from '../controller/service.js';
import type { Registry } from '../tools/registry/service.js';
import type { Tools } from '../tools/service.js';
import { ActionResult } from '../agent/views.js';
import { get_browser_use_version, retryAsync } from '../utils.js';
import {
  formatMcpCommandForLog,
  formatMcpToolArgsForLog,
  redactMcpLogMessage,
} from './redaction.js';

const logger = createLogger('browser_use.mcp.client');
export {
  formatMcpCommandForLog,
  formatMcpToolArgsForLog,
  redactMcpLogMessage,
} from './redaction.js';

export interface MCPClientOptions {
  /** Maximum number of connection retry attempts (default: 3) */
  maxRetries?: number;
  /** Connection timeout in seconds (default: 30) */
  connectionTimeout?: number;
  /** Tool call timeout in seconds (default: 60) */
  toolCallTimeout?: number;
  /** Enable auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;
  /** Health check interval in seconds (default: 30, 0 = disabled) */
  healthCheckInterval?: number;
}

export class MCPClient {
  private client: Client;
  private command: string;
  private args: string[];
  private env?: Record<string, string>;
  private serverName: string;
  private _tools: Map<string, Tool> = new Map();
  private _prompts: Map<string, Prompt> = new Map();
  private _registeredActions: Set<string> = new Set();
  private _connected = false;
  private _connecting = false;
  private _toolCallCount = 0;
  private _errorCount = 0;
  private _lastConnectTime?: number;
  private _lastHealthCheck?: number;
  private _healthCheckInterval?: NodeJS.Timeout;

  // Options
  private maxRetries: number;
  private connectionTimeout: number;
  private toolCallTimeout: number;
  private autoReconnect: boolean;
  private healthCheckIntervalSeconds: number;

  constructor(
    serverName: string,
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
    options: MCPClientOptions = {}
  ) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = env;

    // Set options with defaults
    this.maxRetries = options.maxRetries ?? 3;
    this.connectionTimeout = options.connectionTimeout ?? 30;
    this.toolCallTimeout = options.toolCallTimeout ?? 60;
    this.autoReconnect = options.autoReconnect ?? true;
    this.healthCheckIntervalSeconds = options.healthCheckInterval ?? 30;

    this.client = new Client(
      {
        name: 'browser-use',
        version: get_browser_use_version(),
      },
      {
        capabilities: {},
      }
    );
  }

  /**
   * Connect to the MCP server and discover available tools
   */
  async connect(timeout?: number): Promise<void> {
    if (this._connected) {
      logger.debug(`Already connected to ${this.serverName}`);
      return;
    }

    if (this._connecting) {
      logger.debug(`Connection already in progress for ${this.serverName}`);
      return;
    }

    this._connecting = true;
    const actualTimeout = timeout ?? this.connectionTimeout;

    try {
      logger.info(
        `🔌 Connecting to MCP server '${this.serverName}': ${formatMcpCommandForLog(this.command, this.args)}`
      );

      // Use retry logic for connection
      await retryAsync(
        async () => {
          // Create transport with environment variables
          const transport = new StdioClientTransport({
            command: this.command,
            args: this.args,
            env: this.env,
          });

          // Connect with timeout
          await this._connectWithTimeout(transport, actualTimeout);
        },
        {
          maxAttempts: this.maxRetries,
          delayMs: 1000,
          backoffMultiplier: 2,
          onRetry: (error, attempt, delay) => {
            logger.warning(
              `Connection attempt ${attempt} failed for '${this.serverName}': ${redactMcpLogMessage(error)}. Retrying in ${delay}ms...`
            );
          },
        }
      );

      this._connected = true;
      this._lastConnectTime = Date.now() / 1000;

      // Discover available tools
      const result = await this.client.request(
        ListToolsRequestSchema as any,
        {} as any
      );
      this._tools = new Map(
        (result as any).tools.map((tool: any) => [tool.name, tool])
      );

      // Try to discover prompts (optional)
      try {
        await this.listPrompts();
      } catch {
        // Prompts are optional, ignore failures
      }

      logger.info(
        `📦 Discovered ${this._tools.size} tools${this._prompts.size > 0 ? ` and ${this._prompts.size} prompts` : ''} from '${this.serverName}'`
      );

      // Start health checks
      this._startHealthCheck();
    } catch (error) {
      this._connected = false;
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  private async _connectWithTimeout(
    transport: StdioClientTransport,
    timeoutSeconds: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `Failed to connect to MCP server '${this.serverName}' after ${timeoutSeconds} seconds`
          )
        );
      }, timeoutSeconds * 1000);

      this.client
        .connect(transport)
        .then(() => {
          clearTimeout(timeoutHandle);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this._connected) {
      return;
    }

    try {
      logger.info(`🔌 Disconnecting from MCP server '${this.serverName}'`);

      // Stop health checks
      this._stopHealthCheck();

      await this.client.close();
      this._connected = false;
      this._tools.clear();
      this._prompts.clear();
      this._registeredActions.clear();

      const stats = this.getStats();
      logger.info(
        `Disconnected from '${this.serverName}' (${stats.toolCallCount} tool calls, ${(stats.successRate * 100).toFixed(1)}% success rate)`
      );
    } catch (error) {
      logger.error(
        `Error disconnecting from MCP server: ${redactMcpLogMessage(error)}`
      );
    }
  }

  /**
   * List all available tools from the MCP server
   */
  async listTools(): Promise<Tool[]> {
    if (!this._connected) {
      await this.connect();
    }
    return Array.from(this._tools.values());
  }

  /**
   * Call a tool on the MCP server and return its content blocks.
   */
  async callTool(name: string, args: any): Promise<any> {
    const result = await this.callToolResult(name, args);
    return result?.content;
  }

  /**
   * Call a tool on the MCP server and return the full CallToolResult,
   * including the isError flag that tool-level failures set.
   */
  async callToolResult(name: string, args: any): Promise<any> {
    if (!this._connected) {
      throw new Error(`MCP server '${this.serverName}' not connected`);
    }

    try {
      logger.debug(
        `🔧 Calling MCP tool '${name}' with params: ${formatMcpToolArgsForLog(args)}`
      );

      this._toolCallCount++;

      const result = await this.client.request(
        CallToolRequestSchema as any,
        {
          name,
          arguments: args,
        } as any
      );

      return result;
    } catch (error) {
      this._errorCount++;
      logger.error(`MCP tool '${name}' failed: ${redactMcpLogMessage(error)}`);
      throw error;
    }
  }

  /**
   * Register MCP tools as actions in browser-use tools.
   *
   * @param tools - Browser-use tools to register actions to
   * @param toolFilter - Optional list of tool names to register (undefined = all tools)
   * @param prefix - Optional prefix to add to action names (e.g., "playwright_")
   */
  async registerToTools(
    tools: Pick<Tools, 'registry'>,
    toolFilter?: string[],
    prefix?: string
  ): Promise<void> {
    if (!this._connected) {
      await this.connect();
    }

    const registry = tools.registry;

    for (const [toolName, tool] of this._tools.entries()) {
      // Skip if not in filter
      if (toolFilter && !toolFilter.includes(toolName)) {
        continue;
      }

      // Apply prefix if specified
      const actionName = prefix ? `${prefix}${toolName}` : toolName;

      // Skip if already registered
      if (this._registeredActions.has(actionName)) {
        continue;
      }

      // Register the tool as an action
      this._registerToolAsAction(registry, actionName, tool);
      this._registeredActions.add(actionName);
    }

    logger.info(
      `✅ Registered ${this._registeredActions.size} MCP tools from '${this.serverName}' as browser-use actions`
    );
  }

  /**
   * @deprecated Use `registerToTools` instead.
   */
  async registerToController(
    controller: Controller<any>,
    toolFilter?: string[],
    prefix?: string
  ): Promise<void> {
    await this.registerToTools(
      controller as unknown as Pick<Tools, 'registry'>,
      toolFilter,
      prefix
    );
  }

  private _registerToolAsAction(
    registry: Registry,
    actionName: string,
    tool: Tool
  ): void {
    /**
     * Register a single MCP tool as a browser-use action
     */

    // Create async wrapper function for the MCP tool
    const mcpActionWrapper = async (params?: any): Promise<ActionResult> => {
      if (!this._connected) {
        return new ActionResult({
          error: `MCP server '${this.serverName}' not connected`,
          success: false,
        });
      }

      const startTime = Date.now() / 1000;

      try {
        // Call the MCP tool
        const result = await this.callToolResult(tool.name, params || {});

        // Convert MCP result to ActionResult
        const extractedContent = this._formatMcpResult(
          result?.content ?? result
        );

        // A tool-level failure arrives as a successful call with isError set.
        if (result?.isError === true) {
          return new ActionResult({
            error: `MCP tool '${tool.name}' reported an error: ${extractedContent}`,
            success: false,
          });
        }

        return new ActionResult({
          extracted_content: extractedContent,
          long_term_memory: `Used MCP tool '${tool.name}' from ${this.serverName}`,
        });
      } catch (error) {
        const errorMsg = redactMcpLogMessage(error);
        logger.error(`MCP tool '${tool.name}' failed: ${errorMsg}`);
        return new ActionResult({
          error: `MCP tool '${tool.name}' failed: ${errorMsg}`,
          success: false,
        });
      }
    };

    // Set function metadata for better debugging
    Object.defineProperty(mcpActionWrapper, 'name', { value: actionName });

    // Register the action with browser-use
    const description =
      tool.description || `MCP tool from ${this.serverName}: ${tool.name}`;
    const paramModel = this._convertToolSchemaToParamModel(tool.inputSchema);

    // Use the registry's action decorator
    registry.action(description, {
      param_model: paramModel,
    })(mcpActionWrapper);

    logger.debug(
      `✅ Registered MCP tool '${tool.name}' as action '${actionName}'`
    );
  }

  private _convertToolSchemaToParamModel(inputSchema: unknown) {
    if (!inputSchema || typeof inputSchema !== 'object') {
      return z.object({}).strict();
    }

    const schemaObject = inputSchema as Record<string, unknown>;
    if (Object.keys(schemaObject).length === 0) {
      return z.object({}).strict();
    }

    const converted = this._jsonSchemaToZod(schemaObject, 'input');
    if (converted instanceof z.ZodObject) {
      return converted.strict();
    }
    return z.any();
  }

  private _jsonSchemaToZod(
    schema: Record<string, unknown>,
    path: string
  ): z.ZodTypeAny {
    const typeValue = schema.type;
    const enumValues = Array.isArray(schema.enum) ? schema.enum : null;

    if ('const' in schema) {
      if (this._isLiteralPrimitive(schema.const)) {
        return this._applySchemaMetadata(z.literal(schema.const), schema);
      }
      return this._applySchemaMetadata(z.any(), schema);
    }

    if (enumValues && enumValues.length > 0) {
      const enumSchema = this._toLiteralUnion(enumValues);
      return this._applySchemaMetadata(enumSchema, schema);
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      const options = schema.oneOf.map((option, index) =>
        this._jsonSchemaToZod(
          this._toJsonSchemaObject(option),
          `${path}.oneOf[${index}]`
        )
      );
      const union = options.length === 1 ? options[0] : z.union(options as any);
      return this._applySchemaMetadata(union, schema);
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      const options = schema.anyOf.map((option, index) =>
        this._jsonSchemaToZod(
          this._toJsonSchemaObject(option),
          `${path}.anyOf[${index}]`
        )
      );
      const union = options.length === 1 ? options[0] : z.union(options as any);
      return this._applySchemaMetadata(union, schema);
    }

    if (Array.isArray(typeValue)) {
      const hasNull = typeValue.includes('null');
      const nonNullTypes = typeValue.filter((entry) => entry !== 'null');

      if (nonNullTypes.length === 1) {
        const base = this._jsonSchemaToZod(
          { ...schema, type: nonNullTypes[0] },
          path
        );
        return hasNull ? base.nullable() : base;
      }

      if (nonNullTypes.length > 1) {
        const options = nonNullTypes.map((entry) =>
          this._jsonSchemaToZod({ ...schema, type: entry }, path)
        );
        const union =
          options.length === 1 ? options[0] : z.union(options as any);
        return hasNull ? union.nullable() : union;
      }
    }

    let zodSchema: z.ZodTypeAny;
    if (typeValue === 'object' || schema.properties) {
      const properties =
        schema.properties && typeof schema.properties === 'object'
          ? (schema.properties as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((entry) => typeof entry === 'string')
          : []
      );

      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const propertySchema = this._toJsonSchemaObject(value);
        const hasDefault = Object.prototype.hasOwnProperty.call(
          propertySchema,
          'default'
        );

        let field = this._jsonSchemaToZod(propertySchema, `${path}.${key}`);
        if (hasDefault) {
          field = this._applyDefault(field, propertySchema.default);
        } else if (!required.has(key)) {
          field = field.optional();
        }
        shape[key] = field;
      }

      zodSchema = z.object(shape);
    } else if (typeValue === 'array') {
      const itemsSchema = this._toJsonSchemaObject(schema.items);
      zodSchema = z.array(this._jsonSchemaToZod(itemsSchema, `${path}[]`));
    } else if (typeValue === 'string') {
      zodSchema = z.string();
    } else if (typeValue === 'integer') {
      zodSchema = z.number().int();
    } else if (typeValue === 'number') {
      zodSchema = z.number();
    } else if (typeValue === 'boolean') {
      zodSchema = z.boolean();
    } else if (typeValue === 'null') {
      zodSchema = z.null();
    } else {
      zodSchema = z.any();
    }

    return this._applySchemaMetadata(zodSchema, schema);
  }

  private _toJsonSchemaObject(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object') {
      return {};
    }
    return input as Record<string, unknown>;
  }

  private _toLiteralUnion(values: unknown[]) {
    const literalValues = values.filter((value) =>
      this._isLiteralPrimitive(value)
    );
    if (!literalValues.length) {
      return z.any();
    }
    if (literalValues.length === 1) {
      return z.literal(literalValues[0]);
    }

    const literals = literalValues.map((value) => z.literal(value));
    return z.union(literals as any);
  }

  private _isLiteralPrimitive(
    value: unknown
  ): value is string | number | boolean | null {
    return (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    );
  }

  private _applyDefault(schema: z.ZodTypeAny, value: unknown): z.ZodTypeAny {
    try {
      return (schema as any).default(value);
    } catch {
      return schema;
    }
  }

  private _applySchemaMetadata(
    schema: z.ZodTypeAny,
    sourceSchema: Record<string, unknown>
  ) {
    let result = schema;
    if (sourceSchema.nullable === true) {
      result = result.nullable();
    }
    if (typeof sourceSchema.description === 'string') {
      result = result.describe(sourceSchema.description);
    }
    return result;
  }

  private _formatMcpResult(result: any): string {
    /**
     * Format MCP tool result into a string for ActionResult
     */

    // Handle different MCP result formats
    if (result && typeof result === 'object') {
      if (Array.isArray(result)) {
        // List of content items
        const parts: string[] = [];
        for (const item of result) {
          if (item && typeof item === 'object' && 'text' in item) {
            parts.push(String(item.text));
          } else {
            parts.push(String(item));
          }
        }
        return parts.join('\n');
      } else if ('text' in result) {
        return String(result.text);
      } else if ('content' in result) {
        // Structured content response
        if (Array.isArray(result.content)) {
          const parts: string[] = [];
          for (const item of result.content) {
            if (item && typeof item === 'object' && 'text' in item) {
              parts.push(String(item.text));
            } else {
              parts.push(String(item));
            }
          }
          return parts.join('\n');
        } else {
          return String(result.content);
        }
      }
    }

    // Direct result or unknown format
    return String(result);
  }

  /**
   * List available prompts from the MCP server
   */
  async listPrompts(): Promise<Prompt[]> {
    if (!this._connected) {
      await this.connect();
    }

    try {
      const result = await this.client.request(
        ListPromptsRequestSchema as any,
        {} as any
      );
      this._prompts = new Map(
        (result as any).prompts.map((prompt: any) => [prompt.name, prompt])
      );
      return Array.from(this._prompts.values());
    } catch (error) {
      logger.debug(`Server '${this.serverName}' does not support prompts`);
      return [];
    }
  }

  /**
   * Get a prompt with arguments
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<any> {
    if (!this._connected) {
      await this.connect();
    }

    try {
      const result = await this.client.request(
        GetPromptRequestSchema as any,
        {
          name,
          arguments: args,
        } as any
      );
      return result as any;
    } catch (error) {
      logger.error(
        `Failed to get prompt '${name}': ${redactMcpLogMessage(error)}`
      );
      throw error;
    }
  }

  /**
   * Start health check monitoring
   */
  private _startHealthCheck(): void {
    if (this.healthCheckIntervalSeconds <= 0 || this._healthCheckInterval) {
      return;
    }

    this._healthCheckInterval = setInterval(async () => {
      try {
        await this._performHealthCheck();
      } catch (error) {
        logger.warning(
          `Health check failed for '${this.serverName}': ${redactMcpLogMessage(error)}`
        );
        if (this.autoReconnect) {
          await this._attemptReconnect();
        }
      }
    }, this.healthCheckIntervalSeconds * 1000);
  }

  /**
   * Stop health check monitoring
   */
  private _stopHealthCheck(): void {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = undefined;
    }
  }

  /**
   * Perform health check by listing tools
   */
  private async _performHealthCheck(): Promise<void> {
    if (!this._connected) {
      return;
    }

    try {
      await this.client.request(ListToolsRequestSchema as any, {} as any);
      this._lastHealthCheck = Date.now() / 1000;
    } catch (error) {
      this._connected = false;
      throw error;
    }
  }

  /**
   * Attempt to reconnect to the server
   */
  private async _attemptReconnect(): Promise<void> {
    logger.info(`Attempting to reconnect to '${this.serverName}'...`);
    this._connected = false;

    try {
      await this.connect(this.connectionTimeout);
      logger.info(`✅ Reconnected to '${this.serverName}'`);
    } catch (error) {
      logger.error(
        `Failed to reconnect to '${this.serverName}': ${redactMcpLogMessage(error)}`
      );
    }
  }

  /**
   * Get client statistics
   */
  public getStats(): {
    serverName: string;
    connected: boolean;
    toolsDiscovered: number;
    promptsDiscovered: number;
    toolCallCount: number;
    errorCount: number;
    successRate: number;
    uptime?: number;
    lastHealthCheck?: number;
  } {
    const uptime = this._lastConnectTime
      ? Date.now() / 1000 - this._lastConnectTime
      : undefined;
    const successRate =
      this._toolCallCount > 0 ? 1 - this._errorCount / this._toolCallCount : 1;

    return {
      serverName: this.serverName,
      connected: this._connected,
      toolsDiscovered: this._tools.size,
      promptsDiscovered: this._prompts.size,
      toolCallCount: this._toolCallCount,
      errorCount: this._errorCount,
      successRate,
      uptime,
      lastHealthCheck: this._lastHealthCheck,
    };
  }

  /**
   * Check if client is connected
   */
  public isConnected(): boolean {
    return this._connected;
  }

  /**
   * Reset statistics
   */
  public resetStats(): void {
    this._toolCallCount = 0;
    this._errorCount = 0;
    logger.debug(`Reset statistics for '${this.serverName}'`);
  }

  // Async context manager support
  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }
}
