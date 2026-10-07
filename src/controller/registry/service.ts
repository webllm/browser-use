import { z, type ZodTypeAny } from 'zod';
import { createHmac } from 'node:crypto';
import { createLogger } from '../../logging-config.js';
import { observe_debug } from '../../observability.js';
import { time_execution_async } from '../../utils.js';
import { is_new_tab_page, match_url_with_domain_pattern } from '../../utils.js';
import type { Page } from '../../browser/types.js';
import { BrowserError } from '../../browser/views.js';
import { FileSystem } from '../../filesystem/file-system.js';
import { ActionModel, ActionRegistry, RegisteredAction } from './views.js';

const logger = createLogger('browser_use.controller.registry');

import type { BrowserSession } from '../../browser/session.js';

type BaseChatModel = unknown;

export interface SensitiveDataMap {
  [key: string]: string | Record<string, string>;
}

export interface ExecuteActionContext<Context> {
  context?: Context;
  browser_session?: BrowserSession | null;
  browser?: BrowserSession | null;
  browser_context?: BrowserSession | null;
  page_url?: string | null;
  cdp_client?: unknown;
  page_extraction_llm?: BaseChatModel | null;
  extraction_schema?: Record<string, unknown> | null;
  file_system?: FileSystem | null;
  available_file_paths?: string[] | null;
  sensitive_data?: SensitiveDataMap | null;
  signal?: AbortSignal | null;
}

export type RegistryActionHandler<Params = any, Context = unknown> = (
  params: Params,
  ctx: ExecuteActionContext<Context> & {
    page?: Page | null;
    has_sensitive_data?: boolean;
  }
) => Promise<unknown> | unknown;

export interface ActionOptions {
  param_model?: ZodTypeAny;
  action_name?: string;
  domains?: string[] | null;
  allowed_domains?: string[] | null;
  page_filter?: ((page: Page) => boolean) | null;
  terminates_sequence?: boolean;
  /** Keep the action callable by name but out of the model's action schema. */
  hidden_from_model?: boolean;
}

const SPECIAL_PARAM_NAMES = new Set([
  'context',
  'browser_session',
  'browser',
  'browser_context',
  'page',
  'page_url',
  'cdp_client',
  'page_extraction_llm',
  'available_file_paths',
  'has_sensitive_data',
  'file_system',
  'extraction_schema',
  'sensitive_data',
  'signal',
]);

interface ParsedFunctionParam {
  name: string;
  hasDefault: boolean;
}

const splitTopLevelParameters = (paramsSource: string): string[] => {
  const segments: string[] = [];
  let current = '';
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = '';
  };

  for (const char of paramsSource) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      current += char;
      quote = char;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen -= 1;
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace -= 1;
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket -= 1;

    if (
      char === ',' &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0
    ) {
      flush();
      continue;
    }
    current += char;
  }

  flush();
  return segments;
};

const extractFunctionParameters = (
  fn: (...args: any[]) => unknown
): ParsedFunctionParam[] | null => {
  const source = fn.toString().trim();
  if (!source) {
    return null;
  }

  let paramsSource: string;
  const arrowIndex = source.indexOf('=>');
  if (arrowIndex !== -1) {
    let lhs = source.slice(0, arrowIndex).trim();
    if (lhs.startsWith('async ')) {
      lhs = lhs.slice('async '.length).trim();
    }
    if (lhs.startsWith('(') && lhs.endsWith(')')) {
      paramsSource = lhs.slice(1, -1);
    } else {
      paramsSource = lhs;
    }
  } else {
    const openIndex = source.indexOf('(');
    const closeIndex = source.indexOf(')', openIndex + 1);
    if (openIndex === -1 || closeIndex === -1) {
      return null;
    }
    paramsSource = source.slice(openIndex + 1, closeIndex);
  }

  const tokens = splitTopLevelParameters(paramsSource);
  if (!tokens.length) {
    return [];
  }

  const parsed: ParsedFunctionParam[] = [];
  for (const token of tokens) {
    if (token.startsWith('...')) {
      const fnName = fn.name || '<anonymous>';
      throw new Error(
        `Action '${fnName}' has ${token} which is not allowed. Actions must have explicit positional parameters only.`
      );
    }
    if (
      token.includes('{') ||
      token.includes('}') ||
      token.includes('[') ||
      token.includes(']')
    ) {
      return null;
    }
    const eqIndex = token.indexOf('=');
    const name = (eqIndex === -1 ? token : token.slice(0, eqIndex)).trim();
    if (!name) {
      return null;
    }
    parsed.push({
      name,
      hasDefault: eqIndex !== -1,
    });
  }

  return parsed;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const createAbortError = (reason?: unknown): Error => {
  if (isAbortError(reason)) {
    return reason as Error;
  }

  const message =
    reason instanceof Error ? reason.message : 'Operation aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  if (reason !== undefined) {
    (error as Error & { cause?: unknown }).cause = reason;
  }
  return error;
};

