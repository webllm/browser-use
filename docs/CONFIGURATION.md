# Configuration Guide

Browser-Use provides flexible configuration through environment variables, configuration files, and constructor parameters.

## Configuration Priority

Configuration values are resolved in this order (highest priority first):

1. **Constructor Parameters** - Direct values passed to Agent, BrowserSession, etc.
2. **Environment Variables** - System environment variables
3. **Configuration File** - `~/.config/browseruse/config.json`
4. **Default Values** - Built-in defaults

## Environment Variables

### Core Settings

| Variable                       | Type      | Default                | Description                                                  |
| ------------------------------ | --------- | ---------------------- | ------------------------------------------------------------ |
| `BROWSER_USE_LOGGING_LEVEL`    | `string`  | `'info'`               | Log level: `debug`, `info`, `warning`, `error`               |
| `BROWSER_USE_CONFIG_DIR`       | `string`  | `~/.config/browseruse` | Configuration directory path                                 |
| `BROWSER_USE_HEADLESS`         | `boolean` | display detection      | Default `headless` for profiles that do not set it           |
| `BROWSER_USE_DISABLE_SECURITY` | `boolean` | unset (secure)         | Opt-in: disable browser web security for config/MCP profiles |
| `IN_DOCKER`                    | `boolean` | auto-detect            | Force Docker mode behavior (sandbox defaults, launch args)   |
| `BROWSER_USE_ALLOWED_DOMAINS`  | `string`  | -                      | Comma-separated allowed domains                              |

### LLM Settings

| Variable                         | Type     | Default                                 | Description                    |
| -------------------------------- | -------- | --------------------------------------- | ------------------------------ |
| `BROWSER_USE_LLM_MODEL`          | `string` | -                                       | Default LLM model              |
| `OPENAI_API_KEY`                 | `string` | -                                       | OpenAI API key                 |
| `BROWSER_USE_CODEX_MODEL`        | `string` | `gpt-5.5`                               | Default Codex OAuth model      |
| `BROWSER_USE_CODEX_BASE_URL`     | `string` | `https://chatgpt.com/backend-api/codex` | Codex OAuth backend URL        |
| `BROWSER_USE_CODEX_ACCESS_TOKEN` | `string` | -                                       | Short-lived Codex access token |
| `ANTHROPIC_API_KEY`              | `string` | -                                       | Anthropic API key              |
| `GOOGLE_API_KEY`                 | `string` | -                                       | Google API key                 |
| `AZURE_OPENAI_API_KEY`           | `string` | -                                       | Azure OpenAI API key           |
| `AZURE_OPENAI_ENDPOINT`          | `string` | -                                       | Azure OpenAI endpoint          |
| `GROQ_API_KEY`                   | `string` | -                                       | Groq API key                   |
| `DEEPSEEK_API_KEY`               | `string` | -                                       | DeepSeek API key               |
| `OPENROUTER_API_KEY`             | `string` | -                                       | OpenRouter API key             |
| `ORCAROUTER_API_KEY`             | `string` | -                                       | OrcaRouter API key             |

### Display Settings

| Variable                    | Type     | Default | Description            |
| --------------------------- | -------- | ------- | ---------------------- |
| `BROWSER_USE_SCREEN_WIDTH`  | `number` | -       | Override screen width  |
| `BROWSER_USE_SCREEN_HEIGHT` | `number` | -       | Override screen height |

This package sends no telemetry, so there is no telemetry setting.

## Configuration File

The configuration file is located at `~/.config/browseruse/config.json`.

### Structure

```json
{
  "browser_profile": {
    "default-profile-id": {
      "id": "default-profile-id",
      "default": true,
      "headless": false,
      "user_data_dir": "~/.config/browseruse/profiles/default",
      "viewport": {
        "width": 1280,
        "height": 720
      }
    }
  },
  "llm": {
    "default-llm-id": {
      "id": "default-llm-id",
      "default": true,
      "model": "gpt-4o",
      "api_key": "sk-...",
      "temperature": 0.7
    }
  },
  "agent": {
    "default-agent-id": {
      "id": "default-agent-id",
      "default": true,
      "max_steps": 100,
      "use_vision": true,
      "max_failures": 3
    }
  }
}
```

### Browser Profile Configuration

