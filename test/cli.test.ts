import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLI_HISTORY_LIMIT,
  buildBrowserProfileFromCliArgs,
  extractPrefixedSubcommand,
  getCliHistoryPath,
  getCliUsage,
  hasCloudRunFlags,
  getLlmFromCliArgs,
  isInteractiveExitCommand,
  isInteractiveHelpCommand,
  loadCliHistory,
  main,
  normalizeCliHistory,
  parseCliArgs,
  runDoctorChecks,
  runAuthCommand,
  runInstallCommand,
  runSetupCommand,
  saveCliHistory,
  shouldStartInteractiveMode,
} from '../src/cli.js';
import { save_cloud_api_token } from '../src/sync/auth.js';
import { CloudManagementClient } from '../src/browser/cloud/management.js';
import { saveCodexTokens } from '../src/llm/codex/auth.js';

const MANAGED_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'MISTRAL_API_KEY',
  'MISTRAL_BASE_URL',
  'CEREBRAS_API_KEY',
  'CEREBRAS_BASE_URL',
  'VERCEL_API_KEY',
  'VERCEL_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
  'OLLAMA_MODEL',
  'OLLAMA_HOST',
  'OCI_SERVICE_ENDPOINT',
  'OCI_COMPARTMENT_ID',
  'OCI_MODEL_ID',
  'BROWSER_USE_API_KEY',
  'BROWSER_USE_CODEX_ACCESS_TOKEN',
  'BROWSER_USE_CODEX_MODEL',
  'BROWSER_USE_CODEX_BASE_URL',
  'BROWSER_USE_CONFIG_DIR',
  'BROWSER_USE_CLI_FORCE_INTERACTIVE',
  'HOME',
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>;

const TEMP_DIRS: string[] = [];

const clearManagedEnv = () => {
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key];
  }
};

const restoreManagedEnv = () => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const makeTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-cli-test-'));
  TEMP_DIRS.push(dir);
  return dir;
};

