#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  BrowserProfile,
  type BrowserProfileOptions,
} from './browser/profile.js';
import { BrowserSession, systemChrome } from './browser/session.js';
import { CONFIG } from './config.js';
import { CloudBrowserClient } from './browser/cloud/cloud.js';
import {
  CloudManagementClient,
  type CloudTaskView,
} from './browser/cloud/management.js';
import { ChatOpenAI } from './llm/openai/chat.js';
import { ChatAnthropic } from './llm/anthropic/chat.js';
import { ChatGoogle } from './llm/google/chat.js';
import { ChatDeepSeek } from './llm/deepseek/chat.js';
import { ChatGroq } from './llm/groq/chat.js';
import { ChatOpenRouter } from './llm/openrouter/chat.js';
import { ChatAzure } from './llm/azure/chat.js';
import { ChatOllama } from './llm/ollama/chat.js';
import { ChatMistral } from './llm/mistral/chat.js';
import { ChatOCIRaw } from './llm/oci-raw/chat.js';
import { ChatCerebras } from './llm/cerebras/chat.js';
import { ChatVercel } from './llm/vercel/chat.js';
import { ChatAnthropicBedrock } from './llm/aws/chat-anthropic.js';
import { ChatBedrockConverse } from './llm/aws/chat-bedrock.js';
import { ChatBrowserUse } from './llm/browser-use/chat.js';
import { ChatCodex } from './llm/codex/chat.js';
import {
  clearCodexTokens,
  getCodexAuthStatus,
  loginAndSaveCodexDeviceCode,
  saveImportedCodexCliTokens,
  type CodexAuthStatus,
} from './llm/codex/auth.js';
import type { BaseChatModel } from './llm/base.js';
import { get_browser_use_version } from './utils.js';
import { setupLogging } from './logging-config.js';
import { get_tunnel_manager, isValidTunnelPort } from './skill-cli/tunnel.js';
import { DeviceAuthClient, save_cloud_api_token } from './sync/auth.js';
import { isMainModule } from './entrypoint.js';
import { getCliUsage } from './cli-usage.js';
import {
  ensurePrivateDirectory as ensurePrivateDirectorySync,
  readBoundedPrivateFile,
  writePrivateFileAtomic,
} from './private-state.js';
import dotenv from 'dotenv';

export { getCliUsage } from './cli-usage.js';

dotenv.config({ quiet: true });

const require = createRequire(import.meta.url);

type CliModelProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'openrouter'
  | 'azure'
  | 'codex'
  | 'mistral'
  | 'cerebras'
  | 'vercel'
  | 'oci'
  | 'aws-anthropic'
  | 'aws'
  | 'ollama'
  | 'browser-use';

const CLI_PROVIDER_ALIASES: Record<string, CliModelProvider> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  deepseek: 'deepseek',
  groq: 'groq',
  openrouter: 'openrouter',
  azure: 'azure',
  codex: 'codex',
  'openai-codex': 'codex',
  mistral: 'mistral',
  cerebras: 'cerebras',
  vercel: 'vercel',
  oci: 'oci',
  ollama: 'ollama',
  'browser-use': 'browser-use',
  browseruse: 'browser-use',
  bu: 'browser-use',
  bedrock: 'aws',
  aws: 'aws',
  'aws-anthropic': 'aws-anthropic',
  'bedrock-anthropic': 'aws-anthropic',
};

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  debug: boolean;
  headless: boolean | null;
  window_width: number | null;
  window_height: number | null;
  user_data_dir: string | null;
  profile_directory: string | null;
  allowed_domains: string[] | null;
  proxy_url: string | null;
  no_proxy: string | null;
  proxy_username: string | null;
  proxy_password: string | null;
  cdp_url: string | null;
  model: string | null;
  provider: CliModelProvider | null;
  prompt: string | null;
  mcp: boolean;
  cli_mcp: boolean;
  json: boolean;
  yes: boolean;
  setup_mode: string | null;
  api_key: string | null;
  positional: string[];
}

export const CLI_HISTORY_LIMIT = 100;
export const MAX_CLI_HISTORY_FILE_BYTES = 1024 * 1024;

const INTERACTIVE_EXIT_COMMANDS = new Set(['exit', 'quit', ':q', '/q', '.q']);

const INTERACTIVE_HELP_COMMANDS = new Set(['help', '?', ':help']);

const parseAllowedDomains = (value: string): string[] => {
  const domains = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (domains.length === 0) {
    throw new Error(
      '--allowed-domains must include at least one domain pattern'
    );
  }
  return domains;
};