```json
{
  "browser_profile": {
    "my-profile": {
      "id": "my-profile",
      "default": false,
      "headless": true,
      "user_data_dir": "/path/to/profile",
      "viewport": { "width": 1920, "height": 1080 },
      "proxy": {
        "server": "http://proxy.example.com:8080",
        "username": "user",
        "password": "pass"
      },
      "user_agent": "Mozilla/5.0 ...",
      "locale": "en-US",
      "timezone_id": "America/New_York",
      "geolocation": {
        "latitude": 40.7128,
        "longitude": -74.006
      }
    }
  }
}
```

### LLM Configuration

```json
{
  "llm": {
    "openai-gpt4": {
      "id": "openai-gpt4",
      "default": true,
      "model": "gpt-4o",
      "api_key": "sk-...",
      "temperature": 0.7
    },
    "anthropic-claude": {
      "id": "anthropic-claude",
      "model": "claude-opus-5",
      "api_key": "sk-ant-...",
      "temperature": 0.7
    }
  }
}
```

### Agent Configuration

```json
{
  "agent": {
    "default": {
      "id": "default",
      "default": true,
      "max_steps": 100,
      "use_vision": true,
      "vision_detail_level": "auto",
      "max_failures": 3,
      "retry_delay": 10,
      "final_response_after_failure": true,
      "max_actions_per_step": 5,
      "use_judge": true,
      "judge_llm": null,
      "ground_truth": null,
      "enable_planning": true,
      "planning_replan_on_stall": 3,
      "planning_exploration_limit": 5,
      "use_thinking": true,
      "flash_mode": false,
      "validate_output": false
    }
  }
}
```

## BrowserProfile Options

### Display Options

```typescript
const profile = new BrowserProfile({
  // Headless mode
  headless: true, // true, false, or null for auto-detect

  // Viewport (for headless or forced viewport mode)
  viewport: { width: 1280, height: 720 },

  // Window size (for headed mode)
  window_size: { width: 1920, height: 1080 },

  // Window position
  window_position: { width: 0, height: 0 },

  // Device scale factor
  device_scale_factor: 2,

  // Mobile emulation
  is_mobile: false,
  has_touch: false,
});
```

### Network Options

```typescript
const profile = new BrowserProfile({
  // Proxy configuration
  proxy: {
    server: 'http://proxy.example.com:8080',
    bypass: 'localhost',
    username: 'user',
    password: 'pass',
  },

  // SSL/TLS
  ignore_https_errors: false,

  // Offline mode
  offline: false,

  // Extra HTTP headers
  extra_http_headers: {
    'X-Custom-Header': 'value',
  },
});
```

### Identity Options

```typescript
const profile = new BrowserProfile({
  // User agent
  user_agent: 'Mozilla/5.0 ...',

  // Locale
  locale: 'en-US',

  // Timezone
  timezone_id: 'America/New_York',

  // Geolocation
  geolocation: {
    latitude: 40.7128,
    longitude: -74.006,
    accuracy: 100,
  },

  // Color scheme
  color_scheme: 'light', // 'light', 'dark', 'no-preference'

  // Reduced motion
  reduced_motion: 'no-preference',
});
```

### Storage Options

The browser runs on a profile directory, as in the Python library:

- With `user_data_dir` set, cookies, logins, and other site data persist in
  that directory between sessions. If another browser is using it, the session
  falls back to a temporary profile and logs a warning.
- Without it, each session starts on a fresh temporary profile that is deleted
  when the session closes.
- A Google Chrome profile directory (for example under
  `~/Library/Application Support/Google/Chrome`) is copied to a temporary
  directory first, so the session can use its logins without locking or
  changing it.

```typescript
const profile = new BrowserProfile({
  // Profile directory; cookies and logins persist here between sessions
  user_data_dir: '/path/to/profile',

  // Storage state (cookies, localStorage)
  storage_state: '/path/to/state.json',
  // or
  storage_state: {
    cookies: [...],
    origins: [...]
  },

  // Cookies file
  cookies_file: '/path/to/cookies.json'
});
```

### Performance Options

```typescript
const profile = new BrowserProfile({
  // Slow down operations (debugging)
  slow_mo: 100, // milliseconds

  // Timeouts
  timeout: 30000,
  default_timeout: 30000,
  default_navigation_timeout: 30000,

  // Page load timing
  minimum_wait_page_load_time: 0.25, // seconds
  wait_for_network_idle_page_load_time: 0.5,
  maximum_wait_page_load_time: 5.0,

  // Action timing
  wait_between_actions: 0.5,
});
```

