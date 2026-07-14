import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { createLogger } from './logging-config.js';

loadEnv({ quiet: true });

const logger = createLogger('browser_use.config');

export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const CONFIG_READ_CHUNK_BYTES = 64 * 1024;

const expand_user = (value: string) =>
  value.replace(/^~(?=$|\/|\\)/, os.homedir());

const resolve_path = (value: string) => path.resolve(expand_user(value));

const string_to_bool = (
  value: string | undefined | null,
  defaultValue = false
) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['true', '1', 't', 'y', 'yes'].includes(value.toLowerCase());
};

let docker_cache: boolean | null = null;

type ContainerDetectionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (target: string) => boolean;
  readFileSync?: (target: string, encoding: BufferEncoding) => string;
};

const CONTAINER_CGROUP_MARKERS =
  /(?:^|[/.-])(docker|containerd|kubepods|podman|libpod|lxc)(?:[/.-]|$)/i;

export const detect_container_environment = (
  options: ContainerDetectionOptions = {}
): boolean => {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') {
    return false;
  }

  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;

  const explicitContainer = String(env.container ?? '')
    .trim()
    .toLowerCase();
  if (
    explicitContainer &&
    !['0', 'false', 'no', 'none'].includes(explicitContainer)
  ) {
    return true;
  }
  if (env.KUBERNETES_SERVICE_HOST) {
    return true;
  }

  try {
    if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
      return true;
    }
  } catch {
    // Continue with cgroup evidence.
  }

  for (const cgroupPath of ['/proc/1/cgroup', '/proc/self/cgroup']) {
    try {
      if (CONTAINER_CGROUP_MARKERS.test(readFileSync(cgroupPath, 'utf-8'))) {
        return true;
      }
    } catch {
      // Missing procfs entries are not container evidence.
    }
  }

  return false;
};

export const is_running_in_docker = () => {
  if (docker_cache !== null) {
    return docker_cache;
  }

  docker_cache = detect_container_environment();
  return docker_cache;
};

const chmod_private = (target: string, mode: number) => {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(target, mode);
  } catch {
    /* noop */
  }
};

const fchmod_private = (fd: number, mode: number) => {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.fchmodSync(fd, mode);
  } catch {
    /* noop */
  }
};