describe('CLI argument parsing', () => {
  beforeEach(() => {
    clearManagedEnv();
    process.env.HOME = '/home/tester';
  });

  afterEach(() => {
    restoreManagedEnv();
  });

  it('parses prompt mode and browser options', () => {
    const parsed = parseCliArgs([
      '--json',
      '--yes',
      '--mode',
      'full',
      '--api-key',
      'bu_test_123',
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4-20250514',
      '--headless',
      '--window-width',
      '1440',
      '--window-height=900',
      '--user-data-dir',
      '~/chrome-data',
      '--profile-directory',
      'Profile 1',
      '--allowed-domains',
      'example.com,*.example.org',
      '--proxy-url',
      'http://proxy.example.com:8080',
      '--no-proxy',
      'localhost,127.0.0.1,*.internal',
      '--proxy-username',
      'proxy-user',
      '--proxy-password',
      'proxy-pass',
      '--cdp-url',
      'http://localhost:9222',
      '-p',
      'Open docs and summarize',
    ]);

    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude-sonnet-4-20250514');
    expect(parsed.json).toBe(true);
    expect(parsed.yes).toBe(true);
    expect(parsed.setup_mode).toBe('full');
    expect(parsed.api_key).toBe('bu_test_123');
    expect(parsed.headless).toBe(true);
    expect(parsed.window_width).toBe(1440);
    expect(parsed.window_height).toBe(900);
    expect(parsed.user_data_dir).toBe('/home/tester/chrome-data');
    expect(parsed.profile_directory).toBe('Profile 1');
    expect(parsed.allowed_domains).toEqual(['example.com', '*.example.org']);
    expect(parsed.proxy_url).toBe('http://proxy.example.com:8080');
    expect(parsed.no_proxy).toBe('localhost,127.0.0.1,*.internal');
    expect(parsed.proxy_username).toBe('proxy-user');
    expect(parsed.proxy_password).toBe('proxy-pass');
    expect(parsed.cdp_url).toBe('http://localhost:9222');
    expect(parsed.prompt).toBe('Open docs and summarize');
    expect(parsed.positional).toEqual([]);
  });

  it('parses the minimal CLI MCP mode separately from the full MCP mode', () => {
    const cliMcp = parseCliArgs(['--cli-mcp']);
    const fullMcp = parseCliArgs(['--mcp']);

    expect(cliMcp.cli_mcp).toBe(true);
    expect(cliMcp.mcp).toBe(false);
    expect(fullMcp.mcp).toBe(true);
    expect(fullMcp.cli_mcp).toBe(false);
    expect(getCliUsage()).toContain('browser-use --cli-mcp');
  });

  it('builds proxy settings into BrowserProfile from CLI args', async () => {
    const configDir = await makeTempDir();
    process.env.BROWSER_USE_CONFIG_DIR = configDir;

    const parsed = parseCliArgs([
      '--proxy-url',
      'http://proxy.example.com:8080',
      '--no-proxy',
      'localhost, 127.0.0.1 ,*.internal',
      '--proxy-username',
      'proxy-user',
      '--proxy-password',
      'proxy-pass',
      '-p',
      'task',
    ]);

    const profile = buildBrowserProfileFromCliArgs(parsed);
    expect(profile).not.toBeNull();
    expect(profile!.config.proxy).toEqual({
      server: 'http://proxy.example.com:8080',
      bypass: 'localhost,127.0.0.1,*.internal',
      username: 'proxy-user',
      password: 'proxy-pass',
    });
  });

  it('parses positional task mode', () => {
    const parsed = parseCliArgs(['Go', 'to', 'example.com']);
    expect(parsed.prompt).toBeNull();
    expect(parsed.positional).toEqual(['Go', 'to', 'example.com']);
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--unknown-option'])).toThrow(
      'Unknown option: --unknown-option'
    );
  });

  it('rejects empty --allowed-domains values', () => {
    expect(() =>
      parseCliArgs(['--allowed-domains', ' , ', '-p', 'task'])
    ).toThrow('--allowed-domains must include at least one domain pattern');
  });

  it('rejects mixed prompt and positional task input', () => {
    expect(() => parseCliArgs(['--prompt', 'task one', 'task two'])).toThrow(
      'Use either positional task text or --prompt, not both.'
    );
  });

  it('extracts task subcommands after leading global flags', () => {
    expect(
      extractPrefixedSubcommand([
        '--json',
        '--debug',
        'task',
        'list',
        '--limit',
        '5',
      ])
    ).toEqual({
      command: 'task',
      argv: ['list', '--limit', '5'],
      debug: true,
      forwardedArgs: ['--json'],
    });
  });

  it('extracts task subcommands after leading value-based global flags', () => {
    expect(
      extractPrefixedSubcommand([
        '--api-key',
        'bu_test',
        '--provider',
        'openai',
        'task',
        'list',
      ])
    ).toEqual({
      command: 'task',
      argv: ['list'],
      debug: false,
      forwardedArgs: [],
    });
  });

  it('extracts run subcommands after leading global flags', () => {
    expect(
      extractPrefixedSubcommand([
        '--debug',
        'run',
        '--remote',
        '--wait',
        'Collect',
        'data',
      ])
    ).toEqual({
      command: 'run',
      argv: ['--remote', '--wait', 'Collect', 'data'],
      debug: true,
      forwardedArgs: [],
    });
  });

  it('extracts auth subcommands after leading global flags', () => {
    expect(
      extractPrefixedSubcommand(['--json', 'auth', 'codex', 'status'])
    ).toEqual({
      command: 'auth',
      argv: ['codex', 'status'],
      debug: false,
      forwardedArgs: ['--json'],
    });
  });

  it('extracts skill subcommands after leading global flags', () => {
    expect(
      extractPrefixedSubcommand([
        '--debug',
        'skill',
        'install',
        '--target=codex',
      ])
    ).toEqual({
      command: 'skill',
      argv: ['install', '--target=codex'],
      debug: true,
      forwardedArgs: [],
    });
  });

  it('dispatches api-key-prefixed task subcommands through main', async () => {
    let output = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output += String(chunk);
      return true;
    }) as any);
    const listTasksSpy = vi
      .spyOn(CloudManagementClient.prototype, 'list_tasks')
      .mockResolvedValue({
        items: [
          {
            id: 'task-prefixed',
            status: 'finished',
            task: 'Collect data',
          },
        ],
        totalItems: 1,
        pageNumber: 1,
        pageSize: 10,
      } as any);

    try {
      await main(['--api-key', 'bu_test', 'task', 'list']);
    } finally {
      stdoutSpy.mockRestore();
      listTasksSpy.mockRestore();
    }

    expect(output).toContain('Tasks (1):');
    expect(output).toContain('task-pre');
  });

  it('ignores task text after -- when detecting cloud run flags', () => {
    expect(hasCloudRunFlags(['--', '--wait', 'for', 'selector'])).toBe(false);
    expect(
      hasCloudRunFlags(['--remote', '--', '--wait', 'for', 'selector'])
    ).toBe(true);
    expect(hasCloudRunFlags(['Collect', '--', '--llm=gpt-4o'])).toBe(false);
  });

  it('dispatches json-prefixed task subcommands through main', async () => {
    let output = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output += String(chunk);
      return true;
    }) as any);
    const listTasksSpy = vi
      .spyOn(CloudManagementClient.prototype, 'list_tasks')
      .mockResolvedValue({
        items: [
          {
            id: 'task-json',
            status: 'finished',
            task: 'Collect data',
          },
        ],
        totalItems: 1,
        pageNumber: 1,
        pageSize: 10,
      } as any);

    try {
      await main(['--json', 'task', 'list']);
    } finally {
      stdoutSpy.mockRestore();
      listTasksSpy.mockRestore();
    }

    expect(output).toContain('"id": "task-json"');
  });

  it('renders usage help text', () => {
    const usage = getCliUsage();
    expect(usage).toContain('browser-use --mcp');
    expect(usage).toContain('browser-use doctor');
    expect(usage).toContain('browser-use install');
    expect(usage).toContain('browser-use setup');
    expect(usage).toContain('browser-use auth codex');
    expect(usage).toContain('browser-use skill <show|install>');
    expect(usage).toContain('browser-use tunnel <port>');
    expect(usage).toContain('--provider <name>');
    expect(usage).toContain('--model <model>');
    expect(usage).toContain('--json');
    expect(usage).toContain('--mode <name>');
    expect(usage).toContain('--api-key <value>');
    expect(usage).toContain('--headless');
    expect(usage).toContain('--allowed-domains <items>');
  });
});

