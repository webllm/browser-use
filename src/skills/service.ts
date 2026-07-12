import { CONFIG } from '../config.js';
import { createLogger } from '../logging-config.js';
import { build_skill_parameters_schema, get_skill_slug } from './utils.js';
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
}

interface SkillListResponse {
  items?: unknown[];
}

const toSkillParameter = (raw: unknown): SkillParameterSchema | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const type = typeof record.type === 'string' ? record.type.trim() : '';

  if (!name || !type) {
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
      typeof record.description === 'string' ? record.description : undefined,
  };
};

const toSkillDefinition = (raw: unknown): SkillDefinition | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const description =
    typeof record.description === 'string' ? record.description.trim() : '';

  if (!id || !title) {
    return null;
  }

  const parametersRaw = Array.isArray(record.parameters)
    ? record.parameters
    : [];
  const parameters = parametersRaw
    .map((entry) => toSkillParameter(entry))
    .filter((entry): entry is SkillParameterSchema => entry != null);

  const output_schema =
    record.output_schema && typeof record.output_schema === 'object'
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
  private initialized = false;
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(options: CloudSkillServiceOptions) {
    this.skill_ids = options.skill_ids;
    this.api_key = options.api_key ?? process.env.BROWSER_USE_API_KEY ?? '';
    this.base_url = options.base_url ?? CONFIG.BROWSER_USE_CLOUD_API_URL;
    this.fetch_impl = options.fetch_impl ?? fetch;

    if (!this.api_key) {
      throw new Error('BROWSER_USE_API_KEY environment variable is not set');
    }
  }

  private async requestJson(
    path: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    const response = await this.fetch_impl(`${this.base_url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.api_key}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      redirect: 'error',
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const details =
        payload && typeof payload === 'object'
          ? JSON.stringify(payload)
          : String(payload ?? '');
      throw new Error(
        `Skill API request failed (${response.status}): ${details}`
      );
    }

    return payload;
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

    const items = Array.isArray(payload?.items) ? payload.items : [];
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
      const response = (await this.requestJson(
        `/api/v1/skills/${encodeURIComponent(input.skill_id)}/execute`,
        {
          method: 'POST',
          body: JSON.stringify({ parameters: validated.data }),
        }
      )) as Record<string, unknown>;

      const success = response.success === true;
      const result =
        response.result ?? response.output ?? response.data ?? null;
      const error = typeof response.error === 'string' ? response.error : null;
      const latency_ms =
        typeof response.latency_ms === 'number' ? response.latency_ms : null;

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
        error: `Failed to execute skill: ${errorText}`,
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