### Browser-Use Specific Options

```typescript
const profile = new BrowserProfile({
  // Viewport expansion for scrolling detection
  viewport_expansion: 500,

  // Highlight interactive elements
  highlight_elements: true,

  // Include dynamic attributes in DOM
  include_dynamic_attributes: true,

  // Enable default extensions (uBlock Origin Lite, cookie banner blocking)
  enable_default_extensions: true,

  // Stealth mode
  stealth: false,

  // Disable security features (for testing)
  disable_security: false,

  // Deterministic rendering (for consistent screenshots)
  deterministic_rendering: false,
});
```

The default extensions run in headed and headless sessions. Playwright's
headless shell build cannot run extensions, so a headless session that loads
extensions uses the full Chromium build in new headless mode when it is
installed, as the Python library does. Set `BROWSER_USE_DISABLE_EXTENSIONS=1`
to skip the extensions; headless sessions then keep the faster headless shell.

## Agent Settings

### Basic Settings

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,

  // Per-step limits
  max_actions_per_step: 5,

  // Failure handling
  max_failures: 3,
  retry_delay: 10, // seconds
  final_response_after_failure: true,
});

// Overall step cap is set when running:
const history = await agent.run(100);
```

### Vision Settings

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,

  // Enable vision
  use_vision: true,

  // Vision detail level
  // 'auto' - Let the model decide
  // 'low' - Lower resolution, fewer tokens
  // 'high' - Higher resolution, more tokens
  vision_detail_level: 'auto',
});
```

### Prompt Settings

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,

  // Extended thinking prompts
  use_thinking: true,

  // Optimized prompts for speed
  flash_mode: false,

  // Override system message
  override_system_message: 'Custom system message...',

  // Extend system message
  extend_system_message: 'Additional instructions...',
});
```

### Output Settings

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,

  // Strict output validation
  validate_output: true,

  // Save conversation logs
  save_conversation_path: './logs/conversations',

  // Generate session GIF
  generate_gif: true,
  // or specify path
  generate_gif: './recordings/session.gif',
});
```

### Timeout Settings

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,

  // LLM call timeout
  llm_timeout: 60, // 60 seconds

  // Step execution timeout
  step_timeout: 180, // 3 minutes
});
```

### DOM Settings

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,

  // Include additional HTML attributes
  include_attributes: ['data-testid', 'aria-label'],

  // Include tool call examples in prompts
  include_tool_call_examples: true,
});
```

## Creating Custom Configurations

### Programmatic Configuration

```typescript
import { Agent, BrowserSession, BrowserProfile } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

// Create custom profile
const profile = new BrowserProfile({
  headless: false,
  viewport: { width: 1920, height: 1080 },
  user_data_dir: './my-profile',
  highlight_elements: true,
});

// Create session with profile
const session = new BrowserSession({
  browser_profile: profile,
});

// Create LLM
const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.5,
});

// Create agent with all options
const agent = new Agent({
  task: 'Your task',
  llm,
  browser_session: session,
  use_vision: true,
  max_failures: 5,
});

const history = await agent.run(50);
```

### Using .env Files

Create a `.env` file:

```env
# LLM
OPENAI_API_KEY=sk-your-key
BROWSER_USE_LLM_MODEL=gpt-4o

# Browser
BROWSER_USE_HEADLESS=false

# Logging
BROWSER_USE_LOGGING_LEVEL=debug
```

Load with dotenv:

```typescript
import 'dotenv/config';
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

const agent = new Agent({
  task: 'Your task',
  llm: new ChatOpenAI({
    model: process.env.BROWSER_USE_LLM_MODEL || 'gpt-4o',
  }),
});
```

### Docker Configuration

For Docker environments, use these settings:

```typescript
const profile = new BrowserProfile({
  headless: true,
  chromium_sandbox: false, // Recommended for containerized CI/Docker
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ],
});
```

If sandbox is enabled and Chromium launch fails with `No usable sandbox`, browser-use
automatically retries once with no-sandbox flags and logs a warning. For deterministic
behavior in CI, prefer setting `chromium_sandbox: false` explicitly in that environment.

Or set environment variables:

```dockerfile
ENV BROWSER_USE_HEADLESS=true
ENV IN_DOCKER=true
```