const read_private_config_file = (config_path: string): string => {
  let fd: number | null = null;
  try {
    const pathStats = fs.lstatSync(config_path);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new Error(`Config path is not a regular file: ${config_path}`);
    }
    const nonBlocking =
      process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
    const noFollow =
      process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(
      config_path,
      fs.constants.O_RDONLY | nonBlocking | noFollow
    );
    const stats = fs.fstatSync(fd);
    const currentPathStats = fs.lstatSync(config_path);
    if (
      !stats.isFile() ||
      currentPathStats.isSymbolicLink() ||
      !currentPathStats.isFile()
    ) {
      throw new Error(`Config path is not a regular file: ${config_path}`);
    }
    if (
      pathStats.dev !== stats.dev ||
      pathStats.ino !== stats.ino ||
      currentPathStats.dev !== stats.dev ||
      currentPathStats.ino !== stats.ino
    ) {
      throw new Error(`Config path changed while opening: ${config_path}`);
    }
    fchmod_private(fd, 0o600);
    if (stats.size > MAX_CONFIG_FILE_BYTES) {
      throw new Error(
        `Config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes: ${config_path}`
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_CONFIG_FILE_BYTES) {
      const remaining = MAX_CONFIG_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(CONFIG_READ_CHUNK_BYTES, remaining)
      );
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_CONFIG_FILE_BYTES) {
      throw new Error(
        `Config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes: ${config_path}`
      );
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
};

const ensure_dir = (target: string) => {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  chmod_private(target, 0o700);
};

const write_private_config_file = (config_path: string, config: unknown) => {
  const parent = path.dirname(config_path);
  ensure_dir(parent);
  const temp_path = path.join(
    parent,
    `.${path.basename(config_path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | null = null;

  try {
    fd = fs.openSync(temp_path, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(temp_path, config_path);

    if (process.platform !== 'win32') {
      let parent_fd: number | null = null;
      try {
        parent_fd = fs.openSync(parent, 'r');
        fs.fsyncSync(parent_fd);
      } catch {
        // Directory fsync is best effort on filesystems that do not support it.
      } finally {
        if (parent_fd !== null) {
          fs.closeSync(parent_fd);
        }
      }
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.rmSync(temp_path, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
};

class OldConfig {
  private _dirs_created = false;

  get BROWSER_USE_LOGGING_LEVEL() {
    return (process.env.BROWSER_USE_LOGGING_LEVEL ?? 'info').toLowerCase();
  }

  get ANONYMIZED_TELEMETRY() {
    return string_to_bool(process.env.ANONYMIZED_TELEMETRY, true);
  }

  get BROWSER_USE_CLOUD_SYNC() {
    const value = process.env.BROWSER_USE_CLOUD_SYNC;
    return value ? string_to_bool(value) : this.ANONYMIZED_TELEMETRY;
  }

  get BROWSER_USE_CLOUD_API_URL() {
    const url =
      process.env.BROWSER_USE_CLOUD_API_URL ?? 'https://api.browser-use.com';
    if (!url.includes('://')) {
      throw new Error('BROWSER_USE_CLOUD_API_URL must be a valid URL');
    }
    return url;
  }

  get BROWSER_USE_CLOUD_UI_URL() {
    const url = process.env.BROWSER_USE_CLOUD_UI_URL ?? '';
    if (url && !url.includes('://')) {
      throw new Error('BROWSER_USE_CLOUD_UI_URL must be a valid URL if set');
    }
    return url;
  }

  get BROWSER_USE_DEBUG_LOG_FILE() {
    return process.env.BROWSER_USE_DEBUG_LOG_FILE ?? null;
  }

  get BROWSER_USE_INFO_LOG_FILE() {
    return process.env.BROWSER_USE_INFO_LOG_FILE ?? null;
  }

  get XDG_CACHE_HOME() {
    return resolve_path(process.env.XDG_CACHE_HOME ?? '~/.cache');
  }

  get XDG_CONFIG_HOME() {
    return resolve_path(process.env.XDG_CONFIG_HOME ?? '~/.config');
  }

  get BROWSER_USE_CONFIG_DIR() {
    const configured = process.env.BROWSER_USE_CONFIG_DIR;
    const dir = configured
      ? resolve_path(configured)
      : path.join(this.XDG_CONFIG_HOME, 'browseruse');
    this._ensure_dirs(dir);
    return dir;
  }

  get BROWSER_USE_CONFIG_FILE() {
    return path.join(this.BROWSER_USE_CONFIG_DIR, 'config.json');
  }

  get BROWSER_USE_PROFILES_DIR() {
    const dir = path.join(this.BROWSER_USE_CONFIG_DIR, 'profiles');
    this._ensure_dirs(dir);
    return dir;
  }

  get BROWSER_USE_DEFAULT_USER_DATA_DIR() {
    return path.join(this.BROWSER_USE_PROFILES_DIR, 'default');
  }

  get BROWSER_USE_EXTENSIONS_DIR() {
    const dir = path.join(this.BROWSER_USE_CONFIG_DIR, 'extensions');
    this._ensure_dirs(dir);
    return dir;
  }

  get OPENAI_API_KEY() {
    return process.env.OPENAI_API_KEY ?? '';
  }

  get ANTHROPIC_API_KEY() {
    return process.env.ANTHROPIC_API_KEY ?? '';
  }

  get GOOGLE_API_KEY() {
    return process.env.GOOGLE_API_KEY ?? '';
  }

  get DEEPSEEK_API_KEY() {
    return process.env.DEEPSEEK_API_KEY ?? '';
  }

  get GROQ_API_KEY() {
    return process.env.GROQ_API_KEY ?? process.env.GROK_API_KEY ?? '';
  }

  get GROK_API_KEY() {
    return this.GROQ_API_KEY;
  }

  get NOVITA_API_KEY() {
    return process.env.NOVITA_API_KEY ?? '';
  }

  get AZURE_OPENAI_ENDPOINT() {
    return process.env.AZURE_OPENAI_ENDPOINT ?? '';
  }

  get AZURE_OPENAI_KEY() {
    return process.env.AZURE_OPENAI_KEY ?? '';
  }

  get SKIP_LLM_API_KEY_VERIFICATION() {
    return string_to_bool(process.env.SKIP_LLM_API_KEY_VERIFICATION, false);
  }

  get DEFAULT_LLM() {
    return process.env.DEFAULT_LLM ?? '';
  }

  get IN_DOCKER() {
    return (
      string_to_bool(process.env.IN_DOCKER, false) || is_running_in_docker()
    );
  }

  get IS_IN_EVALS() {
    return string_to_bool(process.env.IS_IN_EVALS, false);
  }

  get BROWSER_USE_VERSION_CHECK() {
    return string_to_bool(process.env.BROWSER_USE_VERSION_CHECK, true);
  }

  get WIN_FONT_DIR() {
    return process.env.WIN_FONT_DIR ?? 'C:\\Windows\\Fonts';
  }

  _ensure_dirs(base_dir?: string) {
    if (!this._dirs_created) {
      const config_dir =
        base_dir ??
        (process.env.BROWSER_USE_CONFIG_DIR
          ? resolve_path(process.env.BROWSER_USE_CONFIG_DIR)
          : path.join(this.XDG_CONFIG_HOME, 'browseruse'));
      ensure_dir(config_dir);
      ensure_dir(path.join(config_dir, 'profiles'));
      ensure_dir(path.join(config_dir, 'extensions'));
      this._dirs_created = true;
    }
  }
}

class FlatEnvConfig {
  get BROWSER_USE_LOGGING_LEVEL() {
    return process.env.BROWSER_USE_LOGGING_LEVEL ?? 'info';
  }

  get ANONYMIZED_TELEMETRY() {
    return string_to_bool(process.env.ANONYMIZED_TELEMETRY, true);
  }

  get BROWSER_USE_CLOUD_SYNC() {
    const value = process.env.BROWSER_USE_CLOUD_SYNC;
    return value ? string_to_bool(value) : null;
  }

  get BROWSER_USE_CLOUD_API_URL() {
    return (
      process.env.BROWSER_USE_CLOUD_API_URL ?? 'https://api.browser-use.com'
    );
  }

  get BROWSER_USE_CLOUD_UI_URL() {
    return process.env.BROWSER_USE_CLOUD_UI_URL ?? '';
  }

  get BROWSER_USE_DEBUG_LOG_FILE() {
    return process.env.BROWSER_USE_DEBUG_LOG_FILE ?? null;
  }

  get BROWSER_USE_INFO_LOG_FILE() {
    return process.env.BROWSER_USE_INFO_LOG_FILE ?? null;
  }

  get XDG_CACHE_HOME() {
    return resolve_path(process.env.XDG_CACHE_HOME ?? '~/.cache');
  }

  get XDG_CONFIG_HOME() {
    return resolve_path(process.env.XDG_CONFIG_HOME ?? '~/.config');
  }

  get BROWSER_USE_CONFIG_DIR() {
    return process.env.BROWSER_USE_CONFIG_DIR
      ? resolve_path(process.env.BROWSER_USE_CONFIG_DIR)
      : null;
  }

  get OPENAI_API_KEY() {
    return process.env.OPENAI_API_KEY ?? '';
  }

  get ANTHROPIC_API_KEY() {
    return process.env.ANTHROPIC_API_KEY ?? '';
  }

  get GOOGLE_API_KEY() {
    return process.env.GOOGLE_API_KEY ?? '';
  }

  get DEEPSEEK_API_KEY() {
    return process.env.DEEPSEEK_API_KEY ?? '';
  }

  get GROQ_API_KEY() {
    return process.env.GROQ_API_KEY ?? process.env.GROK_API_KEY ?? '';
  }

  get GROK_API_KEY() {
    return this.GROQ_API_KEY;
  }

  get NOVITA_API_KEY() {
    return process.env.NOVITA_API_KEY ?? '';
  }

  get AZURE_OPENAI_ENDPOINT() {
    return process.env.AZURE_OPENAI_ENDPOINT ?? '';
  }

  get AZURE_OPENAI_KEY() {
    return process.env.AZURE_OPENAI_KEY ?? '';
  }

  get SKIP_LLM_API_KEY_VERIFICATION() {
    return string_to_bool(process.env.SKIP_LLM_API_KEY_VERIFICATION, false);
  }

  get DEFAULT_LLM() {
    return process.env.DEFAULT_LLM ?? '';
  }

  get IN_DOCKER() {
    const value = process.env.IN_DOCKER;
    return value === undefined ? null : string_to_bool(value);
  }

  get IS_IN_EVALS() {
    return string_to_bool(process.env.IS_IN_EVALS, false);
  }

  get BROWSER_USE_VERSION_CHECK() {
    return string_to_bool(process.env.BROWSER_USE_VERSION_CHECK, true);
  }

  get WIN_FONT_DIR() {
    return process.env.WIN_FONT_DIR ?? 'C:\\Windows\\Fonts';
  }

  get BROWSER_USE_CONFIG_PATH() {
    return process.env.BROWSER_USE_CONFIG_PATH
      ? resolve_path(process.env.BROWSER_USE_CONFIG_PATH)
      : null;
  }

  get BROWSER_USE_HEADLESS() {
    const value = process.env.BROWSER_USE_HEADLESS;
    return value === undefined ? null : string_to_bool(value);
  }

  get BROWSER_USE_ALLOWED_DOMAINS() {
    return process.env.BROWSER_USE_ALLOWED_DOMAINS ?? null;
  }

  get BROWSER_USE_LLM_MODEL() {
    return process.env.BROWSER_USE_LLM_MODEL ?? null;
  }

  get BROWSER_USE_PROXY_URL() {
    return process.env.BROWSER_USE_PROXY_URL ?? null;
  }

  get BROWSER_USE_NO_PROXY() {
    return process.env.BROWSER_USE_NO_PROXY ?? null;
  }

  get BROWSER_USE_PROXY_USERNAME() {
    return process.env.BROWSER_USE_PROXY_USERNAME ?? null;
  }

  get BROWSER_USE_PROXY_PASSWORD() {
    return process.env.BROWSER_USE_PROXY_PASSWORD ?? null;
  }

  get BROWSER_USE_DISABLE_EXTENSIONS() {
    const value = process.env.BROWSER_USE_DISABLE_EXTENSIONS;
    return value === undefined ? null : string_to_bool(value);
  }
}

interface DBStyleEntry {
  id: string;
  default: boolean;
  created_at: string;
}

export interface BrowserProfileEntry extends DBStyleEntry {
  headless?: boolean | null;
  user_data_dir?: string | null;
  allowed_domains?: string[] | null;
  downloads_path?: string | null;
  [key: string]: unknown;
}

export interface LLMEntry extends DBStyleEntry {
  api_key?: string | null;
  model?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
}

export interface AgentEntry extends DBStyleEntry {
  max_steps?: number | null;
  use_vision?: boolean | null;
  system_prompt?: string | null;
}

export interface DBStyleConfigJSON {
  browser_profile: Record<string, BrowserProfileEntry>;
  llm: Record<string, LLMEntry>;
  agent: Record<string, AgentEntry>;
}

const create_default_config = (): DBStyleConfigJSON => {
  logger.debug('Creating fresh default config.json');

  const profile_id = randomUUID();
  const llm_id = randomUUID();
  const agent_id = randomUUID();

  return {
    browser_profile: {
      [profile_id]: {
        id: profile_id,
        default: true,
        created_at: new Date().toISOString(),
        headless: false,
        user_data_dir: null,
        allowed_domains: null,
        downloads_path: null,
      },
    },
    llm: {
      [llm_id]: {
        id: llm_id,
        default: true,
        created_at: new Date().toISOString(),
        model: 'gpt-4.1-mini',
        api_key: null,
        temperature: null,
        max_tokens: null,
      },
    },
    agent: {
      [agent_id]: {
        id: agent_id,
        default: true,
        created_at: new Date().toISOString(),
        max_steps: null,
        use_vision: null,
        system_prompt: null,
      },
    },
  };
};

const OPENAI_API_KEY_PLACEHOLDERS = new Set([
  'your-openai-api-key-here',
  'your-openai-api-key',
]);

const sanitize_llm_api_key = (apiKey: unknown): string | null => {
  if (typeof apiKey !== 'string') {
    return null;
  }

  const trimmed = apiKey.trim();
  if (!trimmed) {
    return null;
  }

  if (OPENAI_API_KEY_PLACEHOLDERS.has(trimmed.toLowerCase())) {
    return null;
  }

  return trimmed;
};

const sanitize_db_config = (config: DBStyleConfigJSON): DBStyleConfigJSON => {
  const sanitizedLlmEntries = Object.fromEntries(
    Object.entries(config.llm ?? {}).map(([id, entry]) => [
      id,
      {
        ...entry,
        api_key: sanitize_llm_api_key(entry.api_key),
      },
    ])
  ) as Record<string, LLMEntry>;

  return {
    ...config,
    llm: sanitizedLlmEntries,
  };
};

const looks_like_new_format = (data: any) =>
  data &&
  typeof data === 'object' &&
  ['browser_profile', 'llm', 'agent'].every(
    (key) => typeof data[key] === 'object'
  ) &&
  Object.values(data.browser_profile || {}).every(
    (entry: any) => typeof entry === 'object' && 'id' in entry
  );

const load_and_migrate_config = (config_path: string): DBStyleConfigJSON => {
  if (!fs.existsSync(config_path)) {
    const parent = path.dirname(config_path);
    ensure_dir(parent);
    const fresh = create_default_config();
    write_private_config_file(config_path, fresh);
    return fresh;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(read_private_config_file(config_path));
  } catch (error) {
    throw new Error(
      `Failed to load config from ${config_path}: ${(error as Error).message}. Existing config was not modified. Repair or remove the file before retrying.`,
      { cause: error }
    );
  }

  if (looks_like_new_format(raw)) {
    return sanitize_db_config(raw as DBStyleConfigJSON);
  }

  throw new Error(
    `Unsupported legacy config format at ${config_path}. Existing config was not modified. Migrate, back up, or remove the file before retrying.`
  );
};

type RuntimeConfig = {
  browser_profile: Record<string, any>;
  llm: Record<string, any>;
  agent: Record<string, any>;
};

class ConfigCore {
  private _get_config_path() {
    const env = new FlatEnvConfig();
    if (env.BROWSER_USE_CONFIG_PATH) {
      return env.BROWSER_USE_CONFIG_PATH;
    }
    if (env.BROWSER_USE_CONFIG_DIR) {
      return path.join(env.BROWSER_USE_CONFIG_DIR, 'config.json');
    }
    return path.join(env.XDG_CONFIG_HOME, 'browseruse', 'config.json');
  }

  private _get_db_config() {
    return load_and_migrate_config(this._get_config_path());
  }

  private _get_default_entry<T extends DBStyleEntry>(
    records: Record<string, T>
  ): Record<string, any> {
    for (const entry of Object.values(records)) {
      if (entry.default) {
        return { ...entry } as Record<string, any>;
      }
    }
    const [first] = Object.values(records);
    return first ? ({ ...first } as Record<string, any>) : {};
  }

  _get_default_profile() {
    return this._get_default_entry(this._get_db_config().browser_profile);
  }

  _get_default_llm() {
    return this._get_default_entry(this._get_db_config().llm);
  }

  _get_default_agent() {
    return this._get_default_entry(this._get_db_config().agent);
  }

  _load_config() {
    const config: RuntimeConfig = {
      browser_profile: this._get_default_profile(),
      llm: this._get_default_llm(),
      agent: this._get_default_agent(),
    };

    const env = new FlatEnvConfig();

    if (env.BROWSER_USE_HEADLESS !== null) {
      config.browser_profile.headless = env.BROWSER_USE_HEADLESS;
    }

    if (env.BROWSER_USE_ALLOWED_DOMAINS) {
      config.browser_profile.allowed_domains =
        env.BROWSER_USE_ALLOWED_DOMAINS.split(',')
          .map((domain) => domain.trim())
          .filter(Boolean);
    }

    const proxy: Record<string, unknown> = {};
    if (env.BROWSER_USE_PROXY_URL) {
      proxy.server = env.BROWSER_USE_PROXY_URL;
    }
    if (env.BROWSER_USE_NO_PROXY) {
      proxy.bypass = env.BROWSER_USE_NO_PROXY.split(',')
        .map((domain) => domain.trim())
        .filter(Boolean)
        .join(',');
    }
    if (env.BROWSER_USE_PROXY_USERNAME) {
      proxy.username = env.BROWSER_USE_PROXY_USERNAME;
    }
    if (env.BROWSER_USE_PROXY_PASSWORD) {
      proxy.password = env.BROWSER_USE_PROXY_PASSWORD;
    }
    if (Object.keys(proxy).length > 0) {
      config.browser_profile.proxy = proxy;
    }

    if (env.OPENAI_API_KEY) {
      config.llm.api_key = env.OPENAI_API_KEY;
    }

    if (env.DEFAULT_LLM) {
      config.llm.model = env.DEFAULT_LLM;
    }

    if (env.BROWSER_USE_LLM_MODEL) {
      config.llm.model = env.BROWSER_USE_LLM_MODEL;
    }

    if (env.BROWSER_USE_DISABLE_EXTENSIONS !== null) {
      config.browser_profile.enable_default_extensions =
        !env.BROWSER_USE_DISABLE_EXTENSIONS;
    }

    return config;
  }

  _ensure_dirs() {
    new OldConfig()._ensure_dirs();
  }

  load_config() {
    return this._load_config();
  }

  get_default_profile() {
    return this._get_default_profile();
  }

  get_default_llm() {
    return this._get_default_llm();
  }

  get_default_agent() {
    return this._get_default_agent();
  }
}

type ConfigType = ConfigCore & OldConfig & FlatEnvConfig;
type BoundMethod = (...args: any[]) => unknown;

const config_handler: ProxyHandler<ConfigCore> = {
  get(target, prop, receiver) {
    if (typeof prop !== 'string') {
      return Reflect.get(target, prop, receiver);
    }

    const old = new OldConfig();
    if (prop in old) {
      const value = (old as any)[prop];
      return typeof value === 'function'
        ? (value as BoundMethod).bind(old)
        : value;
    }

    const env = new FlatEnvConfig();
    if (prop in env) {
      const value = (env as any)[prop];
      return typeof value === 'function'
        ? (value as BoundMethod).bind(env)
        : value;
    }

    const coreValue = (target as unknown as Record<string, unknown>)[prop];
    if (typeof coreValue === 'function') {
      return (coreValue as BoundMethod).bind(target);
    }
    return coreValue;
  },
};

export const CONFIG = new Proxy(new ConfigCore(), config_handler) as ConfigType;

export const load_browser_use_config = () => CONFIG.load_config();

export const get_default_profile = (config: Record<string, any>) =>
  config.browser_profile ?? {};

export const get_default_llm = (config: Record<string, any>) =>
  config.llm ?? {};
