import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'BROWSER_USE_CONFIG_DIR',
  'BROWSER_USE_CONFIG_PATH',
  'BROWSER_USE_PROXY_URL',
  'BROWSER_USE_NO_PROXY',
  'BROWSER_USE_PROXY_USERNAME',
  'BROWSER_USE_PROXY_PASSWORD',
  'BROWSER_USE_DISABLE_EXTENSIONS',
  'BROWSER_USE_HEADLESS',
  'BROWSER_USE_ALLOWED_DOMAINS',
  'BROWSER_USE_LLM_MODEL',
  'DEFAULT_LLM',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'GROK_API_KEY',
] as const;

const importConfigModule = async () => {
  vi.resetModules();
  return await import('../src/config.js');
};

const withEnv = async (
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void
) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe('Config alignment with latest py-browser-use defaults', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('creates default config with gpt-4.1-mini as the default LLM model', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    try {
      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: undefined,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          const llm = CONFIG.get_default_llm();
          expect(llm.model).toBe('gpt-4.1-mini');
          expect(llm.api_key).toBeNull();

          const configPath = path.join(tempDir, 'config.json');
          expect(fs.existsSync(configPath)).toBe(true);

          const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const persistedDefault = Object.values(persisted.llm)[0] as {
            api_key: string | null;
          };
          expect(persistedDefault.api_key).toBeNull();
          if (process.platform !== 'win32') {
            expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
            expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
          }
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tightens permissions on existing config files that may contain api keys', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    try {
      const configPath = path.join(tempDir, 'config.json');
      const now = new Date().toISOString();
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            browser_profile: {
              'profile-1': {
                id: 'profile-1',
                default: true,
                created_at: now,
              },
            },
            llm: {
              'llm-1': {
                id: 'llm-1',
                default: true,
                created_at: now,
                model: 'gpt-4.1-mini',
                api_key: 'sk-secret',
              },
            },
            agent: {
              'agent-1': {
                id: 'agent-1',
                default: true,
                created_at: now,
              },
            },
          },
          null,
          2
        ),
        'utf-8'
      );
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o644);
      }

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          expect(CONFIG.get_default_llm().api_key).toBe('sk-secret');
          if (process.platform !== 'win32') {
            expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
          }
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a malformed config file with permissive defaults', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    const configPath = path.join(tempDir, 'config.json');
    const malformed =
      '{"browser_profile":{"locked":{"allowed_domains":["example.com"]}},"llm":{"api_key":"sk-do-not-delete"';
    try {
      fs.writeFileSync(configPath, malformed, 'utf-8');

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          expect(() => CONFIG.get_default_profile()).toThrow(
            /Existing config was not modified/
          );
        }
      );

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(malformed);
      if (process.platform !== 'win32') {
        expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects oversized config files without reading or replacing them', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    const configPath = path.join(tempDir, 'config.json');
    try {
      const { MAX_CONFIG_FILE_BYTES } = await importConfigModule();
      fs.writeFileSync(configPath, 'x');
      fs.truncateSync(configPath, MAX_CONFIG_FILE_BYTES + 1);

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          expect(() => CONFIG.get_default_profile()).toThrow(
            new RegExp(`exceeds ${MAX_CONFIG_FILE_BYTES} bytes`)
          );
        }
      );

      expect(fs.statSync(configPath).size).toBe(MAX_CONFIG_FILE_BYTES + 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects non-file config paths without changing directory permissions', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    const configPath = path.join(tempDir, 'config.json');
    try {
      fs.mkdirSync(configPath, { mode: 0o700 });

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          expect(() => CONFIG.get_default_profile()).toThrow(
            /not a regular file/
          );
        }
      );

      expect(fs.statSync(configPath).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symbolic links as config inputs',
    async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-config-')
      );
      const targetPath = path.join(tempDir, 'target.json');
      const configPath = path.join(tempDir, 'config.json');
      fs.writeFileSync(targetPath, '{}');
      fs.symlinkSync(targetPath, configPath);

      try {
        await withEnv(
          {
            BROWSER_USE_CONFIG_DIR: tempDir,
            BROWSER_USE_CONFIG_PATH: configPath,
          },
          async () => {
            const { CONFIG } = await importConfigModule();
            expect(() => CONFIG.get_default_profile()).toThrow(
              /not a regular file/
            );
          }
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it('rejects a config path replaced while it is being opened', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    const configPath = path.join(tempDir, 'config.json');
    const replacementPath = path.join(tempDir, 'replacement.json');
    fs.writeFileSync(configPath, '{}');
    fs.writeFileSync(replacementPath, '{}');

    try {
      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          const originalOpen = fs.openSync.bind(fs);
          const openSpy = vi
            .spyOn(fs, 'openSync')
            .mockImplementationOnce((...args) => {
              fs.rmSync(configPath);
              fs.renameSync(replacementPath, configPath);
              return originalOpen(...args);
            });
          try {
            expect(() => CONFIG.get_default_profile()).toThrow(
              /changed while opening/
            );
          } finally {
            openSpy.mockRestore();
          }
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves unsupported legacy config instead of deleting it', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    const configPath = path.join(tempDir, 'config.json');
    const legacy = JSON.stringify(
      {
        allowed_domains: ['example.com'],
        api_key: 'sk-do-not-delete',
      },
      null,
      2
    );
    try {
      fs.writeFileSync(configPath, legacy, 'utf-8');

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
        },
        async () => {
          const { CONFIG } = await importConfigModule();
          expect(() => CONFIG.get_default_profile()).toThrow(
            /Unsupported legacy config format/
          );
        }
      );

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(legacy);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes placeholder llm api keys from config files', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    try {
      const configPath = path.join(tempDir, 'config.json');
      const now = new Date().toISOString();
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            browser_profile: {
              'profile-1': {
                id: 'profile-1',
                default: true,
                created_at: now,
                headless: false,
                user_data_dir: null,
                allowed_domains: null,
                downloads_path: null,
              },
            },
            llm: {
              'llm-1': {
                id: 'llm-1',
                default: true,
                created_at: now,
                model: 'gpt-4.1-mini',
                api_key: 'your-openai-api-key-here',
              },
            },
            agent: {
              'agent-1': {
                id: 'agent-1',
                default: true,
                created_at: now,
                max_steps: null,
                use_vision: null,
                system_prompt: null,
              },
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_CONFIG_PATH: configPath,
          // Keep key defined-but-empty so dotenv won't repopulate it from .env
          // when the config module is imported during the test.
          OPENAI_API_KEY: '',
        },
        async () => {
          const { CONFIG, load_browser_use_config } =
            await importConfigModule();
          expect(CONFIG.get_default_llm().api_key).toBeNull();
          expect(load_browser_use_config().llm.api_key).toBeNull();
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps proxy env vars into browser_profile.proxy in load_browser_use_config', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    try {
      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_PROXY_URL: 'http://proxy.internal:8080',
          BROWSER_USE_NO_PROXY: 'localhost, 127.0.0.1, *.internal',
          BROWSER_USE_PROXY_USERNAME: 'proxy-user',
          BROWSER_USE_PROXY_PASSWORD: 'proxy-pass',
        },
        async () => {
          const { load_browser_use_config } = await importConfigModule();
          const config = load_browser_use_config();
          expect(config.browser_profile.proxy).toEqual({
            server: 'http://proxy.internal:8080',
            bypass: 'localhost,127.0.0.1,*.internal',
            username: 'proxy-user',
            password: 'proxy-pass',
          });
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('maps BROWSER_USE_DISABLE_EXTENSIONS into enable_default_extensions', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    try {
      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_DISABLE_EXTENSIONS: '1',
        },
        async () => {
          const { load_browser_use_config } = await importConfigModule();
          const config = load_browser_use_config();
          expect(config.browser_profile.enable_default_extensions).toBe(false);
        }
      );

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          BROWSER_USE_DISABLE_EXTENSIONS: 'false',
        },
        async () => {
          const { load_browser_use_config } = await importConfigModule();
          const config = load_browser_use_config();
          expect(config.browser_profile.enable_default_extensions).toBe(true);
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports GROQ_API_KEY with GROK_API_KEY backward compatibility', async () => {
    await withEnv(
      {
        GROQ_API_KEY: 'groq-live-key',
        GROK_API_KEY: undefined,
      },
      async () => {
        const { CONFIG } = await importConfigModule();
        expect(CONFIG.GROQ_API_KEY).toBe('groq-live-key');
        expect(CONFIG.GROK_API_KEY).toBe('groq-live-key');
      }
    );

    await withEnv(
      {
        GROQ_API_KEY: undefined,
        GROK_API_KEY: 'legacy-grok-key',
      },
      async () => {
        const { CONFIG } = await importConfigModule();
        expect(CONFIG.GROQ_API_KEY).toBe('legacy-grok-key');
        expect(CONFIG.GROK_API_KEY).toBe('legacy-grok-key');
      }
    );
  });

  it('maps DEFAULT_LLM to llm.model when provider-specific override is absent', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-config-')
    );
    try {
      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          DEFAULT_LLM: 'gpt-4.1-nano',
          BROWSER_USE_LLM_MODEL: undefined,
        },
        async () => {
          const { load_browser_use_config } = await importConfigModule();
          const config = load_browser_use_config();
          expect(config.llm.model).toBe('gpt-4.1-nano');
        }
      );

      await withEnv(
        {
          BROWSER_USE_CONFIG_DIR: tempDir,
          DEFAULT_LLM: 'gpt-4.1-nano',
          BROWSER_USE_LLM_MODEL: 'gpt-4.1-mini',
        },
        async () => {
          const { load_browser_use_config } = await importConfigModule();
          const config = load_browser_use_config();
          expect(config.llm.model).toBe('gpt-4.1-mini');
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