const wrapActionExecutionError = (
  actionName: string,
  error: unknown
): Error => {
  if (error instanceof BrowserError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Error executing action ${actionName}: ${message}`);
  if (error !== undefined) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  return wrapped;
};

const isSpecialContextMissingError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('requires browser_session but none provided') ||
    error.message.includes('requires page_extraction_llm but none provided')
  );
};

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TimeoutError';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const decodeBase32Secret = (secret: string) => {
  const sanitized = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!sanitized.length) {
    throw new Error('Invalid TOTP secret: empty base32 payload');
  }

  let bits = 0;
  let bitBuffer = 0;
  const bytes: number[] = [];
  for (const char of sanitized) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error(`Invalid base32 character in TOTP secret: ${char}`);
    }
    bitBuffer = (bitBuffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bytes.push((bitBuffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (!bytes.length) {
    throw new Error('Invalid TOTP secret: failed to decode base32 payload');
  }

  return Buffer.from(bytes);
};

const generateTotpCode = (secret: string) => {
  const key = decodeBase32Secret(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binaryCode % 1_000_000).padStart(6, '0');
};

export class Registry<Context = unknown> {
  private registry = new ActionRegistry();
  private excludeActions: Set<string>;

  constructor(exclude_actions: string[] | null = null) {
    this.excludeActions = new Set(exclude_actions ?? []);
  }

  action(description: string, options: ActionOptions = {}) {
    if (options.allowed_domains && options.domains) {
      throw new Error(
        "Cannot specify both 'domains' and 'allowed_domains' - they are aliases for the same parameter"
      );
    }
    let schema = options.param_model ?? z.object({}).strict();
    const actionNameOverride = options.action_name ?? null;
    const domains = options.allowed_domains ?? options.domains ?? null;
    const pageFilter = options.page_filter ?? null;
    const terminatesSequence = options.terminates_sequence ?? false;
    const hiddenFromModel = options.hidden_from_model ?? false;

    return <Params = any>(handler: RegistryActionHandler<Params, Context>) => {
      const actionName = actionNameOverride ?? handler.name;
      if (this.excludeActions.has(actionName)) {
        return handler;
      }

      const parsedHandlerParams = extractFunctionParameters(handler as any);
      let normalizedHandler: RegistryActionHandler<Params, Context> = handler;
      if (!options.param_model) {
        const supportsCompatSignature = Boolean(
          parsedHandlerParams &&
          parsedHandlerParams.length > 0 &&
          !(
            parsedHandlerParams.length <= 2 &&
            parsedHandlerParams[0]?.name === 'params'
          )
        );

        if (supportsCompatSignature && parsedHandlerParams) {
          const actionParams = parsedHandlerParams.filter(
            (entry) => !SPECIAL_PARAM_NAMES.has(entry.name)
          );

          const shape = Object.fromEntries(
            actionParams.map((entry) => [
              entry.name,
              entry.hasDefault ? z.any().optional() : z.any(),
            ])
          );
          schema = z.object(shape).strict();

          normalizedHandler = ((
            params: Record<string, unknown>,
            ctx: ExecuteActionContext<Context> & {
              page?: Page | null;
              has_sensitive_data?: boolean;
            }
          ) => {
            const args = parsedHandlerParams.map((entry) => {
              if (SPECIAL_PARAM_NAMES.has(entry.name)) {
                const value = (ctx as Record<string, unknown>)[entry.name];
                if (
                  (value === null || value === undefined) &&
                  !entry.hasDefault
                ) {
                  throw new Error(
                    `Action ${actionName} requires ${entry.name} but none provided.`
                  );
                }
                return value;
              }

              const value = (params as Record<string, unknown>)[entry.name];
              if (value === undefined && !entry.hasDefault) {
                throw new Error(
                  `${actionName}() missing required parameter '${entry.name}'`
                );
              }
              return value;
            });

            return (handler as (...args: unknown[]) => unknown)(...args);
          }) as RegistryActionHandler<Params, Context>;
        }
      }

      const action = new RegisteredAction(
        actionName,
        description,
        normalizedHandler,
        schema,
        domains,
        pageFilter,
        terminatesSequence,
        hiddenFromModel
      );
      this.registry.register(action);
      return normalizedHandler as any;
    };
  }

  public get_action(action_name: string) {
    return this.registry.get(action_name);
  }

  public exclude_action(action_name: string) {
    this.excludeActions.add(action_name);
    this.registry.remove(action_name);
  }

  public remove_action(action_name: string) {
    this.registry.remove(action_name);
  }

  public get_all_actions() {
    return this.registry.actionsMap;
  }

  public execute_action = observe_debug({
    name: 'execute_action',
    ignore_input: true,
    ignore_output: true,
  })(
    time_execution_async('--execute_action')(
      async (
        action_name: string,
        params: Record<string, unknown>,
        {
          browser_session = null,
          page_extraction_llm = null,
          extraction_schema = null,
          file_system = null,
          sensitive_data = null,
          available_file_paths = null,
          signal = null,
          context = null as unknown as Context,
        }: ExecuteActionContext<Context> = {}
      ) => {
        const action = this.registry.get(action_name);
        if (!action) {
          throw new Error(`Action ${action_name} not found`);
        }

        const parsed = action.paramSchema.safeParse(params);
        if (!parsed.success) {
          throw new Error(
            `Invalid parameters ${safeJsonStringify(params)} for action ${action_name}: ${parsed.error.message}`
          );
        }

        let validatedParams: any = parsed.data;

        let currentUrl: string | null = null;
        if (browser_session?.agent_current_page?.url) {
          currentUrl = browser_session.agent_current_page.url();
        } else if (browser_session?.get_current_page) {
          const currentPage = await browser_session.get_current_page();
          currentUrl = currentPage?.url() ?? null;
        }

        if (sensitive_data) {
          validatedParams = this.replace_sensitive_data(
            validatedParams,
            sensitive_data,
            currentUrl
          );
        }

        let page: Page | null = null;
        if (browser_session?.get_current_page) {
          page = await browser_session.get_current_page();
        }

        const ctx = {
          context,
          browser_session,
          browser: browser_session,
          browser_context: browser_session,
          page,
          page_url: currentUrl,
          cdp_client: (browser_session as any)?.cdp_client ?? null,
          page_extraction_llm,
          extraction_schema,
          file_system,
          available_file_paths,
          sensitive_data,
          signal,
          has_sensitive_data:
            (action_name === 'input_text' || action_name === 'input') &&
            Boolean(sensitive_data),
        };

        if (signal?.aborted) {
          throw createAbortError(signal.reason);
        }

        try {
          return await action.handler(validatedParams, ctx);
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            throw createAbortError(signal?.reason ?? error);
          }
          if (isTimeoutError(error)) {
            throw new Error(
              `Error executing action ${action_name} due to timeout.`,
              { cause: error }
            );
          }
          if (isSpecialContextMissingError(error)) {
            throw error;
          }
          throw wrapActionExecutionError(action_name, error);
        }
      }
    )
  );

  private replace_sensitive_data(
    params: any,
    sensitiveData: SensitiveDataMap,
    currentUrl: string | null
  ) {
    const secretPattern = /<secret>(.*?)<\/secret>/g;
    const applicableSecrets: Record<string, string> = Object.create(null);

    for (const [domainOrKey, content] of Object.entries(sensitiveData)) {
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        if (
          currentUrl &&
          !is_new_tab_page(currentUrl) &&
          match_url_with_domain_pattern(currentUrl, domainOrKey)
        ) {
          Object.assign(applicableSecrets, content);
        }
      } else if (typeof content === 'string') {
        applicableSecrets[domainOrKey] = content;
      }
    }

    // Filter out empty values so they are reported as missing instead of
    // silently replacing placeholders with empty strings.
    for (const key of Object.keys(applicableSecrets)) {
      if (!applicableSecrets[key]) {
        delete applicableSecrets[key];
      }
    }

    const cloneValue = (value: any): any => {
      if (Array.isArray(value)) {
        return value.map((item) => cloneValue(item));
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, cloneValue(v)])
        );
      }
      return value;
    };

    const processed = cloneValue(params);
    const replaced = new Set<string>();
    const missing = new Set<string>();

    const resolveSecret = (placeholder: string): string => {
      replaced.add(placeholder);
      const replacement = applicableSecrets[placeholder];
      if (placeholder.endsWith('bu_2fa_code')) {
        return generateTotpCode(replacement);
      }
      return replacement;
    };

    const traverse = (value: any): any => {
      if (typeof value === 'string') {
        const withTagsReplaced = value.replace(
          secretPattern,
          (_, placeholderValue) => {
            const placeholder = String(placeholderValue);
            if (placeholder in applicableSecrets) {
              return resolveSecret(placeholder);
            }
            missing.add(placeholder);
            return `<secret>${placeholder}</secret>`;
          }
        );

        // Handle literal secrets ("user_name" without tags) for cases where
        // the LLM forgets the <secret> tags but uses the exact placeholder.
        if (withTagsReplaced in applicableSecrets) {
          return resolveSecret(withTagsReplaced);
        }
        return withTagsReplaced;
      }
      if (Array.isArray(value)) {
        return value.map(traverse);
      }
      if (value && typeof value === 'object') {
        for (const [key, val] of Object.entries(value)) {
          value[key] = traverse(val);
        }
      }
      return value;
    };

    traverse(processed);
    this.log_sensitive_data_usage(replaced, currentUrl);
    if (missing.size > 0) {
      logger.warning(
        `Missing or empty keys in sensitive_data dictionary: ${Array.from(missing).join(', ')}`
      );
    }

    return processed;
  }

  private redactUrlForLog(url: string | null) {
    if (!url || is_new_tab_page(url)) {
      return '';
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'data:') {
        return 'data:<redacted>';
      }
      if (parsed.protocol === 'blob:') {
        return parsed.origin && parsed.origin !== 'null'
          ? `blob:${parsed.origin}/<redacted>`
          : 'blob:<redacted>';
      }
      return `${parsed.origin}${parsed.pathname}${
        parsed.search ? '?<redacted>' : ''
      }${parsed.hash ? '#<redacted>' : ''}`;
    } catch {
      const queryIndex = url.indexOf('?');
      const hashIndex = url.indexOf('#');
      const cutoffCandidates = [queryIndex, hashIndex].filter(
        (index) => index >= 0
      );
      const cutoff =
        cutoffCandidates.length > 0
          ? Math.min(...cutoffCandidates)
          : url.length;
      return `${url.slice(0, cutoff)}${queryIndex >= 0 ? '?<redacted>' : ''}${
        hashIndex >= 0 ? '#<redacted>' : ''
      }`;
    }
  }

  private log_sensitive_data_usage(
    placeholders: Set<string>,
    currentUrl: string | null
  ) {
    if (!placeholders.size) {
      return;
    }
    const redactedUrl = this.redactUrlForLog(currentUrl);
    const urlInfo = redactedUrl ? ` on ${redactedUrl}` : '';
    logger.info(
      `🔒 Using sensitive data placeholders: ${Array.from(placeholders).sort().join(', ')}${urlInfo}`
    );
  }

  create_action_model(
    options: {
      include_actions?: string[] | null;
      page?: Page | null;
    } = {}
  ) {
    const { include_actions = null, page = null } = options;
    const availableActions = this.registry.getAvailableActions(
      page,
      include_actions
    );

    class DynamicActionModel extends ActionModel {
      static available_actions = availableActions.map((action) => action.name);
    }

    Object.defineProperty(DynamicActionModel, 'name', {
      value: 'ActionModel',
    });

    return DynamicActionModel as typeof ActionModel;
  }

  get_prompt_description(page?: Page | null) {
    return this.registry.get_prompt_description(page ?? undefined);
  }
}