describe('CLI interactive helpers', () => {
  afterEach(async () => {
    await Promise.all(
      TEMP_DIRS.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true })
      )
    );
  });

  it('normalizes and trims command history entries', () => {
    const values = [' first ', '', 'second', '   ', 'third'];
    expect(normalizeCliHistory(values, 2)).toEqual(['second', 'third']);
  });

  it('builds history path from explicit config dir', () => {
    const target = getCliHistoryPath('/tmp/browseruse-config');
    expect(target).toBe('/tmp/browseruse-config/command_history.json');
  });

  it('persists and reloads trimmed history', async () => {
    const dir = await makeTempDir();
    const historyPath = path.join(dir, 'command_history.json');
    const oversized = Array.from(
      { length: CLI_HISTORY_LIMIT + 5 },
      (_, i) => `task-${i}`
    );

    await saveCliHistory(oversized, historyPath);
    const loaded = await loadCliHistory(historyPath);

    expect(loaded).toHaveLength(CLI_HISTORY_LIMIT);
    expect(loaded[0]).toBe('task-5');
    expect(loaded[CLI_HISTORY_LIMIT - 1]).toBe(`task-${CLI_HISTORY_LIMIT + 4}`);
    if (process.platform !== 'win32') {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(historyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('returns empty history for invalid history file content', async () => {
    const dir = await makeTempDir();
    const historyPath = path.join(dir, 'command_history.json');
    await fs.writeFile(historyPath, '{not-json', 'utf-8');

    const loaded = await loadCliHistory(historyPath);
    expect(loaded).toEqual([]);
  });

  it('detects interactive control commands', () => {
    expect(isInteractiveExitCommand('exit')).toBe(true);
    expect(isInteractiveExitCommand(':q')).toBe(true);
    expect(isInteractiveExitCommand('search docs')).toBe(false);
    expect(isInteractiveHelpCommand('help')).toBe(true);
    expect(isInteractiveHelpCommand('?')).toBe(true);
    expect(isInteractiveHelpCommand('run task')).toBe(false);
  });

  it('decides when interactive mode should start', () => {
    expect(
      shouldStartInteractiveMode(null, {
        inputIsTTY: true,
        outputIsTTY: true,
      })
    ).toBe(true);

    expect(
      shouldStartInteractiveMode(null, {
        inputIsTTY: false,
        outputIsTTY: false,
      })
    ).toBe(false);

    expect(
      shouldStartInteractiveMode(null, {
        forceInteractive: true,
        inputIsTTY: false,
        outputIsTTY: false,
      })
    ).toBe(true);
  });
});

describe('CLI model routing', () => {
  beforeEach(() => {
    clearManagedEnv();
  });

  afterEach(() => {
    restoreManagedEnv();
  });

  it('routes claude* model names to Anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    const args = parseCliArgs([
      '--model',
      'claude-sonnet-4-20250514',
      '-p',
      'x',
    ]);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe('claude-sonnet-4-20250514');
  });

  it('routes gpt* model names to OpenAI', () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    const args = parseCliArgs(['--model', 'gpt-4o', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-4o');
  });

  it('routes mistral aliases to Mistral', () => {
    process.env.MISTRAL_API_KEY = 'test-mistral';
    const args = parseCliArgs(['--model', 'mistral-large-latest', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('mistral');
    expect(llm.model).toBe('mistral-large-latest');
  });

  it('routes cerebras-prefixed model names to Cerebras', () => {
    process.env.CEREBRAS_API_KEY = 'test-cerebras';
    const args = parseCliArgs(['--model', 'cerebras:llama3.1-8b', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('cerebras');
    expect(llm.model).toBe('llama3.1-8b');
  });

  it('routes vercel-prefixed model names to Vercel gateway provider', () => {
    process.env.VERCEL_API_KEY = 'test-vercel';
    const args = parseCliArgs([
      '--model',
      'vercel:openai/gpt-5-mini',
      '-p',
      'x',
    ]);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('vercel');
    expect(llm.model).toBe('openai/gpt-5-mini');
  });

  it('supports --provider without --model using provider defaults', () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    const args = parseCliArgs(['--provider', 'anthropic', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe('claude-4-sonnet');
  });

  it('supports browser-use provider defaults when api key is configured', () => {
    process.env.BROWSER_USE_API_KEY = 'test-browser-use';
    const args = parseCliArgs(['--provider', 'browser-use', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('browser-use');
    expect(llm.model).toBe('bu-2-0');
  });

  it('supports explicit Codex provider defaults without OpenAI API key', () => {
    const args = parseCliArgs(['--provider', 'codex', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('codex');
    expect(llm.model).toBe('gpt-5.5');
  });

  it('routes codex-prefixed model names to Codex provider', () => {
    const args = parseCliArgs([
      '--model',
      'codex:gpt-5.1-codex-mini',
      '-p',
      'x',
    ]);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('codex');
    expect(llm.model).toBe('gpt-5.1-codex-mini');
  });

  it('supports vercel provider defaults when api key is configured', () => {
    process.env.VERCEL_API_KEY = 'test-vercel';
    const args = parseCliArgs(['--provider', 'vercel', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('vercel');
    expect(llm.model).toBe('openai/gpt-5-mini');
  });

  it('rejects conflicting --provider and --model combinations', () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    const args = parseCliArgs([
      '--provider',
      'anthropic',
      '--model',
      'gpt-4o',
      '-p',
      'x',
    ]);
    expect(() => getLlmFromCliArgs(args)).toThrow('Provider mismatch:');
  });

  it('requires --model when provider is aws', () => {
    const args = parseCliArgs(['--provider', 'aws', '-p', 'x']);
    expect(() => getLlmFromCliArgs(args)).toThrow(
      'Provider "aws" requires --model.'
    );
  });

  it('requires --model when provider is oci', () => {
    const args = parseCliArgs(['--provider', 'oci', '-p', 'x']);
    expect(() => getLlmFromCliArgs(args)).toThrow(
      'Provider "oci" requires --model.'
    );
  });

  it('auto-detects OpenAI first when no model is specified', () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';

    const args = parseCliArgs(['-p', 'task']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-5-mini');
  });

  it('falls back to Ollama when no API credentials are present', () => {
    const args = parseCliArgs(['-p', 'task']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('ollama');
    expect(llm.model).toBe('qwen2.5:latest');
  });

  it('requires matching credentials for explicit provider models', () => {
    const args = parseCliArgs([
      '--model',
      'claude-sonnet-4-20250514',
      '-p',
      'x',
    ]);
    expect(() => getLlmFromCliArgs(args)).toThrow(
      'Missing environment variable: ANTHROPIC_API_KEY'
    );
  });

  it('routes bu-* model names to browser-use provider', () => {
    process.env.BROWSER_USE_API_KEY = 'test-browser-use';
    const args = parseCliArgs(['--model', 'bu-2-0', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('browser-use');
    expect(llm.model).toBe('bu-2-0');
  });

  it('routes oci-prefixed model names to ChatOCIRaw', () => {
    process.env.OCI_SERVICE_ENDPOINT =
      'https://inference.generativeai.example.oraclecloud.com';
    process.env.OCI_COMPARTMENT_ID = 'ocid1.compartment.oc1..example';
    const args = parseCliArgs(['--model', 'oci:meta/llama-3.1', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('oci-raw');
    expect(llm.model).toBe('meta/llama-3.1');
  });

  it('supports explicit OCI provider selection with --model', () => {
    process.env.OCI_SERVICE_ENDPOINT =
      'https://inference.generativeai.example.oraclecloud.com';
    process.env.OCI_COMPARTMENT_ID = 'ocid1.compartment.oc1..example';
    const args = parseCliArgs([
      '--provider',
      'oci',
      '--model',
      'ocid1.generativeaimodel.oc1.region.example',
      '-p',
      'x',
    ]);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('oci-raw');
    expect(llm.model).toBe('ocid1.generativeaimodel.oc1.region.example');
  });
});

describe('CLI Codex auth commands', () => {
  afterEach(async () => {
    restoreManagedEnv();
    await Promise.all(
      TEMP_DIRS.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true })
      )
    );
  });

  it('imports, reports, and clears browser-use Codex auth state', async () => {
    clearManagedEnv();
    const configDir = await makeTempDir();
    let output = '';
    let errorOutput = '';
    const stdout = {
      write: (chunk: string) => {
        output += chunk;
      },
    };
    const stderr = {
      write: (chunk: string) => {
        errorOutput += chunk;
      },
    };
    const importStub = vi.fn(async (options: { configDir?: string | null }) => {
      await saveCodexTokens(
        { access_token: 'imported-access', refresh_token: 'imported-refresh' },
        { configDir: options.configDir, source: 'test-import' }
      );
      return true;
    });

    await expect(
      runAuthCommand(['codex', 'import'], {
        configDir,
        stdout,
        stderr,
        import_codex_cli: importStub as any,
      })
    ).resolves.toBe(0);
    expect(output).toContain('Imported Codex CLI credentials');
    expect(output).toContain('cleanest separation from Codex CLI');
    expect(errorOutput).toBe('');

    output = '';
    await expect(
      runAuthCommand(['codex', 'status', '--json'], {
        configDir,
        stdout,
        stderr,
      })
    ).resolves.toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      authenticated: true,
      provider: 'openai-codex',
      source: 'test-import',
    });

    output = '';
    await expect(
      runAuthCommand(['codex', 'logout'], { configDir, stdout, stderr })
    ).resolves.toBe(0);
    expect(output).toContain('Codex auth cleared');

    output = '';
    await expect(
      runAuthCommand(['codex', 'status'], { configDir, stdout, stderr })
    ).resolves.toBe(1);
    expect(output).toContain('not authenticated');
  });

  it('honors auth codex --import as an import command', async () => {
    clearManagedEnv();
    const configDir = await makeTempDir();
    let output = '';
    const stdout = {
      write: (chunk: string) => {
        output += chunk;
      },
    };
    const importStub = vi.fn(async (options: { configDir?: string | null }) => {
      await saveCodexTokens(
        { access_token: 'imported-access', refresh_token: 'imported-refresh' },
        { configDir: options.configDir, source: 'test-import' }
      );
      return true;
    });

    await expect(
      runAuthCommand(['codex', '--import'], {
        configDir,
        stdout,
        import_codex_cli: importStub as any,
      })
    ).resolves.toBe(0);

    expect(importStub).toHaveBeenCalledTimes(1);
    expect(output).toContain('Imported Codex CLI credentials');
  });

  it('reuses existing Codex auth on login unless force is requested', async () => {
    clearManagedEnv();
    const configDir = await makeTempDir();
    await saveCodexTokens(
      { access_token: 'access', refresh_token: 'refresh' },
      { configDir }
    );
    let output = '';
    const stdout = {
      write: (chunk: string) => {
        output += chunk;
      },
    };
    const loginStub = vi.fn();

    await expect(
      runAuthCommand(['codex', 'login'], {
        configDir,
        stdout,
        login_device_code: loginStub as any,
      })
    ).resolves.toBe(0);

    expect(loginStub).not.toHaveBeenCalled();
    expect(output).toContain('Existing browser-use Codex credentials found');
  });

  it('keeps auth codex login --json stdout parseable', async () => {
    clearManagedEnv();
    const configDir = await makeTempDir();
    let output = '';
    let errorOutput = '';
    const stdout = {
      write: (chunk: string) => {
        output += chunk;
      },
    };
    const stderr = {
      write: (chunk: string) => {
        errorOutput += chunk;
      },
    };
    const loginStub = vi.fn(
      async (options: {
        configDir?: string | null;
        stdout?: { write: (chunk: string) => void };
      }) => {
        options.stdout?.write('Open device auth URL\n');
        await saveCodexTokens(
          { access_token: 'access', refresh_token: 'refresh' },
          { configDir: options.configDir, source: 'device-code' }
        );
      }
    );

    await expect(
      runAuthCommand(['codex', 'login', '--force', '--json'], {
        configDir,
        stdout,
        stderr,
        login_device_code: loginStub as any,
      })
    ).resolves.toBe(0);

    expect(JSON.parse(output)).toMatchObject({
      authenticated: true,
      provider: 'openai-codex',
      source: 'device-code',
    });
    expect(errorOutput).toContain('Open device auth URL');
  });
});

describe('CLI doctor checks', () => {
  it('reports a healthy environment when all checks pass', async () => {
    const report = await runDoctorChecks({
      version: '1.2.3',
      browser_executable:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      api_key: 'test-api-key',
      cloudflared_path: '/usr/local/bin/cloudflared',
      fetch_impl: (async () =>
        ({
          ok: true,
          status: 200,
        }) as Response) as typeof fetch,
    });

    expect(report.status).toBe('healthy');
    expect(report.summary).toContain('5/5 checks passed');
    expect(report.checks.package.message).toContain('1.2.3');
    expect(report.checks.browser.status).toBe('ok');
    expect(report.checks.api_key.status).toBe('ok');
    expect(report.checks.cloudflared.status).toBe('ok');
    expect(report.checks.network.status).toBe('ok');
  });

  it('reports missing dependencies without throwing', async () => {
    const report = await runDoctorChecks({
      version: '1.2.3',
      browser_executable: null,
      api_key: null,
      cloudflared_path: null,
      fetch_impl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });

    expect(report.status).toBe('issues_found');
    expect(report.checks.browser.status).toBe('warning');
    expect(report.checks.api_key.status).toBe('missing');
    expect(report.checks.cloudflared.status).toBe('missing');
    expect(report.checks.network.status).toBe('warning');
  });

  it('detects API key persisted in local cloud auth config', async () => {
    const configDir = await makeTempDir();
    process.env.BROWSER_USE_CONFIG_DIR = configDir;
    save_cloud_api_token('bu_saved_token');

    const report = await runDoctorChecks({
      version: '1.2.3',
      browser_executable:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      cloudflared_path: '/usr/local/bin/cloudflared',
      fetch_impl: (async () =>
        ({
          ok: true,
          status: 200,
        }) as Response) as typeof fetch,
    });

    expect(report.checks.api_key.status).toBe('ok');
    expect(report.checks.api_key.message).toContain('cloud auth');
  });
});

describe('CLI install command', () => {
  it('invokes playwright install chromium', () => {
    const spawnImpl = vi.fn(() => ({ status: 0 }) as any);

    runInstallCommand({
      playwright_cli_path: '/tmp/playwright-cli.js',
      spawn_impl: spawnImpl as typeof import('node:child_process').spawnSync,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/playwright-cli.js', 'install', 'chromium'],
      { stdio: 'inherit' }
    );
  });

  it('throws when playwright install fails', () => {
    const spawnImpl = vi.fn(() => ({ status: 2 }) as any);

    expect(() =>
      runInstallCommand({
        playwright_cli_path: '/tmp/playwright-cli.js',
        spawn_impl: spawnImpl as typeof import('node:child_process').spawnSync,
      })
    ).toThrow('Playwright browser install failed with exit code 2');
  });
});

describe('CLI setup command', () => {
  it('plans and executes local setup actions', async () => {
    const stdout = { write: vi.fn() };
    const installCommand = vi.fn();
    const runDoctor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'issues_found',
        summary: 'issues',
        checks: {
          package: { status: 'ok', message: 'browser-use 1.2.3' },
          browser: {
            status: 'warning',
            message: 'Chrome executable not detected',
          },
          api_key: { status: 'missing', message: 'missing' },
          cloudflared: { status: 'missing', message: 'missing' },
          network: { status: 'ok', message: 'ok' },
        },
      })
      .mockResolvedValueOnce({
        status: 'healthy',
        summary: 'ok',
        checks: {
          package: { status: 'ok', message: 'browser-use 1.2.3' },
          browser: { status: 'ok', message: 'Chrome detected' },
          api_key: { status: 'missing', message: 'missing' },
          cloudflared: { status: 'missing', message: 'missing' },
          network: { status: 'ok', message: 'ok' },
        },
      });

    const exitCode = await runSetupCommand(
      { mode: 'local' },
      {
        run_doctor_checks: runDoctor as any,
        install_command: installCommand,
        stdout: stdout as any,
      }
    );

    expect(exitCode).toBe(0);
    expect(installCommand).toHaveBeenCalledTimes(1);
    expect(runDoctor).toHaveBeenCalledTimes(2);
    expect(
      stdout.write.mock.calls.map((call) => String(call[0])).join('')
    ).toContain('Install browser (Chromium)');
  });

  it('persists API key during remote setup and supports JSON output', async () => {
    const stdout = { write: vi.fn() };
    const saveApiKey = vi.fn();
    const runDoctor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'issues_found',
        summary: 'issues',
        checks: {
          package: { status: 'ok', message: 'browser-use 1.2.3' },
          browser: { status: 'ok', message: 'Chrome detected' },
          api_key: { status: 'missing', message: 'No API key configured' },
          cloudflared: { status: 'missing', message: 'cloudflared not found' },
          network: { status: 'ok', message: 'ok' },
        },
      })
      .mockResolvedValueOnce({
        status: 'issues_found',
        summary: 'issues',
        checks: {
          package: { status: 'ok', message: 'browser-use 1.2.3' },
          browser: { status: 'ok', message: 'Chrome detected' },
          api_key: { status: 'ok', message: 'API key configured' },
          cloudflared: { status: 'missing', message: 'cloudflared not found' },
          network: { status: 'ok', message: 'ok' },
        },
      });

    const exitCode = await runSetupCommand(
      { mode: 'remote', api_key: 'bu_secret', yes: true },
      {
        run_doctor_checks: runDoctor as any,
        save_api_key: saveApiKey,
        stdout: stdout as any,
        json_output: true,
      }
    );

    expect(exitCode).toBe(0);
    expect(saveApiKey).toHaveBeenCalledWith('bu_secret');
    expect(
      stdout.write.mock.calls.map((call) => String(call[0])).join('')
    ).toContain('"mode": "remote"');
  });
});
