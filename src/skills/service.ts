import { CONFIG } from '../config.js';
import { createLogger } from '../logging-config.js';
import { build_skill_parameters_schema, get_skill_slug } from './utils.js';
import {
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  HttpResponseTooLargeError,
  readBoundedResponseJson,
  runWithHttpTimeout,
} from '../http-response.js';
import {
  MissingCookieException,
  type BrowserCookie,
  type ExecuteSkillInput,
  type SkillDefinition,
  type SkillExecutionResult,
  type SkillParameterSchema,
  type SkillService,
} from './views.js';

const logger = createLogger('browser_use.skills');

interface CloudSkillServiceOptions {
  skill_ids: Array<string | '*'>;
  api_key?: string | null;
  base_url?: string | null;
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
}

interface SkillListResponse {
  items?: unknown[];
}

const MAX_REQUESTED_SKILL_IDS = 500;
const MAX_SKILL_ID_CHARS = 256;
const MAX_SKILL_TITLE_CHARS = 512;
const MAX_SKILL_DESCRIPTION_CHARS = 16 * 1024;
const MAX_SKILL_PARAMETERS = 256;
const MAX_SKILL_PARAMETER_NAME_CHARS = 256;
const MAX_SKILL_PARAMETER_DESCRIPTION_CHARS = 4 * 1024;
const MAX_SKILL_OUTPUT_SCHEMA_DEPTH = 50;
const MAX_SKILL_OUTPUT_SCHEMA_ENTRIES = 10_000;
const MAX_SKILL_OUTPUT_SCHEMA_STRING_CHARS = 64 * 1024;
const MAX_SKILL_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_EXECUTION_REQUEST_BYTES = 1024 * 1024;
export const MAX_SKILL_EXECUTION_RESPONSE_BYTES = 1024 * 1024;
const MAX_SKILL_EXECUTION_ERROR_CHARS = 64 * 1024;

const boundedTrimmedString = (value: unknown, maxChars: number) =>
  typeof value === 'string' ? value.slice(0, maxChars).trim() : '';

const isSafeSkillParameterName = (value: string) =>
  value !== '__proto__' && value !== 'prototype' && value !== 'constructor';

const isBoundedOutputSchema = (root: unknown) => {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_SKILL_OUTPUT_SCHEMA_STRING_CHARS) {
        return false;
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (current.depth >= MAX_SKILL_OUTPUT_SCHEMA_DEPTH) return false;
    if (seen.has(current.value)) return false;
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.entries(current.value as Record<string, unknown>).map(
          ([key, value]) => {
            if (key.length > MAX_SKILL_PARAMETER_NAME_CHARS) {
              return Symbol.for('browser-use.invalid-schema-key');
            }
            return value;
          }
        );
    entries += values.length;
    if (entries > MAX_SKILL_OUTPUT_SCHEMA_ENTRIES) return false;
    for (const value of values) {
      if (typeof value === 'symbol') return false;
      pending.push({ value, depth: current.depth + 1 });
    }
  }
  return true;
};

const toSkillParameter = (raw: unknown): SkillParameterSchema | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const name = boundedTrimmedString(
    record.name,
    MAX_SKILL_PARAMETER_NAME_CHARS
  );
  const type = boundedTrimmedString(record.type, 32);

  if (!name || !type || !isSafeSkillParameterName(name)) {
    return null;
  }

  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'boolean' &&
    type !== 'object' &&
    type !== 'array' &&
    type !== 'cookie'
  ) {
    return null;
  }

  return {
    name,
    type,
    required:
      typeof record.required === 'boolean' ? record.required : undefined,
    description:
      typeof record.description === 'string'
        ? record.description.slice(0, MAX_SKILL_PARAMETER_DESCRIPTION_CHARS)
        : undefined,
  };
};

const toSkillDefinition = (raw: unknown): SkillDefinition | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const id = boundedTrimmedString(record.id, MAX_SKILL_ID_CHARS);
  const title = boundedTrimmedString(record.title, MAX_SKILL_TITLE_CHARS);
  const description = boundedTrimmedString(
    record.description,
    MAX_SKILL_DESCRIPTION_CHARS
  );

  if (!id || !title) {
    return null;
  }

  const parametersRaw = Array.isArray(record.parameters)
    ? record.parameters.slice(0, MAX_SKILL_PARAMETERS)
    : [];
  const parameters = parametersRaw
    .map((entry) => toSkillParameter(entry))
    .filter((entry): entry is SkillParameterSchema => entry != null);

  const output_schema = isBoundedOutputSchema(record.output_schema)
    ? (record.output_schema as Record<string, unknown>)
    : null;

  return {
    id,
    title,
    description,
    parameters,
    output_schema,
  };
};