const parsePositiveInt = (name: string, value: string): number => {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (
    !/^\d+$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
};

const parseProvider = (value: string): CliModelProvider => {
  const normalized = value.trim().toLowerCase();
  const provider = CLI_PROVIDER_ALIASES[normalized];
  if (!provider) {
    throw new Error(
      `Unsupported provider "${value}". Supported values: openai, anthropic, google, deepseek, groq, openrouter, azure, codex, mistral, cerebras, vercel, oci, ollama, browser-use, aws, aws-anthropic.`
    );
  }
  return provider;
};

const takeOptionValue = (
  arg: string,
  currentIndex: number,
  argv: string[]
): { value: string; nextIndex: number } => {
  const eqIndex = arg.indexOf('=');
  if (eqIndex >= 0) {
    const inlineValue = arg.slice(eqIndex + 1).trim();
    if (!inlineValue) {
      throw new Error(`Missing value for option: ${arg.slice(0, eqIndex)}`);
    }
    return { value: inlineValue, nextIndex: currentIndex };
  }

  const next = argv[currentIndex + 1];
  if (!next || next.startsWith('-')) {
    throw new Error(`Missing value for option: ${arg}`);
  }
  return { value: next, nextIndex: currentIndex + 1 };
};

const expandHome = (value: string): string => {
  if (!value.startsWith('~')) {
    return value;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    return value;
  }
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
};

export const parseCliArgs = (argv: string[]): ParsedCliArgs => {
  const parsed: ParsedCliArgs = {
    help: false,
    version: false,
    debug: false,
    headless: null,
    window_width: null,
    window_height: null,
    user_data_dir: null,
    profile_directory: null,
    allowed_domains: null,
    proxy_url: null,
    no_proxy: null,
    proxy_username: null,
    proxy_password: null,
    cdp_url: null,
    model: null,
    provider: null,
    prompt: null,
    mcp: false,
    cli_mcp: false,
    json: false,
    yes: false,
    setup_mode: null,
    api_key: null,
    positional: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      parsed.positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--version') {
      parsed.version = true;
      continue;
    }
    if (arg === '--debug') {
      parsed.debug = true;
      continue;
    }
    if (arg === '--headless') {
      parsed.headless = true;
      continue;
    }
    if (arg === '--mcp') {
      parsed.mcp = true;
      continue;
    }
    if (arg === '--cli-mcp') {
      parsed.cli_mcp = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '-y' || arg === '--yes') {
      parsed.yes = true;
      continue;
    }

    if (arg === '-p' || arg === '--prompt' || arg.startsWith('--prompt=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.prompt = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--model' || arg.startsWith('--model=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.model = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--provider' || arg.startsWith('--provider=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.provider = parseProvider(value);
      i = nextIndex;
      continue;
    }
    if (arg === '--mode' || arg.startsWith('--mode=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.setup_mode = value.trim();
      i = nextIndex;
      continue;
    }
    if (arg === '--api-key' || arg.startsWith('--api-key=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.api_key = value.trim();
      i = nextIndex;
      continue;
    }
    if (arg === '--window-width' || arg.startsWith('--window-width=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.window_width = parsePositiveInt('--window-width', value);
      i = nextIndex;
      continue;
    }
    if (arg === '--window-height' || arg.startsWith('--window-height=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.window_height = parsePositiveInt('--window-height', value);
      i = nextIndex;
      continue;
    }
    if (arg === '--user-data-dir' || arg.startsWith('--user-data-dir=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.user_data_dir = path.resolve(expandHome(value));
      i = nextIndex;
      continue;
    }
    if (
      arg === '--profile-directory' ||
      arg.startsWith('--profile-directory=')
    ) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.profile_directory = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--allowed-domains' || arg.startsWith('--allowed-domains=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      const domains = parseAllowedDomains(value);
      parsed.allowed_domains = [...(parsed.allowed_domains ?? []), ...domains];
      i = nextIndex;
      continue;
    }
    if (arg === '--proxy-url' || arg.startsWith('--proxy-url=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.proxy_url = value.trim();
      i = nextIndex;
      continue;
    }
    if (arg === '--no-proxy' || arg.startsWith('--no-proxy=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.no_proxy = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--proxy-username' || arg.startsWith('--proxy-username=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.proxy_username = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--proxy-password' || arg.startsWith('--proxy-password=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.proxy_password = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--cdp-url' || arg.startsWith('--cdp-url=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.cdp_url = value;
      i = nextIndex;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    parsed.positional.push(arg);
  }

  if (parsed.prompt && parsed.positional.length > 0) {
    throw new Error('Use either positional task text or --prompt, not both.');
  }

  return parsed;
};

const resolveTask = (args: ParsedCliArgs): string | null => {
  if (args.prompt) {
    return args.prompt.trim();
  }
  if (args.positional.length > 0) {
    return args.positional.join(' ').trim();
  }
  return null;
};

export const isInteractiveExitCommand = (value: string): boolean =>
  INTERACTIVE_EXIT_COMMANDS.has(value.trim().toLowerCase());

export const isInteractiveHelpCommand = (value: string): boolean =>
  INTERACTIVE_HELP_COMMANDS.has(value.trim().toLowerCase());

export const normalizeCliHistory = (
  history: unknown[],
  maxLength = CLI_HISTORY_LIMIT
): string[] => {
  const normalized = history
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return normalized.slice(-maxLength);
};

export const getCliHistoryPath = (configDir?: string | null): string => {
  const baseDir =
    configDir ??
    CONFIG.BROWSER_USE_CONFIG_DIR ??
    path.join(os.homedir(), '.config', 'browseruse');
  return path.join(baseDir, 'command_history.json');
};

export const loadCliHistory = async (
  historyPath = getCliHistoryPath()
): Promise<string[]> => {
  try {
    const raw = readBoundedPrivateFile(historyPath, MAX_CLI_HISTORY_FILE_BYTES);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeCliHistory(parsed);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    return [];
  }
};

export const saveCliHistory = async (
  history: string[],
  historyPath = getCliHistoryPath()
): Promise<void> => {
  const normalized = normalizeCliHistory(history);
  const serialized = JSON.stringify(normalized, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CLI_HISTORY_FILE_BYTES) {
    throw new Error(`CLI history exceeds ${MAX_CLI_HISTORY_FILE_BYTES} bytes`);
  }
  ensurePrivateDirectorySync(path.dirname(historyPath));
  writePrivateFileAtomic(historyPath, serialized);
};

export const shouldStartInteractiveMode = (
  task: string | null,
  options: {
    forceInteractive?: boolean;
    inputIsTTY?: boolean;
    outputIsTTY?: boolean;
  } = {}
): boolean => {
  const forceInteractive =
    options.forceInteractive ??
    process.env.BROWSER_USE_CLI_FORCE_INTERACTIVE === '1';
  const inputIsTTY = options.inputIsTTY ?? Boolean(stdin.isTTY);
  const outputIsTTY = options.outputIsTTY ?? Boolean(stdout.isTTY);
  return !task && (forceInteractive || (inputIsTTY && outputIsTTY));
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const inferProviderFromModel = (model: string): CliModelProvider | null => {
  const lower = model.toLowerCase();

  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.startsWith('gpt-5')
  ) {
    return 'openai';
  }
  if (lower.startsWith('claude')) {
    return 'anthropic';
  }
  if (lower.startsWith('gemini')) {
    return 'google';
  }
  if (lower.startsWith('deepseek')) {
    return 'deepseek';
  }
  if (lower.startsWith('groq:')) {
    return 'groq';
  }
  if (lower.startsWith('openrouter:')) {
    return 'openrouter';
  }
  if (lower.startsWith('azure:')) {
    return 'azure';
  }
  if (lower.startsWith('codex:') || lower.startsWith('openai-codex:')) {
    return 'codex';
  }
  if (lower.startsWith('mistral:')) {
    return 'mistral';
  }
  if (lower.startsWith('cerebras:')) {
    return 'cerebras';
  }
  if (lower.startsWith('vercel:')) {
    return 'vercel';
  }
  if (lower.startsWith('oci:')) {
    return 'oci';
  }
  if (
    lower.startsWith('mistral-') ||
    lower.startsWith('codestral') ||
    lower.startsWith('pixtral')
  ) {
    return 'mistral';
  }
  if (
    lower.startsWith('llama3.') ||
    lower.startsWith('llama-4-') ||
    lower.startsWith('gpt-oss-') ||
    lower.startsWith('qwen-3-')
  ) {
    return 'cerebras';
  }
  if (lower.startsWith('ollama:')) {
    return 'ollama';
  }
  if (
    lower.startsWith('browser-use:') ||
    lower.startsWith('bu-') ||
    lower.startsWith('browser-use/')
  ) {
    return 'browser-use';
  }
  if (lower.startsWith('bedrock:anthropic.')) {
    return 'aws-anthropic';
  }
  if (lower.startsWith('bedrock:')) {
    return 'aws';
  }
  if (lower.startsWith('anthropic.')) {
    return 'aws-anthropic';
  }
  if (
    lower.includes('/') &&
    !lower.startsWith('http://') &&
    !lower.startsWith('https://')
  ) {
    return 'openrouter';
  }
  return null;
};

const normalizeModelValue = (
  model: string,
  provider: CliModelProvider
): string => {
  const lower = model.toLowerCase();
  if (provider === 'groq' && lower.startsWith('groq:')) {
    return model.slice('groq:'.length);
  }
  if (provider === 'openrouter' && lower.startsWith('openrouter:')) {
    return model.slice('openrouter:'.length);
  }
  if (provider === 'azure' && lower.startsWith('azure:')) {
    return model.slice('azure:'.length);
  }
  if (provider === 'codex' && lower.startsWith('codex:')) {
    return model.slice('codex:'.length);
  }
  if (provider === 'codex' && lower.startsWith('openai-codex:')) {
    return model.slice('openai-codex:'.length);
  }
  if (provider === 'mistral' && lower.startsWith('mistral:')) {
    return model.slice('mistral:'.length);
  }
  if (provider === 'cerebras' && lower.startsWith('cerebras:')) {
    return model.slice('cerebras:'.length);
  }
  if (provider === 'vercel' && lower.startsWith('vercel:')) {
    return model.slice('vercel:'.length);
  }
  if (provider === 'oci' && lower.startsWith('oci:')) {
    return model.slice('oci:'.length);
  }
  if (provider === 'ollama' && lower.startsWith('ollama:')) {
    return model.slice('ollama:'.length);
  }
  if (provider === 'browser-use' && lower.startsWith('browser-use:')) {
    return model.slice('browser-use:'.length);
  }
  if (provider === 'browser-use' && lower.startsWith('bu_')) {
    return model.replace(/_/g, '-');
  }
  if (provider === 'aws-anthropic' && lower.startsWith('bedrock:')) {
    return model.slice('bedrock:'.length);
  }
  if (provider === 'aws' && lower.startsWith('bedrock:')) {
    return model.slice('bedrock:'.length);
  }
  return model;
};

const providersAreCompatible = (
  explicitProvider: CliModelProvider,
  inferredProvider: CliModelProvider
): boolean => {
  if (explicitProvider === inferredProvider) {
    return true;
  }
  if (
    (explicitProvider === 'aws' && inferredProvider === 'aws-anthropic') ||
    (explicitProvider === 'aws-anthropic' && inferredProvider === 'aws')
  ) {
    return true;
  }
  return false;
};

const getDefaultModelForProvider = (
  provider: CliModelProvider
): string | null => {
  switch (provider) {
    case 'openai':
      return 'gpt-5-mini';
    case 'anthropic':
      return 'claude-4-sonnet';
    case 'google':
      return 'gemini-2.5-pro';
    case 'deepseek':
      return 'deepseek-chat';
    case 'groq':
      return 'llama-3.1-70b-versatile';
    case 'openrouter':
      return 'openai/gpt-5-mini';
    case 'azure':
      return 'gpt-4o';
    case 'codex':
      return 'gpt-5.5';
    case 'mistral':
      return 'mistral-large-latest';
    case 'cerebras':
      return 'llama3.1-8b';
    case 'vercel':
      return 'openai/gpt-5-mini';
    case 'oci':
      return null;
    case 'aws-anthropic':
      return 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    case 'ollama':
      return process.env.OLLAMA_MODEL || 'qwen2.5:latest';
    case 'browser-use':
      return 'bu-latest';
    case 'aws':
      return null;
    default:
      return null;
  }
};

const createLlmForProvider = (
  provider: CliModelProvider,
  model: string
): BaseChatModel => {
  switch (provider) {
    case 'openai':
      return new ChatOpenAI({
        model,
        apiKey: requireEnv('OPENAI_API_KEY'),
      });
    case 'anthropic':
      return new ChatAnthropic({
        model,
        apiKey: requireEnv('ANTHROPIC_API_KEY'),
      });
    case 'google':
      requireEnv('GOOGLE_API_KEY');
      return new ChatGoogle(model);
    case 'deepseek':
      requireEnv('DEEPSEEK_API_KEY');
      return new ChatDeepSeek(model);
    case 'groq':
      requireEnv('GROQ_API_KEY');
      return new ChatGroq(model);
    case 'openrouter':
      requireEnv('OPENROUTER_API_KEY');
      return new ChatOpenRouter(model);
    case 'azure':
      requireEnv('AZURE_OPENAI_API_KEY');
      requireEnv('AZURE_OPENAI_ENDPOINT');
      return new ChatAzure(model);
    case 'codex':
      return new ChatCodex({ model });
    case 'mistral':
      return new ChatMistral({
        model,
        apiKey: requireEnv('MISTRAL_API_KEY'),
        baseURL: process.env.MISTRAL_BASE_URL,
      });
    case 'cerebras':
      return new ChatCerebras({
        model,
        apiKey: requireEnv('CEREBRAS_API_KEY'),
        baseURL: process.env.CEREBRAS_BASE_URL,
      });
    case 'vercel':
      return new ChatVercel({
        model,
        apiKey: requireEnv('VERCEL_API_KEY'),
        baseURL: process.env.VERCEL_BASE_URL,
      });
    case 'oci':
      return new ChatOCIRaw({
        model,
      });
    case 'ollama': {
      const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
      return new ChatOllama(model, host);
    }
    case 'browser-use':
      return new ChatBrowserUse({
        model,
        apiKey: requireEnv('BROWSER_USE_API_KEY'),
      });
    case 'aws-anthropic':
      return new ChatAnthropicBedrock({
        model,
        region: process.env.AWS_REGION || 'us-east-1',
      });
    case 'aws':
      return new ChatBedrockConverse(
        model,
        process.env.AWS_REGION || 'us-east-1'
      );
    default:
      throw new Error(`Unsupported provider "${provider}"`);
  }
};

export const getLlmFromCliArgs = (args: ParsedCliArgs): BaseChatModel => {
  if (args.model) {
    const inferredProvider = inferProviderFromModel(args.model);
    if (
      args.provider &&
      inferredProvider &&
      !providersAreCompatible(args.provider, inferredProvider)
    ) {
      throw new Error(
        `Provider mismatch: --provider ${args.provider} conflicts with model "${args.model}" (inferred: ${inferredProvider}).`
      );
    }

    const provider = args.provider ?? inferredProvider;
    if (!provider) {
      throw new Error(
        `Cannot infer provider from model "${args.model}". Provide --provider or use a supported model prefix: gpt*/o*, claude*, gemini*, deepseek*, groq:, openrouter:, azure:, codex:, mistral:, cerebras:, vercel:, oci:, ollama:, browser-use:, bu-*, bedrock:.`
      );
    }
    const normalizedModel = normalizeModelValue(args.model, provider);
    return createLlmForProvider(provider, normalizedModel);
  }

  if (args.provider) {
    const defaultModel = getDefaultModelForProvider(args.provider);
    if (!defaultModel) {
      throw new Error(
        `Provider "${args.provider}" requires --model. Example: --provider aws --model bedrock:us.amazon.nova-lite-v1:0`
      );
    }
    return createLlmForProvider(args.provider, defaultModel);
  }

  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      model: 'gpt-5-mini',
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new ChatAnthropic({
      model: 'claude-4-sonnet',
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  if (process.env.GOOGLE_API_KEY) {
    return new ChatGoogle('gemini-2.5-pro');
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return new ChatDeepSeek('deepseek-chat');
  }
  if (process.env.GROQ_API_KEY) {
    return new ChatGroq('llama-3.1-70b-versatile');
  }
  if (process.env.OPENROUTER_API_KEY) {
    return new ChatOpenRouter('openai/gpt-5-mini');
  }
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
    return new ChatAzure('gpt-4o');
  }
  if (process.env.MISTRAL_API_KEY) {
    return new ChatMistral({
      model: 'mistral-large-latest',
      apiKey: process.env.MISTRAL_API_KEY,
      baseURL: process.env.MISTRAL_BASE_URL,
    });
  }
  if (process.env.CEREBRAS_API_KEY) {
    return new ChatCerebras({
      model: 'llama3.1-8b',
      apiKey: process.env.CEREBRAS_API_KEY,
      baseURL: process.env.CEREBRAS_BASE_URL,
    });
  }
  if (process.env.VERCEL_API_KEY) {
    return new ChatVercel({
      model: 'openai/gpt-5-mini',
      apiKey: process.env.VERCEL_API_KEY,
      baseURL: process.env.VERCEL_BASE_URL,
    });
  }
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
    return new ChatAnthropicBedrock({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  return new ChatOllama(
    process.env.OLLAMA_MODEL || 'qwen2.5:latest',
    process.env.OLLAMA_HOST || 'http://localhost:11434'
  );
};

const parseCommaSeparatedList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const buildBrowserProfileFromCliArgs = (
  args: ParsedCliArgs
): BrowserProfile | null => {
  const profile: Partial<BrowserProfileOptions> = {};

  if (args.headless !== null) {
    profile.headless = args.headless;
  }
  if (args.window_width !== null) {
    profile.window_width = args.window_width;
  }
  if (args.window_height !== null) {
    profile.window_height = args.window_height;
  }
  if (args.user_data_dir) {
    profile.user_data_dir = args.user_data_dir;
  }
  if (args.profile_directory) {
    profile.profile_directory = args.profile_directory;
  }
  if (args.allowed_domains && args.allowed_domains.length > 0) {
    profile.allowed_domains = args.allowed_domains;
  }
  if (
    args.proxy_url ||
    args.no_proxy ||
    args.proxy_username ||
    args.proxy_password
  ) {
    const proxy: Record<string, string> = {};
    if (args.proxy_url) {
      proxy.server = args.proxy_url;
    }
    if (args.no_proxy) {
      proxy.bypass = parseCommaSeparatedList(args.no_proxy).join(',');
    }
    if (args.proxy_username) {
      proxy.username = args.proxy_username;
    }
    if (args.proxy_password) {
      proxy.password = args.proxy_password;
    }
    profile.proxy = proxy as BrowserProfileOptions['proxy'];
  }

  if (Object.keys(profile).length === 0) {
    return null;
  }
  return new BrowserProfile(profile);
};

interface RunAgentTaskOptions {
  task: string;
  llm: BaseChatModel;
  browserProfile?: BrowserProfile | null;
  browserSession?: BrowserSession | null;
  sessionAttachmentMode?: 'copy' | 'strict' | 'shared';
}

const runAgentTask = async ({
  task,
  llm,
  browserProfile,
  browserSession,
  sessionAttachmentMode,
}: RunAgentTaskOptions): Promise<void> => {
  const { Agent } = await import('./agent/service.js');
  const agent = new Agent({
    task,
    llm,
    ...(browserProfile ? { browser_profile: browserProfile } : {}),
    ...(browserSession ? { browser_session: browserSession } : {}),
    ...(sessionAttachmentMode
      ? { session_attachment_mode: sessionAttachmentMode }
      : {}),
    source: 'cli',
  });
  await agent.run();
};

const runInteractiveMode = async (
  args: ParsedCliArgs,
  llm: BaseChatModel
): Promise<void> => {
  const historyPath = getCliHistoryPath();
  const history = await loadCliHistory(historyPath);
  const browserProfile =
    buildBrowserProfileFromCliArgs(args) ?? new BrowserProfile();
  browserProfile.keep_alive = true;

  const browserSession = new BrowserSession({
    browser_profile: browserProfile,
    ...(args.cdp_url ? { cdp_url: args.cdp_url } : {}),
  });

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    historySize: CLI_HISTORY_LIMIT,
  });

  if (Array.isArray((rl as any).history) && history.length > 0) {
    (rl as any).history = [...history].reverse();
  }

  console.log('Interactive mode started. Type a task and press Enter.');
  console.log('Commands: help, exit');

  try {
    while (true) {
      const line = await rl.question('browser-use> ');
      const task = line.trim();

      if (!task) {
        continue;
      }

      if (isInteractiveExitCommand(task)) {
        break;
      }

      if (isInteractiveHelpCommand(task)) {
        console.log('Type any task to run it. Use "exit" to quit.');
        continue;
      }

      history.push(task);
      await saveCliHistory(history, historyPath);

      console.log(`Starting task: ${task}`);
      try {
        await runAgentTask({
          task,
          llm,
          browserProfile,
          browserSession,
          sessionAttachmentMode: 'strict',
        });
      } catch (error) {
        console.error('Error running agent:', error);
      }
    }
  } finally {
    rl.close();
    await saveCliHistory(history, historyPath);

    try {
      if ((browserSession as any)._owns_browser_resources) {
        await browserSession.kill();
      } else {
        await browserSession.stop();
      }
    } catch (error) {
      console.error(
        `Warning: failed to close interactive browser session: ${
          (error as Error).message
        }`
      );
    }
  }
};

const resolvePlaywrightCliPath = () => require.resolve('playwright/cli');

export interface RunInstallCommandOptions {
  playwright_cli_path?: string;
  spawn_impl?: typeof spawnSync;
}

type WritableLike = {
  write(chunk: string): unknown;
};

export interface RunTunnelCommandOptions {
  manager?: Pick<
    ReturnType<typeof get_tunnel_manager>,
    'start_tunnel' | 'list_tunnels' | 'stop_tunnel' | 'stop_all_tunnels'
  >;
  stdout?: WritableLike;
  stderr?: WritableLike;
  json_output?: boolean;
}

type CliSetupMode = 'local' | 'remote' | 'full';

export interface RunSetupCommandOptions {
  run_doctor_checks?: (
    options?: RunDoctorChecksOptions
  ) => Promise<CliDoctorReport>;
  install_command?: () => void | Promise<void>;
  save_api_key?: (api_key: string) => void;
  stdout?: WritableLike;
  stderr?: WritableLike;
  json_output?: boolean;
}

export interface RunTaskCommandOptions {
  client?: Pick<
    CloudManagementClient,
    'list_tasks' | 'get_task' | 'update_task' | 'get_task_logs'
  >;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

export interface RunSessionCommandOptions {
  client?: Pick<
    CloudManagementClient,
    | 'list_sessions'
    | 'get_session'
    | 'update_session'
    | 'create_session'
    | 'create_session_public_share'
    | 'delete_session_public_share'
  >;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

export interface RunProfileCommandOptions {
  client?: Pick<
    CloudManagementClient,
    | 'list_profiles'
    | 'get_profile'
    | 'create_profile'
    | 'update_profile'
    | 'delete_profile'
  >;
  profile_lister?: () => Array<{
    directory: string;
    name: string;
    email?: string;
  }>;
  local_session_factory?: (profile_directory: string) => {
    start: () => Promise<unknown>;
    stop?: () => Promise<void>;
    get_cookies?: () => Promise<BrowserCookieInit[]>;
  };
  remote_session_factory?: (init: { cdp_url: string }) => {
    start: () => Promise<unknown>;
    stop?: () => Promise<void>;
    browser_context?: {
      addCookies?: (cookies: BrowserCookieInit[]) => Promise<unknown>;
    } | null;
  };
  cloud_browser_client_factory?: () => Pick<
    CloudBrowserClient,
    'create_browser' | 'stop_browser'
  >;
  stdout?: WritableLike;
  stderr?: WritableLike;
}

export interface RunCloudTaskCommandOptions {
  client?: Pick<
    CloudManagementClient,
    'create_task' | 'create_session' | 'get_task' | 'update_session'
  >;
  stdout?: WritableLike;
  stderr?: WritableLike;
  sleep_impl?: (ms: number) => Promise<void>;
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

export const runInstallCommand = (options: RunInstallCommandOptions = {}) => {
  const playwrightCliPath =
    options.playwright_cli_path ?? resolvePlaywrightCliPath();
  const spawnImpl = options.spawn_impl ?? spawnSync;
  const result = spawnImpl(
    process.execPath,
    [playwrightCliPath, 'install', 'chromium'],
    {
      stdio: 'inherit',
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Playwright browser install failed with exit code ${result.status ?? 1}`
    );
  }
};

const writeLine = (stream: WritableLike, value: string) => {
  stream.write(`${value}\n`);
};

export interface RunAuthCommandOptions {
  stdout?: WritableLike;
  stderr?: WritableLike;
  json_output?: boolean;
  configDir?: string | null;
  authStorePath?: string | null;
  login_device_code?: typeof loginAndSaveCodexDeviceCode;
  import_codex_cli?: typeof saveImportedCodexCliTokens;
}

const formatCodexAuthStatus = (status: CodexAuthStatus) => {
  if (!status.authenticated) {
    return [
      'Codex auth: not authenticated',
      `Auth store: ${status.auth_store_path}`,
      'Run `browser-use auth codex login` to authenticate.',
    ].join('\n');
  }

  return [
    'Codex auth: authenticated',
    `Provider: ${status.provider}`,
    `Base URL: ${status.base_url}`,
    `Source: ${status.source ?? 'unknown'}`,
    `Last refresh: ${status.last_refresh ?? 'unknown'}`,
    `Access token expiring: ${String(status.access_token_expiring)}`,
    `Auth store: ${status.auth_store_path}`,
  ].join('\n');
};

const parseCodexAuthArgs = (argv: string[]) => {
  const flags = {
    json: false,
    force: false,
    importFromCodexCli: false,
    parts: [] as string[],
  };

  for (const arg of argv) {
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--force') {
      flags.force = true;
      continue;
    }
    if (arg === '--import') {
      flags.importFromCodexCli = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown auth option: ${arg}`);
    }
    flags.parts.push(arg);
  }

  return flags;
};

export const runAuthCommand = async (
  argv: string[],
  options: RunAuthCommandOptions = {}
) => {
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const loginDeviceCode =
    options.login_device_code ?? loginAndSaveCodexDeviceCode;
  const importCodexCli = options.import_codex_cli ?? saveImportedCodexCliTokens;

  try {
    const flags = parseCodexAuthArgs(argv);
    const jsonOutput = options.json_output ?? flags.json;
    const provider = flags.parts[0] ?? 'codex';
    const action =
      flags.parts[1] ?? (flags.importFromCodexCli ? 'import' : 'status');

    if (provider !== 'codex' && provider !== 'openai-codex') {
      throw new Error(
        'Usage: browser-use auth codex <login|status|logout|import>'
      );
    }

    const authOptions = {
      configDir: options.configDir,
      authStorePath: options.authStorePath,
    };

    if (action === 'status') {
      const status = await getCodexAuthStatus(authOptions);
      if (jsonOutput) {
        writeLine(output, JSON.stringify(status, null, 2));
      } else {
        writeLine(output, formatCodexAuthStatus(status));
      }
      return status.authenticated ? 0 : 1;
    }

    if (action === 'logout') {
      await clearCodexTokens(authOptions);
      const status = await getCodexAuthStatus(authOptions);
      if (jsonOutput) {
        writeLine(output, JSON.stringify(status, null, 2));
      } else {
        writeLine(output, 'Codex auth cleared from browser-use auth store.');
      }
      return 0;
    }

    if (action === 'import' || flags.importFromCodexCli) {
      const imported = await importCodexCli(authOptions);
      if (!imported) {
        writeLine(
          errorOutput,
          'No valid Codex CLI credentials found. Run `browser-use auth codex login` for a separate browser-use session.'
        );
        return 1;
      }
      const status = await getCodexAuthStatus(authOptions);
      if (jsonOutput) {
        writeLine(output, JSON.stringify(status, null, 2));
      } else {
        writeLine(
          output,
          'Imported Codex CLI credentials into browser-use auth store.'
        );
        writeLine(
          output,
          'browser-use will refresh its own copy and will not write ~/.codex/auth.json.'
        );
        writeLine(
          output,
          'For the cleanest separation from Codex CLI, prefer `browser-use auth codex login --force`.'
        );
      }
      return 0;
    }

    if (action === 'login') {
      if (!flags.force) {
        const status = await getCodexAuthStatus(authOptions);
        if (status.authenticated) {
          if (jsonOutput) {
            writeLine(output, JSON.stringify(status, null, 2));
          } else {
            writeLine(output, 'Existing browser-use Codex credentials found.');
            writeLine(
              output,
              'Use `browser-use auth codex login --force` to create a fresh session.'
            );
          }
          return 0;
        }
      }

      await loginDeviceCode({
        ...authOptions,
        stdout: (jsonOutput ? errorOutput : output) as NodeJS.WriteStream,
      });
      const status = await getCodexAuthStatus(authOptions);
      if (jsonOutput) {
        writeLine(output, JSON.stringify(status, null, 2));
      } else {
        writeLine(output, 'Codex login successful.');
        writeLine(output, `Auth store: ${status.auth_store_path}`);
      }
      return 0;
    }

    throw new Error(
      'Usage: browser-use auth codex <login|status|logout|import>'
    );
  } catch (error) {
    writeLine(errorOutput, `Error: ${(error as Error).message}`);
    return 1;
  }
};

const parseTunnelPort = (value: string | undefined | null) => {
  const raw = String(value ?? '').trim();
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !isValidTunnelPort(port)) {
    throw new Error(`Invalid port: ${value ?? ''}`);
  }
  return port;
};

export const runTunnelCommand = async (
  argv: string[],
  options: RunTunnelCommandOptions = {}
) => {
  const manager = options.manager ?? get_tunnel_manager();
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const json_output = Boolean(options.json_output);

  const render = (value: unknown) => {
    if (json_output) {
      writeLine(output, JSON.stringify(value, null, 2));
    }
  };

  try {
    const first = argv[0] ?? null;

    if (!first) {
      writeLine(
        errorOutput,
        'Usage: browser-use tunnel <port> | list | stop <port> | stop --all'
      );
      return 1;
    }

    if (first === 'list') {
      const result = manager.list_tunnels();
      if (json_output) {
        render(result);
      } else if (result.tunnels.length > 0) {
        for (const tunnel of result.tunnels) {
          const ownershipNote =
            tunnel.ownership === 'unverified'
              ? ' (ownership unverified; state retained)'
              : '';
          writeLine(output, `${tunnel.port}: ${tunnel.url}${ownershipNote}`);
        }
      } else {
        writeLine(output, 'No active tunnels');
      }
      return 0;
    }

    if (first === 'stop' || first === 'stop-all') {
      const stopAll = first === 'stop-all' || argv.includes('--all');
      if (stopAll) {
        const result = await manager.stop_all_tunnels();
        if (json_output) {
          render(result);
        } else if (result.count > 0) {
          writeLine(
            output,
            `Stopped ${result.count} tunnel(s): ${result.stopped.join(', ')}`
          );
        } else {
          writeLine(output, 'No tunnels to stop');
        }
        return 0;
      }

      const port = parseTunnelPort(argv[1]);
      const result = await manager.stop_tunnel(port);
      if ('error' in result) {
        writeLine(errorOutput, result.error);
        return 1;
      }
      if (json_output) {
        render(result);
      } else {
        writeLine(output, `Stopped tunnel on port ${result.stopped}`);
      }
      return 0;
    }

    const port = parseTunnelPort(first);
    const result = await manager.start_tunnel(port);
    if ('error' in result) {
      writeLine(errorOutput, result.error);
      return 1;
    }
    if (json_output) {
      render(result);
    } else if (result.existing) {
      writeLine(
        output,
        `Tunnel already running: http://localhost:${result.port} -> ${result.url}`
      );
    } else {
      writeLine(
        output,
        `Tunnel started: http://localhost:${result.port} -> ${result.url}`
      );
    }
    return 0;
  } catch (error) {
    writeLine(errorOutput, (error as Error).message);
    return 1;
  }
};

type PlannedSetupAction =
  | { type: 'install_browser'; description: string; required: boolean }
  | {
      type: 'configure_api_key';
      description: string;
      required: boolean;
      api_key: string;
    }
  | { type: 'prompt_api_key'; description: string; required: boolean }
  | { type: 'install_cloudflared'; description: string; required: boolean };

const validateSetupMode = (mode: string | null | undefined): CliSetupMode => {
  const normalized = (mode ?? 'local').trim().toLowerCase();
  if (
    normalized === 'local' ||
    normalized === 'remote' ||
    normalized === 'full'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid setup mode "${mode ?? ''}". Expected local, remote, or full.`
  );
};

const renderSetupChecks = (
  mode: CliSetupMode,
  report: CliDoctorReport
): Record<string, CliDoctorCheck> => {
  const checks: Record<string, CliDoctorCheck> = {
    browser_use_package: report.checks.package,
  };
  if (mode === 'local' || mode === 'full') {
    checks.browser = report.checks.browser;
  }
  if (mode === 'remote' || mode === 'full') {
    checks.api_key = report.checks.api_key;
    checks.cloudflared = report.checks.cloudflared;
  }
  return checks;
};

const planSetupActions = (
  mode: CliSetupMode,
  checks: Record<string, CliDoctorCheck>,
  yes: boolean,
  api_key: string | null
): PlannedSetupAction[] => {
  const actions: PlannedSetupAction[] = [];

  if (
    (mode === 'local' || mode === 'full') &&
    checks.browser?.status !== 'ok'
  ) {
    actions.push({
      type: 'install_browser',
      description: 'Install browser (Chromium)',
      required: true,
    });
  }

  if (
    (mode === 'remote' || mode === 'full') &&
    checks.api_key?.status !== 'ok'
  ) {
    if (api_key?.trim()) {
      actions.push({
        type: 'configure_api_key',
        description: 'Configure API key',
        required: true,
        api_key: api_key.trim(),
      });
    } else if (!yes) {
      actions.push({
        type: 'prompt_api_key',
        description: 'Prompt for API key',
        required: false,
      });
    }
  }

  if (
    (mode === 'remote' || mode === 'full') &&
    checks.cloudflared?.status !== 'ok'
  ) {
    actions.push({
      type: 'install_cloudflared',
      description: 'Install cloudflared (for tunneling)',
      required: true,
    });
  }

  return actions;
};

const logSetupChecks = (
  stream: WritableLike,
  checks: Record<string, CliDoctorCheck>
) => {
  writeLine(stream, '');
  writeLine(stream, 'Running checks...');
  writeLine(stream, '');
  for (const [name, check] of Object.entries(checks)) {
    const icon =
      check.status === 'ok' ? '✓' : check.status === 'missing' ? '⚠' : '✗';
    writeLine(stream, `  ${icon} ${name.replace(/_/g, ' ')}: ${check.message}`);
  }
  writeLine(stream, '');
};

const logSetupActions = (
  stream: WritableLike,
  actions: PlannedSetupAction[]
) => {
  if (actions.length === 0) {
    writeLine(stream, 'No additional setup needed.');
    writeLine(stream, '');
    return;
  }

  writeLine(stream, '');
  writeLine(stream, 'Setup actions:');
  writeLine(stream, '');
  actions.forEach((action, index) => {
    writeLine(
      stream,
      `  ${index + 1}. ${action.description} ${action.required ? '(required)' : '(optional)'}`
    );
  });
  writeLine(stream, '');
};

const logSetupValidation = (
  stream: WritableLike,
  validation: Record<string, string | boolean>
) => {
  writeLine(stream, '');
  writeLine(stream, 'Validation:');
  writeLine(stream, '');
  for (const [name, result] of Object.entries(validation)) {
    const normalized = String(result);
    const ok = normalized === 'ok' || normalized === 'true';
    writeLine(
      stream,
      `  ${ok ? '✓' : '✗'} ${name.replace(/_/g, ' ')}: ${normalized}`
    );
  }
  writeLine(stream, '');
};

export const runSetupCommand = async (
  params: {
    mode?: string | null;
    yes?: boolean;
    api_key?: string | null;
  },
  options: RunSetupCommandOptions = {}
) => {
  const mode = validateSetupMode(params.mode);
  const yes = Boolean(params.yes);
  const api_key = params.api_key?.trim() || null;
  const runDoctor =
    options.run_doctor_checks ??
    ((doctorOptions?: RunDoctorChecksOptions) =>
      runDoctorChecks(doctorOptions));
  const installCommand = options.install_command ?? runInstallCommand;
  const saveApiKey = options.save_api_key ?? save_cloud_api_token;
  const output = options.stdout ?? process.stdout;
  const json_output = Boolean(options.json_output);

  const initialReport = await runDoctor();
  const checks = renderSetupChecks(mode, initialReport);
  const actions = planSetupActions(mode, checks, yes, api_key);

  if (!json_output) {
    logSetupChecks(output, checks);
    logSetupActions(output, actions);
  }

  for (const action of actions) {
    if (action.type === 'install_browser') {
      if (!json_output) {
        writeLine(output, 'Installing Chromium browser...');
      }
      await installCommand();
      continue;
    }

    if (action.type === 'configure_api_key') {
      if (!json_output) {
        writeLine(output, 'Configuring API key...');
      }
      saveApiKey(action.api_key);
      continue;
    }

    if (action.type === 'prompt_api_key' && !json_output) {
      writeLine(output, 'API key not configured');
      writeLine(output, '  Set via: export BROWSER_USE_API_KEY=your_key');
      writeLine(output, '  Or: browser-use setup --api-key <key>');
      continue;
    }

    if (action.type === 'install_cloudflared' && !json_output) {
      writeLine(output, 'cloudflared not installed');
      writeLine(output, '  Install via:');
      writeLine(output, '  macOS:   brew install cloudflared');
      writeLine(
        output,
        '  Linux:   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared'
      );
      writeLine(output, '  Windows: winget install Cloudflare.cloudflared');
      writeLine(output, '');
    }
  }

  const validationReport = await runDoctor();
  const validation: Record<string, string | boolean> = {
    browser_use_import: 'ok',
  };
  if (mode === 'local' || mode === 'full') {
    validation.browser_available =
      validationReport.checks.browser.status === 'ok'
        ? 'ok'
        : `failed: ${validationReport.checks.browser.message}`;
  }
  if (mode === 'remote' || mode === 'full') {
    validation.api_key_available =
      validationReport.checks.api_key.status === 'ok';
    validation.cloudflared_available =
      validationReport.checks.cloudflared.status === 'ok';
  }

  const result = {
    status: 'success' as const,
    mode,
    checks,
    validation,
  };

  if (json_output) {
    writeLine(output, JSON.stringify(result, null, 2));
  } else {
    logSetupValidation(output, validation);
  }

  return 0;
};

const formatDuration = (
  startedAt?: string | null,
  finishedAt?: string | null
) => {
  if (!startedAt) {
    return '';
  }

  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '';
  }

  const totalSeconds = Math.floor((end - start) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
};

const printTaskStep = (
  stream: WritableLike,
  step: Record<string, unknown>,
  verbose: boolean
) => {
  const stepNumber = step.number ?? '?';
  const memory = String(step.memory ?? '');
  if (verbose) {
    const url = String(step.url ?? '');
    const shortUrl = url.length > 60 ? `${url.slice(0, 57)}...` : url;
    writeLine(stream, `  [${stepNumber}] ${shortUrl}`);
    if (memory) {
      const shortMemory =
        memory.length > 100 ? `${memory.slice(0, 97)}...` : memory;
      writeLine(stream, `      Reasoning: ${shortMemory}`);
    }
    const actions = Array.isArray(step.actions) ? step.actions : [];
    actions.slice(0, 2).forEach((action) => {
      const text = String(action);
      const shortAction = text.length > 70 ? `${text.slice(0, 67)}...` : text;
      writeLine(stream, `      Action: ${shortAction}`);
    });
    if (actions.length > 2) {
      writeLine(stream, `      ... and ${actions.length - 2} more actions`);
    }
    return;
  }

  const shortMemory = memory
    ? memory.length > 80
      ? `${memory.slice(0, 77)}...`
      : memory
    : '(no reasoning)';
  writeLine(stream, `  ${stepNumber}. ${shortMemory}`);
};

const requireCommandTarget = (
  value: string | undefined,
  usage: string
): string => {
  const target = value?.trim();
  if (!target || target.startsWith('-')) {
    throw new Error(usage);
  }
  return target;
};

const rejectUnexpectedPositionals = (positionals: string[], usage: string) => {
  if (positionals.length > 0) {
    throw new Error(usage);
  }
};

const markUsedOption = (used_options: string[], option: string) => {
  if (!used_options.includes(option)) {
    used_options.push(option);
  }
};

const rejectUnsupportedFlags = (
  used_options: string[],
  allowed_options: string[],
  usage: string
) => {
  const allowed = new Set(allowed_options);
  const unsupported = used_options.find((option) => !allowed.has(option));
  if (unsupported) {
    throw new Error(usage);
  }
};

const parseTaskCommandFlags = (argv: string[]) => {
  const flags = {
    json: false,
    limit: 10,
    status: null as string | null,
    session: null as string | null,
    compact: false,
    verbose: false,
    last: null as number | null,
    reverse: false,
    step: null as number | null,
    positionals: [] as string[],
    used_options: [] as string[],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') {
      flags.json = true;
      markUsedOption(flags.used_options, '--json');
      continue;
    }
    if (arg === '--compact' || arg === '-c') {
      flags.compact = true;
      markUsedOption(flags.used_options, '--compact');
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      flags.verbose = true;
      markUsedOption(flags.used_options, '--verbose');
      continue;
    }
    if (arg === '--reverse' || arg === '-r') {
      flags.reverse = true;
      markUsedOption(flags.used_options, '--reverse');
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.limit = parsePositiveInt('--limit', value);
      markUsedOption(flags.used_options, '--limit');
      index = nextIndex;
      continue;
    }
    if (arg === '--status' || arg.startsWith('--status=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.status = value;
      markUsedOption(flags.used_options, '--status');
      index = nextIndex;
      continue;
    }
    if (arg === '--session' || arg.startsWith('--session=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.session = value;
      markUsedOption(flags.used_options, '--session');
      index = nextIndex;
      continue;
    }
    if (arg === '--last' || arg === '-n' || arg.startsWith('--last=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.last = parsePositiveInt('--last', value);
      markUsedOption(flags.used_options, '--last');
      index = nextIndex;
      continue;
    }
    if (arg === '--step' || arg === '-s' || arg.startsWith('--step=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.step = parsePositiveInt('--step', value);
      markUsedOption(flags.used_options, '--step');
      index = nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    flags.positionals.push(arg);
  }

  return flags;
};

export const runTaskCommand = async (
  argv: string[],
  options: RunTaskCommandOptions = {}
) => {
  const client = options.client ?? new CloudManagementClient();
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const subcommand = argv[0] ?? '';

  try {
    if (subcommand === 'list') {
      const flags = parseTaskCommandFlags(argv.slice(1));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use task list [options]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--limit', '--status', '--session'],
        'Usage: browser-use task list [options]'
      );
      const result = await client.list_tasks({
        pageSize: flags.limit,
        filterBy: flags.status,
        sessionId: flags.session,
      });
      if (flags.json) {
        writeLine(output, JSON.stringify(result.items, null, 2));
        return 0;
      }
      if (result.items.length === 0) {
        writeLine(output, 'No tasks found');
        return 0;
      }
      writeLine(output, `Tasks (${result.items.length}):`);
      for (const task of result.items) {
        const emoji =
          {
            created: '🕒',
            started: '🔄',
            running: '🔄',
            finished: '✅',
            stopped: '⏹️',
            failed: '❌',
          }[task.status] ?? '❓';
        const text =
          task.task.length > 50 ? `${task.task.slice(0, 47)}...` : task.task;
        writeLine(
          output,
          `  ${emoji} ${task.id.slice(0, 8)}... [${task.status}] ${text}`
        );
      }
      return 0;
    }

    if (subcommand === 'status') {
      const taskId = requireCommandTarget(
        argv[1],
        'Usage: browser-use task status <task-id>'
      );
      const flags = parseTaskCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use task status <task-id>'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--compact', '--verbose', '--reverse', '--last', '--step'],
        'Usage: browser-use task status <task-id>'
      );
      const task = await client.get_task(taskId);
      if (flags.json) {
        writeLine(output, JSON.stringify(task, null, 2));
        return 0;
      }

      const parts = [
        `${
          {
            created: '🕒',
            started: '🔄',
            running: '🔄',
            finished: '✅',
            stopped: '⏹️',
            failed: '❌',
          }[task.status] ?? '❓'
        } ${task.id.slice(0, 8)}... [${task.status}]`,
      ];
      const duration = formatDuration(task.startedAt, task.finishedAt);
      if (duration) {
        parts.push(duration);
      }
      writeLine(output, parts.join(' '));

      let steps = [...(task.steps ?? [])];
      const showAllSteps = flags.compact || flags.verbose;
      if (flags.step !== null) {
        steps = steps.filter((step) => Number(step.number) === flags.step);
      } else if (!showAllSteps && steps.length > 1) {
        writeLine(output, `  ... ${steps.length - 1} earlier steps`);
        steps = [steps[steps.length - 1]!];
      } else if (flags.last !== null && flags.last < steps.length) {
        writeLine(output, `  ... ${steps.length - flags.last} earlier steps`);
        steps = steps.slice(-flags.last);
      }
      if (flags.reverse) {
        steps.reverse();
      }
      steps.forEach((step) => printTaskStep(output, step, flags.verbose));

      if (task.output) {
        writeLine(output, '');
        writeLine(output, `Output: ${task.output}`);
      }
      return 0;
    }

    if (subcommand === 'stop') {
      const taskId = requireCommandTarget(
        argv[1],
        'Usage: browser-use task stop <task-id>'
      );
      const flags = parseTaskCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use task stop <task-id>'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json'],
        'Usage: browser-use task stop <task-id>'
      );
      await client.update_task(taskId, 'stop');
      if (flags.json) {
        writeLine(output, JSON.stringify({ stopped: taskId }, null, 2));
      } else {
        writeLine(output, `Stopped task: ${taskId}`);
      }
      return 0;
    }

    if (subcommand === 'logs') {
      const taskId = requireCommandTarget(
        argv[1],
        'Usage: browser-use task logs <task-id>'
      );
      const flags = parseTaskCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use task logs <task-id>'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json'],
        'Usage: browser-use task logs <task-id>'
      );
      const result = await client.get_task_logs(taskId);
      if (flags.json) {
        writeLine(output, JSON.stringify(result, null, 2));
      } else if (result.downloadUrl) {
        writeLine(output, `Download logs: ${result.downloadUrl}`);
      } else {
        writeLine(output, 'No logs available for this task');
      }
      return 0;
    }

    writeLine(
      errorOutput,
      'Usage: browser-use task <list|status|stop|logs> [options]'
    );
    return 1;
  } catch (error) {
    writeLine(errorOutput, `Error: ${(error as Error).message}`);
    return 1;
  }
};

const parseSessionCommandFlags = (argv: string[]) => {
  const flags = {
    json: false,
    limit: 10,
    status: null as string | null,
    all: false,
    delete: false,
    profile: null as string | null,
    proxy_country: null as string | null,
    start_url: null as string | null,
    screen_size: null as string | null,
    positionals: [] as string[],
    used_options: [] as string[],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') {
      flags.json = true;
      markUsedOption(flags.used_options, '--json');
      continue;
    }
    if (arg === '--all') {
      flags.all = true;
      markUsedOption(flags.used_options, '--all');
      continue;
    }
    if (arg === '--delete') {
      flags.delete = true;
      markUsedOption(flags.used_options, '--delete');
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.limit = parsePositiveInt('--limit', value);
      markUsedOption(flags.used_options, '--limit');
      index = nextIndex;
      continue;
    }
    if (arg === '--status' || arg.startsWith('--status=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.status = value;
      markUsedOption(flags.used_options, '--status');
      index = nextIndex;
      continue;
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.profile = value;
      markUsedOption(flags.used_options, '--profile');
      index = nextIndex;
      continue;
    }
    if (arg === '--proxy-country' || arg.startsWith('--proxy-country=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.proxy_country = value;
      markUsedOption(flags.used_options, '--proxy-country');
      index = nextIndex;
      continue;
    }
    if (arg === '--start-url' || arg.startsWith('--start-url=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.start_url = value;
      markUsedOption(flags.used_options, '--start-url');
      index = nextIndex;
      continue;
    }
    if (arg === '--screen-size' || arg.startsWith('--screen-size=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.screen_size = value;
      markUsedOption(flags.used_options, '--screen-size');
      index = nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    flags.positionals.push(arg);
  }

  return flags;
};

export const runSessionCommand = async (
  argv: string[],
  options: RunSessionCommandOptions = {}
) => {
  const client = options.client ?? new CloudManagementClient();
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const subcommand = argv[0] ?? '';

  try {
    if (subcommand === 'list') {
      const flags = parseSessionCommandFlags(argv.slice(1));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use session list [options]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--limit', '--status'],
        'Usage: browser-use session list [options]'
      );
      const result = await client.list_sessions({
        pageSize: flags.limit,
        filterBy: flags.status,
      });
      if (flags.json) {
        writeLine(output, JSON.stringify(result.items, null, 2));
        return 0;
      }
      if (result.items.length === 0) {
        writeLine(output, 'No sessions found');
        return 0;
      }
      writeLine(output, `Sessions (${result.items.length}):`);
      for (const session of result.items) {
        const emoji = session.status === 'active' ? '🟢' : '⏹️';
        const duration = formatDuration(session.startedAt, session.finishedAt);
        const details = duration ? ` ${duration}` : '';
        writeLine(
          output,
          `  ${emoji} ${session.id.slice(0, 8)}... [${session.status}]${details}`
        );
      }
      return 0;
    }

    if (subcommand === 'get') {
      const sessionId = requireCommandTarget(
        argv[1],
        'Usage: browser-use session get <session-id>'
      );
      const flags = parseSessionCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use session get <session-id>'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json'],
        'Usage: browser-use session get <session-id>'
      );
      const session = await client.get_session(sessionId);
      if (flags.json) {
        writeLine(output, JSON.stringify(session, null, 2));
      } else {
        writeLine(output, `${session.id} [${session.status}]`);
        if (session.liveUrl) {
          writeLine(output, `Live URL: ${session.liveUrl}`);
        }
        const duration = formatDuration(session.startedAt, session.finishedAt);
        if (duration) {
          writeLine(output, `Duration: ${duration}`);
        }
      }
      return 0;
    }

    if (subcommand === 'stop') {
      const flags = parseSessionCommandFlags(argv.slice(1));
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--all'],
        'Usage: browser-use session stop <session-id> | --all'
      );
      if (flags.all) {
        rejectUnexpectedPositionals(
          flags.positionals,
          'Usage: browser-use session stop <session-id> | --all'
        );
        const sessions = await client.list_sessions({
          pageSize: 100,
          filterBy: 'active',
        });
        const stopped: string[] = [];
        for (const session of sessions.items) {
          await client.update_session(session.id, 'stop');
          stopped.push(session.id);
        }
        if (flags.json) {
          writeLine(output, JSON.stringify({ stopped }, null, 2));
        } else if (stopped.length > 0) {
          writeLine(
            output,
            `Stopped ${stopped.length} session(s): ${stopped.join(', ')}`
          );
        } else {
          writeLine(output, 'No sessions to stop');
        }
        return 0;
      }
      const [sessionIdCandidate, ...unexpectedPositionals] = flags.positionals;
      rejectUnexpectedPositionals(
        unexpectedPositionals,
        'Usage: browser-use session stop <session-id> | --all'
      );
      const sessionId = requireCommandTarget(
        sessionIdCandidate ?? argv[1],
        'Usage: browser-use session stop <session-id> | --all'
      );
      await client.update_session(sessionId, 'stop');
      if (flags.json) {
        writeLine(output, JSON.stringify({ stopped: sessionId }, null, 2));
      } else {
        writeLine(output, `Stopped session: ${sessionId}`);
      }
      return 0;
    }

    if (subcommand === 'create') {
      const flags = parseSessionCommandFlags(argv.slice(1));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use session create [options]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        [
          '--json',
          '--profile',
          '--proxy-country',
          '--start-url',
          '--screen-size',
        ],
        'Usage: browser-use session create [options]'
      );
      let browserScreenWidth: number | null = null;
      let browserScreenHeight: number | null = null;
      if (flags.screen_size) {
        const match = flags.screen_size.match(/^(\d+)x(\d+)$/i);
        if (!match) {
          throw new Error('Expected --screen-size WIDTHxHEIGHT');
        }
        browserScreenWidth = parsePositiveInt('--screen-size width', match[1]!);
        browserScreenHeight = parsePositiveInt(
          '--screen-size height',
          match[2]!
        );
      }
      const session = await client.create_session({
        profileId: flags.profile,
        proxyCountryCode: flags.proxy_country,
        startUrl: flags.start_url,
        browserScreenWidth,
        browserScreenHeight,
      });
      if (flags.json) {
        writeLine(output, JSON.stringify(session, null, 2));
      } else {
        writeLine(output, `Created session: ${session.id}`);
        if (session.liveUrl) {
          writeLine(output, `Live URL: ${session.liveUrl}`);
        }
      }
      return 0;
    }

    if (subcommand === 'share') {
      const sessionId = requireCommandTarget(
        argv[1],
        'Usage: browser-use session share <session-id> [--delete]'
      );
      const flags = parseSessionCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use session share <session-id> [--delete]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--delete'],
        'Usage: browser-use session share <session-id> [--delete]'
      );
      if (flags.delete) {
        await client.delete_session_public_share(sessionId);
        if (flags.json) {
          writeLine(output, JSON.stringify({ deleted: sessionId }, null, 2));
        } else {
          writeLine(output, `Deleted public share for session: ${sessionId}`);
        }
      } else {
        const share = await client.create_session_public_share(sessionId);
        if (flags.json) {
          writeLine(output, JSON.stringify(share, null, 2));
        } else {
          writeLine(output, `Public share URL: ${share.shareUrl}`);
        }
      }
      return 0;
    }

    writeLine(
      errorOutput,
      'Usage: browser-use session <list|get|stop|create|share> [options]'
    );
    return 1;
  } catch (error) {
    writeLine(errorOutput, `Error: ${(error as Error).message}`);
    return 1;
  }
};

const parseProfileCommandFlags = (argv: string[]) => {
  const flags = {
    json: false,
    remote: false,
    limit: 20,
    name: null as string | null,
    domain: null as string | null,
    from_profile: null as string | null,
    positionals: [] as string[],
    used_options: [] as string[],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') {
      flags.json = true;
      markUsedOption(flags.used_options, '--json');
      continue;
    }
    if (arg === '--remote') {
      flags.remote = true;
      markUsedOption(flags.used_options, '--remote');
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.limit = parsePositiveInt('--limit', value);
      markUsedOption(flags.used_options, '--limit');
      index = nextIndex;
      continue;
    }
    if (arg === '--name' || arg.startsWith('--name=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.name = value;
      markUsedOption(flags.used_options, '--name');
      index = nextIndex;
      continue;
    }
    if (arg === '--domain' || arg.startsWith('--domain=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.domain = value;
      markUsedOption(flags.used_options, '--domain');
      index = nextIndex;
      continue;
    }
    if (arg === '--from' || arg.startsWith('--from=')) {
      const { value, nextIndex } = takeOptionValue(arg, index, argv);
      flags.from_profile = value;
      markUsedOption(flags.used_options, '--from');
      index = nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    flags.positionals.push(arg);
  }

  return flags;
};

const normalizeProfileCookieDomain = (value: string | null | undefined) =>
  String(value ?? '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();

const cookieMatchesDomainFilter = (
  cookie: Record<string, any>,
  domainFilter: string | null
) => {
  if (!domainFilter) {
    return true;
  }
  const cookieDomain = normalizeProfileCookieDomain(cookie.domain);
  const normalizedFilter = normalizeProfileCookieDomain(domainFilter);
  return Boolean(
    cookieDomain &&
    normalizedFilter &&
    (cookieDomain === normalizedFilter ||
      cookieDomain.endsWith(`.${normalizedFilter}`) ||
      normalizedFilter.endsWith(`.${cookieDomain}`))
  );
};

export const runProfileCommand = async (
  argv: string[],
  options: RunProfileCommandOptions = {}
) => {
  const client = options.client ?? new CloudManagementClient();
  const profileLister =
    options.profile_lister ?? (() => systemChrome.listProfiles());
  const localSessionFactory =
    options.local_session_factory ??
    ((profile_directory: string) =>
      BrowserSession.from_system_chrome({
        profile_directory,
        profile: { headless: true },
      }));
  const remoteSessionFactory =
    options.remote_session_factory ??
    ((init: { cdp_url: string }) =>
      new BrowserSession({
        cdp_url: init.cdp_url,
      }));
  const cloudBrowserClientFactory =
    options.cloud_browser_client_factory ?? (() => new CloudBrowserClient());
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const subcommand = argv[0] ?? '';

  try {
    if (subcommand === 'list') {
      const flags = parseProfileCommandFlags(argv.slice(1));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile list [--remote] [options]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--remote', '--limit'],
        'Usage: browser-use profile list [--remote] [options]'
      );
      if (flags.remote) {
        const result = await client.list_profiles({
          pageSize: flags.limit,
        });
        if (flags.json) {
          writeLine(output, JSON.stringify(result.items, null, 2));
        } else if (result.items.length === 0) {
          writeLine(output, 'No cloud profiles found');
        } else {
          writeLine(output, `Cloud profiles (${result.items.length}):`);
          result.items.forEach((profile) => {
            writeLine(output, `  ${profile.id}: ${profile.name || 'Unnamed'}`);
          });
        }
        return 0;
      }

      const profiles = profileLister();
      if (flags.json) {
        writeLine(output, JSON.stringify({ profiles }, null, 2));
      } else if (profiles.length === 0) {
        writeLine(output, 'No Chrome profiles found');
      } else {
        writeLine(output, 'Local Chrome profiles:');
        profiles.forEach((profile) => {
          const emailSuffix = profile.email ? ` (${profile.email})` : '';
          writeLine(
            output,
            `  ${profile.directory}: ${profile.name}${emailSuffix}`
          );
        });
      }
      return 0;
    }

    if (subcommand === 'get') {
      const profileId = requireCommandTarget(
        argv[1],
        'Usage: browser-use profile get <profile-id> [--remote]'
      );
      const flags = parseProfileCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile get <profile-id> [--remote]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--remote'],
        'Usage: browser-use profile get <profile-id> [--remote]'
      );
      if (flags.remote) {
        const profile = await client.get_profile(profileId);
        if (flags.json) {
          writeLine(output, JSON.stringify(profile, null, 2));
        } else {
          writeLine(output, `Profile: ${profile.id}`);
          if (profile.name) {
            writeLine(output, `  Name: ${profile.name}`);
          }
          writeLine(output, `  Updated: ${profile.updatedAt}`);
        }
        return 0;
      }

      const profile = profileLister().find(
        (entry) => entry.directory === profileId || entry.name === profileId
      );
      if (!profile) {
        throw new Error(`Profile "${profileId}" not found`);
      }
      if (flags.json) {
        writeLine(output, JSON.stringify(profile, null, 2));
      } else {
        writeLine(output, `Profile: ${profile.directory}`);
        writeLine(output, `  Name: ${profile.name}`);
        if (profile.email) {
          writeLine(output, `  Email: ${profile.email}`);
        }
      }
      return 0;
    }

    if (subcommand === 'create') {
      const flags = parseProfileCommandFlags(argv.slice(1));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile create --remote [--name <name>] [--json]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--remote', '--name'],
        'Usage: browser-use profile create --remote [--name <name>] [--json]'
      );
      if (!flags.remote) {
        throw new Error('Profile create is only supported with --remote');
      }
      const profile = await client.create_profile({ name: flags.name });
      if (flags.json) {
        writeLine(output, JSON.stringify(profile, null, 2));
      } else {
        writeLine(output, `Created cloud profile: ${profile.id}`);
      }
      return 0;
    }

    if (subcommand === 'delete') {
      const profileId = requireCommandTarget(
        argv[1],
        'Usage: browser-use profile delete <profile-id> --remote'
      );
      const flags = parseProfileCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile delete <profile-id> --remote'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--remote'],
        'Usage: browser-use profile delete <profile-id> --remote'
      );
      if (!flags.remote) {
        throw new Error('Profile delete is only supported with --remote');
      }
      await client.delete_profile(profileId);
      if (flags.json) {
        writeLine(output, JSON.stringify({ deleted: profileId }, null, 2));
      } else {
        writeLine(output, `Deleted cloud profile: ${profileId}`);
      }
      return 0;
    }

    if (subcommand === 'cookies') {
      const profileId = requireCommandTarget(
        argv[1],
        'Usage: browser-use profile cookies <profile-id>'
      );
      const flags = parseProfileCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile cookies <profile-id>'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json'],
        'Usage: browser-use profile cookies <profile-id>'
      );
      if (flags.remote) {
        throw new Error(
          'Profile cookies is only supported for local Chrome profiles'
        );
      }
      const profile = profileLister().find(
        (entry) => entry.directory === profileId || entry.name === profileId
      );
      if (!profile) {
        throw new Error(`Profile "${profileId}" not found`);
      }

      const session = localSessionFactory(profile.directory);
      await session.start();
      try {
        const cookies = (await session.get_cookies?.()) ?? [];
        const domains = new Map<string, number>();
        for (const cookie of cookies) {
          const domain =
            normalizeProfileCookieDomain(cookie.domain) || 'unknown';
          domains.set(domain, (domains.get(domain) ?? 0) + 1);
        }
        const sortedDomains = Array.from(domains.entries()).sort(
          (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
        );

        if (flags.json) {
          writeLine(
            output,
            JSON.stringify(
              {
                domains: Object.fromEntries(sortedDomains),
                total_cookies: cookies.length,
              },
              null,
              2
            )
          );
        } else {
          const emailSuffix = profile.email ? ` (${profile.email})` : '';
          writeLine(
            output,
            `Loading cookies from: ${profile.name}${emailSuffix}`
          );
          writeLine(output, '');
          writeLine(output, `Cookies by domain (${cookies.length} total):`);
          sortedDomains.slice(0, 20).forEach(([domain, count]) => {
            writeLine(output, `  ${domain}: ${count}`);
          });
          if (sortedDomains.length > 20) {
            writeLine(
              output,
              `  ... and ${sortedDomains.length - 20} more domains`
            );
          }
          writeLine(output, '');
          writeLine(output, 'To sync cookies to cloud:');
          writeLine(
            output,
            `  browser-use profile sync --from "${profile.directory}" --domain <domain>`
          );
        }
      } finally {
        await session.stop?.();
      }
      return 0;
    }

    if (subcommand === 'sync') {
      const flags = parseProfileCommandFlags(argv.slice(1));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile sync --from <profile-id> [--name <name>] [--domain <domain>] [--json]'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--from', '--name', '--domain'],
        'Usage: browser-use profile sync --from <profile-id> [--name <name>] [--domain <domain>] [--json]'
      );
      const profiles = profileLister();
      const fromProfile = flags.from_profile?.trim();
      if (!fromProfile) {
        writeLine(
          errorOutput,
          'Usage: browser-use profile sync --from <profile-id> [--name <name>] [--domain <domain>] [--json]'
        );
        if (profiles.length > 0) {
          writeLine(errorOutput, 'Available local profiles:');
          profiles.forEach((profile) => {
            const emailSuffix = profile.email ? ` (${profile.email})` : '';
            writeLine(
              errorOutput,
              `  ${profile.directory}: ${profile.name}${emailSuffix}`
            );
          });
        }
        return 1;
      }

      const profile = profiles.find(
        (entry) => entry.directory === fromProfile || entry.name === fromProfile
      );
      if (!profile) {
        throw new Error(`Profile "${fromProfile}" not found`);
      }

      const progress = flags.json ? errorOutput : output;
      const logProgress = (message: string) => writeLine(progress, message);
      const cloudName =
        flags.name ??
        (flags.domain
          ? `Chrome - ${profile.name} (${flags.domain})`
          : `Chrome - ${profile.name}`);

      let cloudProfileId: string | null = null;
      let cloudBrowserSessionId: string | null = null;
      const cloudBrowserClient = cloudBrowserClientFactory();

      try {
        logProgress(
          `Syncing: ${profile.name}${profile.email ? ` (${profile.email})` : ''}`
        );
        logProgress('  Creating cloud profile...');
        const cloudProfile = await client.create_profile({ name: cloudName });
        cloudProfileId = cloudProfile.id;
        logProgress(`  Created: ${cloudProfileId}`);

        logProgress('  Exporting cookies from local profile...');
        const localSession = localSessionFactory(profile.directory);
        let filteredCookies: BrowserCookieInit[] = [];
        await localSession.start();
        try {
          const cookies = ((await localSession.get_cookies?.()) ??
            []) as BrowserCookieInit[];
          filteredCookies = cookies.filter((cookie) =>
            cookieMatchesDomainFilter(cookie, flags.domain)
          );
        } finally {
          await localSession.stop?.();
        }

        if (filteredCookies.length === 0) {
          throw new Error(
            flags.domain
              ? `No cookies found for domain: ${flags.domain}`
              : 'No cookies found in local profile'
          );
        }
        logProgress(`  Found ${filteredCookies.length} cookies`);

        logProgress('  Importing cookies to cloud profile...');
        const cloudBrowser = await cloudBrowserClient.create_browser({
          profile_id: cloudProfileId,
        });
        cloudBrowserSessionId = cloudBrowser.id;
        if (!cloudBrowser.cdpUrl) {
          throw new Error('Cloud browser did not return a CDP URL');
        }
        const remoteSession = remoteSessionFactory({
          cdp_url: cloudBrowser.cdpUrl,
        });
        await remoteSession.start();
        try {
          if (!remoteSession.browser_context?.addCookies) {
            throw new Error(
              'Remote browser context does not support addCookies'
            );
          }
          await remoteSession.browser_context.addCookies(filteredCookies);
        } finally {
          await remoteSession.stop?.();
        }
        await cloudBrowserClient.stop_browser(cloudBrowserSessionId);
        cloudBrowserSessionId = null;

        if (flags.json) {
          writeLine(
            output,
            JSON.stringify(
              {
                success: true,
                profile_id: cloudProfileId,
                cookies_synced: filteredCookies.length,
              },
              null,
              2
            )
          );
        } else {
          logProgress('Profile synced successfully!');
          logProgress(`  Cloud profile ID: ${cloudProfileId}`);
        }
        return 0;
      } catch (error) {
        if (cloudBrowserSessionId) {
          try {
            await cloudBrowserClient.stop_browser(cloudBrowserSessionId);
          } catch {
            // Ignore cleanup failures.
          }
        }
        if (cloudProfileId) {
          try {
            await client.delete_profile(cloudProfileId);
          } catch {
            // Ignore cleanup failures.
          }
        }
        throw error;
      }
    }

    if (subcommand === 'update') {
      const profileId = requireCommandTarget(
        argv[1],
        'Usage: browser-use profile update <profile-id> --remote --name <name>'
      );
      const flags = parseProfileCommandFlags(argv.slice(2));
      rejectUnexpectedPositionals(
        flags.positionals,
        'Usage: browser-use profile update <profile-id> --remote --name <name>'
      );
      rejectUnsupportedFlags(
        flags.used_options,
        ['--json', '--remote', '--name'],
        'Usage: browser-use profile update <profile-id> --remote --name <name>'
      );
      if (!flags.remote) {
        throw new Error('Profile update is only supported with --remote');
      }
      if (!flags.name) {
        throw new Error(
          'Usage: browser-use profile update <profile-id> --remote --name <name>'
        );
      }
      const profile = await client.update_profile(profileId, {
        name: flags.name,
      });
      if (flags.json) {
        writeLine(output, JSON.stringify(profile, null, 2));
      } else {
        writeLine(output, `Updated cloud profile: ${profile.id}`);
      }
      return 0;
    }

    writeLine(
      errorOutput,
      'Usage: browser-use profile <list|get|create|update|delete|cookies|sync> [--remote] [options]'
    );
    return 1;
  } catch (error) {
    writeLine(errorOutput, `Error: ${(error as Error).message}`);
    return 1;
  }
};

const CLOUD_RUN_FLAGS = new Set([
  '--remote',
  '--llm',
  '--session-id',
  '--proxy-country',
  '--wait',
  '--stream',
  '--flash',
  '--thinking',
  '--vision',
  '--no-vision',
  '--start-url',
  '--metadata',
  '--secret',
  '--allowed-domain',
  '--skill-id',
  '--structured-output',
  '--judge',
  '--judge-ground-truth',
  '--max-steps',
  '--profile',
]);

const CLOUD_RUN_VALUE_FLAGS = new Set([
  '--llm',
  '--session-id',
  '--proxy-country',
  '--start-url',
  '--structured-output',
  '--judge-ground-truth',
  '--max-steps',
  '--profile',
  '--metadata',
  '--secret',
  '--allowed-domain',
  '--skill-id',
]);

export const hasCloudRunFlags = (argv: string[]) => {
  for (const arg of argv) {
    if (arg === '--') {
      break;
    }
    if (CLOUD_RUN_FLAGS.has(arg)) {
      return true;
    }
    const separator = arg.indexOf('=');
    if (separator > 0 && CLOUD_RUN_VALUE_FLAGS.has(arg.slice(0, separator))) {
      return true;
    }
  }
  return false;
};

const hasExplicitRemoteRunFlag = (argv: string[]) => {
  for (const arg of argv) {
    if (arg === '--') {
      break;
    }
    if (arg === '--remote') {
      return true;
    }
  }
  return false;
};

type PrefixedSubcommand = {
  command: 'run' | 'task' | 'session' | 'profile' | 'auth' | 'skill';
  argv: string[];
  debug: boolean;
  forwardedArgs: string[];
};

const PREFIXED_SUBCOMMAND_VALUE_FLAGS = [
  '--api-key',
  '--provider',
  '--model',
  '--window-width',
  '--window-height',
  '--user-data-dir',
  '--profile-directory',
  '--allowed-domains',
  '--proxy-url',
  '--no-proxy',
  '--proxy-username',
  '--proxy-password',
  '--cdp-url',
];

const matchesOptionWithValue = (arg: string, option: string) =>
  arg === option || arg.startsWith(`${option}=`);

export const extractPrefixedSubcommand = (
  argv: string[]
): PrefixedSubcommand | null => {
  const forwardedArgs: string[] = [];
  let debug = false;
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index] ?? '';
    if (arg === '--debug') {
      debug = true;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      forwardedArgs.push(arg);
      index += 1;
      continue;
    }
    if (arg === '--headless') {
      index += 1;
      continue;
    }
    const valueOption = PREFIXED_SUBCOMMAND_VALUE_FLAGS.find((option) =>
      matchesOptionWithValue(arg, option)
    );
    if (valueOption) {
      if (arg === valueOption) {
        if (index + 1 >= argv.length) {
          break;
        }
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    break;
  }

  const command = argv[index];
  if (
    command !== 'run' &&
    command !== 'task' &&
    command !== 'session' &&
    command !== 'profile' &&
    command !== 'auth' &&
    command !== 'skill'
  ) {
    return null;
  }

  return {
    command,
    argv: argv.slice(index + 1),
    debug,
    forwardedArgs,
  };
};

const parseKeyValuePairs = (values: string[], option: string) => {
  const result: Record<string, string> = {};
  values.forEach((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid value for ${option}: expected KEY=VALUE`);
    }
    const key = value.slice(0, separator).trim();
    if (!key) {
      throw new Error(`Invalid value for ${option}: expected KEY=VALUE`);
    }
    result[key] = value.slice(separator + 1);
  });
  return Object.keys(result).length > 0 ? result : null;
};

const parseCloudRunArgs = (argv: string[]) => {
  const flags = {
    remote: false,
    wait: false,
    stream: false,
    flash: false,
    thinking: false,
    vision: null as boolean | 'auto' | null,
    llm: null as string | null,
    session_id: null as string | null,
    proxy_country: null as string | null,
    start_url: null as string | null,
    structured_output: null as string | null,
    judge: false,
    judge_ground_truth: null as string | null,
    max_steps: null as number | null,
    profile: null as string | null,
    metadata: [] as string[],
    secret: [] as string[],
    allowed_domain: [] as string[],
    skill_id: [] as string[],
    task_parts: [] as string[],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index] ?? '';
    if (rawArg === '--') {
      flags.task_parts.push(...argv.slice(index + 1));
      break;
    }
    const separator = rawArg.indexOf('=');
    const hasInlineValue = separator > 0;
    const arg = hasInlineValue ? rawArg.slice(0, separator) : rawArg;
    const inlineValue = hasInlineValue
      ? rawArg.slice(separator + 1).trim()
      : '';
    if (arg === '--remote') {
      flags.remote = true;
      continue;
    }
    if (arg === '--wait') {
      flags.wait = true;
      continue;
    }
    if (arg === '--stream') {
      flags.stream = true;
      continue;
    }
    if (arg === '--flash') {
      flags.flash = true;
      continue;
    }
    if (arg === '--thinking') {
      flags.thinking = true;
      continue;
    }
    if (arg === '--vision') {
      flags.vision = true;
      continue;
    }
    if (arg === '--no-vision') {
      flags.vision = false;
      continue;
    }
    if (arg === '--judge') {
      flags.judge = true;
      continue;
    }
    if (
      arg === '--llm' ||
      arg === '--session-id' ||
      arg === '--proxy-country' ||
      arg === '--start-url' ||
      arg === '--structured-output' ||
      arg === '--judge-ground-truth' ||
      arg === '--max-steps' ||
      arg === '--profile' ||
      arg === '--metadata' ||
      arg === '--secret' ||
      arg === '--allowed-domain' ||
      arg === '--skill-id'
    ) {
      const { value: next, nextIndex } = takeOptionValue(rawArg, index, argv);
      if (arg === '--llm') {
        flags.llm = next;
      } else if (arg === '--session-id') {
        flags.session_id = next;
      } else if (arg === '--proxy-country') {
        flags.proxy_country = next;
      } else if (arg === '--start-url') {
        flags.start_url = next;
      } else if (arg === '--structured-output') {
        flags.structured_output = next;
      } else if (arg === '--judge-ground-truth') {
        flags.judge_ground_truth = next;
      } else if (arg === '--max-steps') {
        flags.max_steps = parsePositiveInt('--max-steps', next);
      } else if (arg === '--profile') {
        flags.profile = next;
      } else if (arg === '--metadata') {
        flags.metadata.push(next);
      } else if (arg === '--secret') {
        flags.secret.push(next);
      } else if (arg === '--allowed-domain') {
        flags.allowed_domain.push(next);
      } else {
        flags.skill_id.push(next);
      }
      index = nextIndex;
      continue;
    }
    if (rawArg.startsWith('-')) {
      throw new Error(`Unknown option: ${rawArg}`);
    }
    flags.task_parts.push(rawArg);
  }

  return flags;
};

export const runCloudTaskCommand = async (
  argv: string[],
  options: RunCloudTaskCommandOptions = {}
) => {
  const client = options.client ?? new CloudManagementClient();
  const output = options.stdout ?? process.stdout;
  const errorOutput = options.stderr ?? process.stderr;
  const sleepImpl =
    options.sleep_impl ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let autoCreatedSessionId: string | null = null;
  let taskCreated = false;

  try {
    const flags = parseCloudRunArgs(argv);
    if (!flags.remote) {
      throw new Error('Usage: browser-use run --remote <task>');
    }
    const task = flags.task_parts.join(' ').trim();
    if (!task) {
      throw new Error('Usage: browser-use run --remote <task>');
    }

    let sessionId = flags.session_id;
    if (!sessionId && (flags.profile || flags.proxy_country)) {
      const session = await client.create_session({
        profileId: flags.profile,
        proxyCountryCode: flags.proxy_country,
        startUrl: flags.start_url,
      });
      sessionId = session.id;
      autoCreatedSessionId = session.id;
      writeLine(output, `Created cloud session: ${sessionId}`);
    }

    const created = await client.create_task({
      task,
      llm: flags.llm,
      sessionId,
      startUrl: flags.start_url,
      maxSteps: flags.max_steps,
      structuredOutput: flags.structured_output,
      metadata: parseKeyValuePairs(flags.metadata, '--metadata'),
      secrets: parseKeyValuePairs(flags.secret, '--secret'),
      allowedDomains:
        flags.allowed_domain.length > 0 ? flags.allowed_domain : null,
      flashMode: flags.flash,
      thinking: flags.thinking,
      vision: flags.vision,
      judge: flags.judge,
      judgeGroundTruth: flags.judge_ground_truth,
      skillIds: flags.skill_id.length > 0 ? flags.skill_id : null,
    });
    taskCreated = true;

    if (!flags.wait) {
      writeLine(
        output,
        `Task started: ${created.id} (session: ${created.sessionId})`
      );
      writeLine(
        output,
        `Use "browser-use task status ${created.id}" to check progress.`
      );
      return 0;
    }

    let lastStatus: string | null = null;
    while (true) {
      const taskView = await client.get_task(created.id);
      if (flags.stream && taskView.status !== lastStatus) {
        writeLine(output, `Status: ${taskView.status}`);
        lastStatus = taskView.status;
      }
      if (
        taskView.status === 'finished' ||
        taskView.status === 'stopped' ||
        taskView.status === 'failed'
      ) {
        writeLine(output, `Task ${taskView.status}: ${taskView.id}`);
        if (taskView.output) {
          writeLine(output, taskView.output);
        }
        return taskView.status === 'finished' ? 0 : 1;
      }
      await sleepImpl(1000);
    }
  } catch (error) {
    if (autoCreatedSessionId && !taskCreated) {
      try {
        await client.update_session(autoCreatedSessionId, 'stop');
      } catch {
        // Ignore cleanup failures.
      }
    }
    writeLine(errorOutput, `Error: ${(error as Error).message}`);
    return 1;
  }
};

const enableDebugLogging = () => {
  process.env.BROWSER_USE_LOGGING_LEVEL = 'debug';
  setupLogging({ logLevel: 'debug', forceSetup: true });
};

export interface CliDoctorCheck {
  status: 'ok' | 'warning' | 'missing' | 'error';
  message: string;
  note?: string;
  fix?: string;
}

export interface CliDoctorReport {
  status: 'healthy' | 'issues_found';
  checks: Record<string, CliDoctorCheck>;
  summary: string;
}

export interface RunDoctorChecksOptions {
  version?: string;
  browser_executable?: string | null;
  api_key?: string | null;
  cloudflared_path?: string | null;
  fetch_impl?: typeof fetch;
}

const summarizeDoctorChecks = (checks: Record<string, CliDoctorCheck>) => {
  const values = Object.values(checks);
  const total = values.length;
  const ok = values.filter((check) => check.status === 'ok').length;
  const warning = values.filter((check) => check.status === 'warning').length;
  const missing = values.filter((check) => check.status === 'missing').length;
  const error = values.filter((check) => check.status === 'error').length;

  const parts = [`${ok}/${total} checks passed`];
  if (warning > 0) {
    parts.push(`${warning} warnings`);
  }
  if (missing > 0) {
    parts.push(`${missing} missing`);
  }
  if (error > 0) {
    parts.push(`${error} errors`);
  }
  return parts.join(', ');
};

const findSystemBinary = (binary: string) => {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [binary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    return null;
  }
  const firstLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? null;
};

export const runDoctorChecks = async (
  options: RunDoctorChecksOptions = {}
): Promise<CliDoctorReport> => {
  const fetchImpl = options.fetch_impl ?? fetch;
  const configuredApiKey =
    options.api_key !== undefined
      ? options.api_key?.trim() || null
      : process.env.BROWSER_USE_API_KEY?.trim() ||
        new DeviceAuthClient().api_token?.trim() ||
        null;
  const apiKeySource =
    options.api_key !== undefined
      ? 'argument'
      : process.env.BROWSER_USE_API_KEY?.trim()
        ? 'environment'
        : new DeviceAuthClient().api_token?.trim()
          ? 'cloud_auth'
          : null;
  const tunnelStatus =
    options.cloudflared_path !== undefined
      ? options.cloudflared_path
        ? {
            available: true,
            source: 'system' as const,
            path: options.cloudflared_path,
            note: 'cloudflared installed',
          }
        : {
            available: false,
            source: null,
            path: null,
            note: 'cloudflared not installed - install it manually before using tunnel',
          }
      : get_tunnel_manager().get_status();
  const checks: Record<string, CliDoctorCheck> = {
    package: {
      status: 'ok',
      message: `browser-use ${options.version ?? get_browser_use_version()}`,
    },
    browser: (() => {
      const executable =
        options.browser_executable !== undefined
          ? options.browser_executable
          : systemChrome.findExecutable();
      if (executable) {
        return {
          status: 'ok',
          message: `Chrome detected at ${executable}`,
        };
      }
      return {
        status: 'warning',
        message: 'Chrome executable not detected',
        note: 'Local browser launch may fail until Chrome or Chromium is installed.',
      };
    })(),
    api_key: (() => {
      if (configuredApiKey) {
        return {
          status: 'ok',
          message:
            apiKeySource === 'cloud_auth'
              ? 'Browser Use API key is configured in cloud auth'
              : 'BROWSER_USE_API_KEY is configured',
        };
      }
      return {
        status: 'missing',
        message: 'BROWSER_USE_API_KEY is not configured',
        note: 'Required for browser-use cloud browser features.',
      };
    })(),
    cloudflared: (() => {
      if (tunnelStatus.available && tunnelStatus.path) {
        return {
          status: 'ok',
          message: `cloudflared detected at ${tunnelStatus.path}`,
        };
      }
      return {
        status: 'missing',
        message: 'cloudflared not found',
        note:
          tunnelStatus.note ||
          'Tunnel features remain unavailable until cloudflared is installed.',
      };
    })(),
    network: {
      status: 'warning',
      message: 'Network connectivity check inconclusive',
      note: 'Some remote features may not work offline.',
    },
  };

  try {
    const response = await fetchImpl('https://api.github.com', {
      method: 'HEAD',
    });
    if (response.ok || response.status < 500) {
      checks.network = {
        status: 'ok',
        message: 'Network connectivity OK',
      };
    }
  } catch {
    checks.network = {
      status: 'warning',
      message: 'Network connectivity check inconclusive',
      note: 'Some remote features may not work offline.',
    };
  }

  const allOk = Object.values(checks).every((check) => check.status === 'ok');
  return {
    status: allOk ? 'healthy' : 'issues_found',
    checks,
    summary: summarizeDoctorChecks(checks),
  };
};

const printDoctorReport = (report: CliDoctorReport) => {
  console.log(`status: ${report.status}`);
  console.log(`summary: ${report.summary}`);
  for (const [name, check] of Object.entries(report.checks)) {
    console.log(`${name}: ${check.status} - ${check.message}`);
    if (check.note) {
      console.log(`  note: ${check.note}`);
    }
    if (check.fix) {
      console.log(`  fix: ${check.fix}`);
    }
  }
};

async function runMcpServer() {
  const { MCPServer } = await import('./mcp/server.js');
  const server = new MCPServer('browser-use', get_browser_use_version());
  await server.start();

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}

async function runCliMcpServer() {
  const { CliMCPServer } = await import('./mcp/cli-server.js');
  const server = new CliMCPServer('browser-use-cli', get_browser_use_version());
  await server.start();

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const prefixedSubcommand = extractPrefixedSubcommand(argv);
  if (prefixedSubcommand) {
    if (prefixedSubcommand.debug) {
      enableDebugLogging();
    }

    if (prefixedSubcommand.command === 'run') {
      if (
        !hasCloudRunFlags(prefixedSubcommand.argv) ||
        !hasExplicitRemoteRunFlag(prefixedSubcommand.argv)
      ) {
        await main([
          ...prefixedSubcommand.forwardedArgs,
          ...prefixedSubcommand.argv,
        ]);
        return;
      }
      const exitCode = await runCloudTaskCommand(prefixedSubcommand.argv);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    const subcommandArgv = [
      ...prefixedSubcommand.argv,
      ...prefixedSubcommand.forwardedArgs,
    ];
    if (prefixedSubcommand.command === 'task') {
      const exitCode = await runTaskCommand(subcommandArgv);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    if (prefixedSubcommand.command === 'session') {
      const exitCode = await runSessionCommand(subcommandArgv);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    if (prefixedSubcommand.command === 'auth') {
      const exitCode = await runAuthCommand(subcommandArgv);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    if (prefixedSubcommand.command === 'skill') {
      const { runSkillCommand } = await import('./skills/install.js');
      const exitCode = await runSkillCommand(subcommandArgv);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    const exitCode = await runProfileCommand(subcommandArgv);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(getCliUsage());
    process.exit(1);
    return;
  }

  if (args.help) {
    console.log(getCliUsage());
    return;
  }

  if (args.version) {
    console.log(get_browser_use_version());
    return;
  }

  if (args.debug) {
    enableDebugLogging();
  }

  if (args.cli_mcp) {
    await runCliMcpServer();
    return;
  }

  if (args.mcp) {
    await runMcpServer();
    return;
  }

  if (args.prompt == null && args.positional[0] === 'doctor') {
    const report = await runDoctorChecks();
    printDoctorReport(report);
    return;
  }

  if (args.prompt == null && args.positional[0] === 'install') {
    console.log('Installing Chromium browser...');
    runInstallCommand();
    console.log('Chromium browser installed.');
    return;
  }

  if (args.prompt == null && args.positional[0] === 'setup') {
    const exitCode = await runSetupCommand(
      {
        mode: args.setup_mode,
        yes: args.yes,
        api_key: args.api_key,
      },
      {
        json_output: args.json,
      }
    );
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  if (args.prompt == null && args.positional[0] === 'tunnel') {
    const exitCode = await runTunnelCommand(args.positional.slice(1), {
      json_output: args.json,
    });
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  const task = resolveTask(args);
  const shouldStartInteractive = shouldStartInteractiveMode(task);
  if (!task && !shouldStartInteractive) {
    console.error(getCliUsage());
    process.exit(1);
    return;
  }

  let llm: BaseChatModel;
  try {
    llm = getLlmFromCliArgs(args);
  } catch (error) {
    console.error(`Error selecting LLM: ${(error as Error).message}`);
    process.exit(1);
    return;
  }

  if (shouldStartInteractive) {
    await runInteractiveMode(args, llm);
    return;
  }

  if (!task) {
    console.error(getCliUsage());
    process.exit(1);
    return;
  }

  console.log(`Starting task: ${task}`);

  const browserProfile = buildBrowserProfileFromCliArgs(args);
  const browserSession = args.cdp_url
    ? new BrowserSession({
        browser_profile: browserProfile ?? undefined,
        cdp_url: args.cdp_url,
      })
    : null;
  try {
    await runAgentTask({
      task,
      llm,
      browserProfile,
      browserSession,
    });
  } catch (error) {
    console.error('Error running agent:', error);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