export class CloudSkillService implements SkillService {
  private readonly skill_ids: Array<string | '*'>;
  private readonly api_key: string;
  private readonly base_url: string;
  private readonly fetch_impl: typeof fetch;
  private readonly request_timeout_ms: number;
  private initialized = false;
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(options: CloudSkillServiceOptions) {
    if (
      !Array.isArray(options.skill_ids) ||
      options.skill_ids.length > MAX_REQUESTED_SKILL_IDS
    ) {
      throw new RangeError(
        `skill_ids cannot exceed ${MAX_REQUESTED_SKILL_IDS} entries`
      );
    }
    const normalizedSkillIds = options.skill_ids.map((skillId) => {
      const normalized = boundedTrimmedString(skillId, MAX_SKILL_ID_CHARS);
      if (
        !normalized ||
        (normalized !== '*' && normalized.length !== skillId.trim().length)
      ) {
        throw new RangeError(
          `skill IDs must contain between 1 and ${MAX_SKILL_ID_CHARS} characters`
        );
      }
      return normalized;
    });
    this.skill_ids = Array.from(new Set(normalizedSkillIds));
    this.api_key = options.api_key ?? process.env.BROWSER_USE_API_KEY ?? '';
    this.base_url = options.base_url ?? CONFIG.BROWSER_USE_CLOUD_API_URL;
    this.fetch_impl = options.fetch_impl ?? fetch;
    this.request_timeout_ms =
      options.request_timeout_ms ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;

    if (!this.api_key) {
      throw new Error('BROWSER_USE_API_KEY environment variable is not set');
    }
  }

  private async requestJson(
    path: string,
    init: RequestInit = {},
    maxResponseBytes = MAX_SKILL_LIST_RESPONSE_BYTES
  ): Promise<unknown> {
    return await runWithHttpTimeout(
      async (signal) => {
        const response = await this.fetch_impl(`${this.base_url}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.api_key}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers ?? {}),
          },
          redirect: 'error',
          signal,
        });

        let payload: unknown;
        try {
          payload = await readBoundedResponseJson(response, maxResponseBytes);
        } catch (error) {
          if (error instanceof HttpResponseTooLargeError) throw error;
          payload = null;
        }

        if (!response.ok) {
          const details =
            payload && typeof payload === 'object'
              ? JSON.stringify(payload)
              : String(payload ?? '');
          throw new Error(
            `Skill API request failed (${response.status}): ${details.slice(0, 8192)}`
          );
        }

        return payload;
      },
      this.request_timeout_ms,
      init.signal
    );
  }

  private async listSkillsPage(
    page_number: number,
    page_size: number
  ): Promise<SkillDefinition[]> {
    const query = new URLSearchParams({
      page_size: String(page_size),
      page_number: String(page_number),
      is_enabled: 'true',
    });

    const payload = (await this.requestJson(
      `/api/v1/skills?${query.toString()}`
    )) as SkillListResponse;

    const items = Array.isArray(payload?.items)
      ? payload.items.slice(0, page_size)
      : [];
    const skills: SkillDefinition[] = [];

    for (const item of items) {
      const status =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>).status
          : undefined;
      if (typeof status === 'string' && status !== 'finished') {
        continue;
      }

      const skill = toSkillDefinition(item);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const useWildcard = this.skill_ids.includes('*');
      const requestedIds = new Set(
        this.skill_ids.filter((entry): entry is string => entry !== '*')
      );

      const page_size = 100;
      const max_pages = useWildcard ? 1 : 5;
      const loaded: SkillDefinition[] = [];
      let reachedPaginationLimit = true;

      for (let page = 1; page <= max_pages; page += 1) {
        const pageSkills = await this.listSkillsPage(page, page_size);
        loaded.push(...pageSkills);

        if (pageSkills.length < page_size) {
          reachedPaginationLimit = false;
          break;
        }

        if (!useWildcard && requestedIds.size > 0) {
          const found = new Set(
            loaded.map((entry) => entry.id).filter((id) => requestedIds.has(id))
          );
          if (found.size === requestedIds.size) {
            reachedPaginationLimit = false;
            break;
          }
        }
      }

      if (useWildcard && loaded.length >= page_size) {
        logger.warning(
          'Wildcard "*" limited to first 100 skills. Specify explicit skill IDs if you need specific skills beyond this limit.'
        );
      }

      if (!useWildcard && reachedPaginationLimit) {
        logger.warning(
          'Reached pagination limit (5 pages) before finding all requested skills'
        );
      }

      const selected = useWildcard
        ? loaded
        : loaded.filter((entry) => requestedIds.has(entry.id));

      if (!useWildcard && requestedIds.size > 0) {
        const foundIds = new Set(selected.map((entry) => entry.id));
        const missingIds = Array.from(requestedIds).filter(
          (id) => !foundIds.has(id)
        );
        if (missingIds.length > 0) {
          logger.warning(
            `Requested skills not found or not available: ${missingIds.join(', ')}`
          );
        }
      }

      for (const skill of selected) {
        this.skills.set(skill.id, skill);
      }

      this.initialized = true;
      logger.info(
        `Loaded ${this.skills.size} skills${
          useWildcard ? ' (wildcard mode)' : ''
        }`
      );
    } catch (error) {
      // Match Python semantics: avoid retry loops after an initialization failure.
      this.initialized = true;
      throw error;
    }
  }

  async get_skill(skill_id: string): Promise<SkillDefinition | null> {
    await this.ensureInitialized();
    return this.skills.get(skill_id) ?? null;
  }

  async get_all_skills(): Promise<SkillDefinition[]> {
    await this.ensureInitialized();
    return Array.from(this.skills.values());
  }

  async execute_skill(input: ExecuteSkillInput): Promise<SkillExecutionResult> {
    await this.ensureInitialized();

    const skill = this.skills.get(input.skill_id);
    if (!skill) {
      throw new Error(
        `Skill ${input.skill_id} not found in cache. Available skills: ${Array.from(
          this.skills.keys()
        ).join(', ')}`
      );
    }

    const cookieMap = new Map<string, string>();
    for (const cookie of input.cookies ?? []) {
      if (!cookie?.name) {
        continue;
      }
      cookieMap.set(cookie.name, cookie.value ?? '');
    }

    const payload: Record<string, unknown> = {
      ...(input.parameters ?? {}),
    };

    for (const param of skill.parameters) {
      if (param.type !== 'cookie') {
        continue;
      }

      const required = param.required !== false;
      if (required && !cookieMap.has(param.name)) {
        throw new MissingCookieException(
          param.name,
          param.description || 'No description provided'
        );
      }

      if (cookieMap.has(param.name)) {
        payload[param.name] = cookieMap.get(param.name) ?? '';
      }
    }

    const validator = build_skill_parameters_schema(skill.parameters, {
      exclude_cookies: false,
    });
    const validated = validator.safeParse(payload);
    if (!validated.success) {
      throw new Error(
        `Parameter validation failed for skill ${skill.title}: ${validated.error.message}`
      );
    }

    try {
      const requestBody = JSON.stringify({ parameters: validated.data });
      if (
        Buffer.byteLength(requestBody, 'utf8') >
        MAX_SKILL_EXECUTION_REQUEST_BYTES
      ) {
        throw new Error(
          `Skill execution request exceeds ${MAX_SKILL_EXECUTION_REQUEST_BYTES.toLocaleString()} bytes`
        );
      }
      const response = (await this.requestJson(
        `/api/v1/skills/${encodeURIComponent(input.skill_id)}/execute`,
        {
          method: 'POST',
          body: requestBody,
        },
        MAX_SKILL_EXECUTION_RESPONSE_BYTES
      )) as Record<string, unknown>;

      const success = response.success === true;
      const result =
        response.result ?? response.output ?? response.data ?? null;
      const error =
        typeof response.error === 'string'
          ? response.error.slice(0, MAX_SKILL_EXECUTION_ERROR_CHARS)
          : null;
      const latency_ms =
        typeof response.latency_ms === 'number' &&
        Number.isFinite(response.latency_ms) &&
        response.latency_ms >= 0
          ? response.latency_ms
          : null;

      return {
        success,
        result,
        error,
        latency_ms,
      };
    } catch (error) {
      const errorText =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      return {
        success: false,
        error: `Failed to execute skill: ${errorText.slice(0, MAX_SKILL_EXECUTION_ERROR_CHARS)}`,
      };
    }
  }

  async close(): Promise<void> {
    this.skills.clear();
    this.initialized = false;
  }
}

export const register_skills_as_actions = async (
  skills: SkillDefinition[],
  registerAction: (
    slug: string,
    description: string,
    params: ReturnType<typeof build_skill_parameters_schema>,
    skill: SkillDefinition
  ) => void
) => {
  for (const skill of skills) {
    const slug = get_skill_slug(skill, skills);
    const paramSchema = build_skill_parameters_schema(skill.parameters, {
      exclude_cookies: true,
    });
    const description = `${skill.description} (Skill: "${skill.title}")`;
    registerAction(slug, description, paramSchema, skill);
  }
};

export const cookies_to_map = (cookies: BrowserCookie[]) => {
  const map = new Map<string, string>();
  for (const cookie of cookies) {
    map.set(cookie.name, cookie.value);
  }
  return map;
};
