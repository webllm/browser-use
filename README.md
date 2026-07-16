<p align="center">
  <h1 align="center">🌐 Browser-Use</h1>
  <p align="center">
    <strong>Make websites accessible for AI agents — in TypeScript</strong>
  </p>
  <p align="center">
    A TypeScript-first library for building AI-powered web agents that can autonomously browse, interact with, and extract data from the web using LLMs and Playwright.
  </p>
</p>

<p align="center">
  <a href="https://github.com/webllm/browser-use/workflows/Node%20CI"><img src="https://github.com/webllm/browser-use/workflows/Node%20CI/badge.svg" alt="Node CI"></a>
  <a href="https://www.npmjs.com/package/browser-use"><img src="https://img.shields.io/npm/v/browser-use.svg" alt="npm"></a>
  <a href="https://www.npmjs.com/package/browser-use"><img src="https://img.shields.io/npm/dm/browser-use.svg" alt="npm downloads"></a>
  <img src="https://img.shields.io/npm/l/browser-use" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-first-blue" alt="TypeScript">
</p>

---

> **Production-capable TypeScript port**, inspired by and behavior-aligned with Python [browser-use](https://github.com/browser-use/browser-use) — with a native Node.js experience, full type safety, and first-class support for all major LLM providers.

## ✨ Features

- 🤖 **Autonomous Browser Control** — AI-driven navigation, clicking, typing, form filling, scrolling, and tab management
- 🧠 **15+ LLM Providers & Adapters** — OpenAI, Anthropic, Google Gemini, Azure, AWS Bedrock, Groq, Ollama, DeepSeek, OpenRouter, Mistral, Cerebras, Browser Use, LiteLLM, OCI Raw, Vercel, and custom providers
- 👁️ **Vision Support** — Screenshot-based understanding for visual web interactions
- 🔧 **45+ Built-in Actions** — Navigation, element interaction, scrolling, forms, tabs, content extraction, file I/O, and more
- 🧩 **Custom Actions** — Extensible registry with Zod schema validation, domain restrictions, and page filters
- 🔌 **MCP Server** — Model Context Protocol support for Claude Desktop and MCP-compatible clients
- ⌨️ **CLI Tool** — Interactive and one-shot modes for quick browser tasks
- 🔒 **Security First** — Sensitive data masking, domain restrictions, and Chromium sandboxing
- 📊 **Observability** — Event system, telemetry, performance tracing, and session recording (GIF)
- 🐳 **Docker Ready** — Configurable for containerized and CI/CD environments

## 🚀 Quick Start

### Installation

```bash
npm install browser-use
# Playwright browsers are installed automatically via postinstall
```

### Set Up Your API Key

```bash
export OPENAI_API_KEY=sk-your-api-key
# or ANTHROPIC_API_KEY, GOOGLE_API_KEY, etc.
```

### Run Your First Agent

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

const agent = new Agent({
  task: 'Go to google.com and search for "TypeScript tutorials"',
  llm: new ChatOpenAI({
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const history = await agent.run();
console.log('Result:', history.final_result());
console.log('Success:', history.is_successful());
```

```bash
npx tsx example.ts
```

### Use the CLI

```bash
# Interactive mode
npx browser-use

# One-shot task
npx browser-use "Go to example.com and extract the page title"

# With specific model
npx browser-use --model claude-sonnet-4-20250514 -p "Search for AI news"

# Headless mode
npx browser-use --headless -p "Check the weather"

# MCP server mode
npx browser-use --mcp

# Minimal direct-browser MCP server for coding agents
npx browser-use --cli-mcp

# Install the bundled coding-agent skill (codex, claude, cursor, etc.)
npx browser-use skill install --target codex
```

The [bundled browser-use skill](./skills/browser-use/SKILL.md) teaches coding
agents to drive the persistent browser through the two-tool CLI MCP server or
the `browser-use-direct` fallback. Run `npx browser-use skill install` without
a target to install it for every supported coding agent, or use
`npx browser-use skill show` to inspect it first.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser-Use                      │
├─────────────────────────────────────────────────────┤
│  Agent ← MessageManager ← LLM Providers             │
│    ↓                                                │
│  Controller → Action Registry → BrowserSession      │
│                                      ↓              │
│                                  DomService         │
└─────────────────────────────────────────────────────┘
```

| Component          | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| **Agent**          | Central orchestrator — runs the observe → think → act loop             |
| **Controller**     | Manages action registration and execution via Registry                 |
| **BrowserSession** | Playwright wrapper — browser lifecycle, tab management, screenshots    |
| **DomService**     | Extracts interactive elements with indexed mapping for LLM consumption |
| **MessageManager** | Manages LLM conversation history with token optimization               |
| **LLM Providers**  | Unified `BaseChatModel` interface across 15+ providers and adapters    |

### How It Works

1. **Agent** receives a natural language task
2. **DomService** extracts the current page state (interactive elements + optional screenshot)
3. **LLM** analyzes the state and returns actions to take
4. **Controller** validates and executes actions through the **Registry**
5. Results feed back to the LLM for the next step
6. Loop continues until `done` action or `max_steps`

## 🔌 LLM Providers

| Provider          | Import                        | Vision | Notes                                         |
| ----------------- | ----------------------------- | ------ | --------------------------------------------- |
| **OpenAI**        | `browser-use/llm/openai`      | ✅     | Default provider, reasoning models (o1/o3/o4) |
| **Codex**         | `browser-use/llm/codex`       | ✅     | Experimental ChatGPT/Codex OAuth provider     |
| **Anthropic**     | `browser-use/llm/anthropic`   | ✅     | Prompt caching support                        |
| **Google Gemini** | `browser-use/llm/google`      | ✅     | Extended thinking support                     |
| **Azure OpenAI**  | `browser-use/llm/azure`       | ✅     | Enterprise deployment                         |
| **AWS Bedrock**   | `browser-use/llm/aws`         | ✅     | Claude via AWS                                |
| **Groq**          | `browser-use/llm/groq`        | ❌     | Fastest inference                             |
| **Ollama**        | `browser-use/llm/ollama`      | ❌     | Local/self-hosted models                      |
| **DeepSeek**      | `browser-use/llm/deepseek`    | ❌     | Cost-effective                                |
| **OpenRouter**    | `browser-use/llm/openrouter`  | Varies | Multi-model routing                           |
| **Mistral**       | `browser-use/llm/mistral`     | Varies | Mistral models                                |
| **Cerebras**      | `browser-use/llm/cerebras`    | ❌     | Fast inference                                |
| **Browser Use**   | `browser-use/llm/browser-use` | Varies | Hosted Browser Use LLM                        |
| **LiteLLM**       | `browser-use/llm/litellm`     | Varies | OpenAI-compatible LiteLLM gateway             |
| **OCI Raw**       | `browser-use/llm/oci-raw`     | Varies | Oracle Cloud Generative AI                    |
| **Vercel**        | `browser-use/llm/vercel`      | Varies | Vercel AI Gateway / routed models             |

<details>
<summary>Provider examples</summary>

```typescript
// OpenAI
import { ChatOpenAI } from 'browser-use/llm/openai';
const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
});

// Anthropic
import { ChatAnthropic } from 'browser-use/llm/anthropic';
const llm = new ChatAnthropic({
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Google Gemini
import { ChatGoogle } from 'browser-use/llm/google';
const llm = new ChatGoogle('gemini-2.5-flash');

// Ollama (local)
import { ChatOllama } from 'browser-use/llm/ollama';
const llm = new ChatOllama('llama3', 'http://localhost:11434');

// OpenAI Reasoning Models
const llm = new ChatOpenAI({ model: 'o3-mini', reasoningEffort: 'medium' });

// Codex OAuth provider (experimental)
// First run: npx browser-use auth codex login
import { ChatCodex } from 'browser-use/llm/codex';
const codexLlm = new ChatCodex({ model: 'gpt-5.5' });

// Browser Use gateway: one BROWSER_USE_API_KEY can route provider/model ids
import { ChatBrowserUse } from 'browser-use/llm/browser-use';
const gatewayLlm = new ChatBrowserUse({
  model: 'anthropic/claude-sonnet-4-6',
});
```

</details>

## 🎯 Code Examples

### Data Extraction

```typescript
const agent = new Agent({
  task: `Go to amazon.com, search for "wireless keyboard",
         extract the name, price, and rating of the first 5 products as JSON`,
  llm,
  use_vision: true,
});

const history = await agent.run(30);
console.log(history.final_result());
```

### Form Filling with Sensitive Data

```typescript
const agent = new Agent({
  task: 'Login to the dashboard',
  llm,
  sensitive_data: {
    '*.example.com': {
      username: process.env.SITE_USERNAME!,
      password: process.env.SITE_PASSWORD!,
    },
  },
  browser_session: new BrowserSession({
    browser_profile: new BrowserProfile({
      allowed_domains: ['*.example.com'],
    }),
  }),
});
```

### Custom Actions

```typescript
import fs from 'node:fs';
import { Controller, ActionResult } from 'browser-use';
import { z } from 'zod';

const controller = new Controller();

controller.registry.action('Save screenshot to file', {
  param_model: z.object({
    filename: z.string().describe('Output filename'),
  }),
})(async function save_screenshot(params, ctx) {
  const screenshot = await ctx.page.screenshot();
  fs.writeFileSync(`./screenshots/${params.filename}`, screenshot);
  return new ActionResult({
    extracted_content: `Screenshot saved as ${params.filename}`,
  });
});

const agent = new Agent({ task: '...', llm, controller });
```

### Vision Mode & Session Recording

```typescript
const agent = new Agent({
  task: 'Navigate to hacker news and summarize the top stories',
  llm,
  use_vision: true,
  vision_detail_level: 'high', // 'auto' | 'low' | 'high'
  generate_gif: './session.gif',
});
```

### Multi-Tab Workflows

```typescript
const agent = new Agent({
  task: `Compare "Sony WH-1000XM5" prices:
    1. Open amazon.com and search for the product
    2. Open bestbuy.com in a new tab and search
    3. Provide a comparison summary`,
  llm,
  use_vision: true,
});
```

### Event System

```typescript
const agent = new Agent({ task: '...', llm });

agent.eventbus.on('CreateAgentStepEvent', (event) => {
  console.log('Step completed:', event.step_id);
});

await agent.run();
```

## ⚙️ Configuration

### Agent Options

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  use_vision: true, // Enable screenshot analysis
  max_actions_per_step: 5, // Actions per LLM call
  max_failures: 3, // Max retries on failure
  generate_gif: './recording.gif', // Session recording
  validate_output: true, // Strict output validation
  use_thinking: true, // Extended thinking prompts
  llm_timeout: 60, // LLM call timeout (seconds)
  step_timeout: 180, // Step timeout (seconds)
  extend_system_message: 'Be concise', // Custom prompt additions
});

const history = await agent.run(50); // Max 50 steps
```

### Browser Profile

```typescript
import { BrowserProfile, BrowserSession } from 'browser-use';

const profile = new BrowserProfile({
  headless: true,
  viewport: { width: 1920, height: 1080 },
  user_data_dir: './my-profile', // Persistent sessions
  allowed_domains: ['*.example.com'], // Domain restrictions
  highlight_elements: true, // Visual debugging
  proxy: { server: 'http://proxy:8080' },
});

const session = new BrowserSession({ browser_profile: profile });
const agent = new Agent({ task: '...', llm, browser_session: session });
```

### Environment Variables

| Variable                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `OPENAI_API_KEY`              | OpenAI API key                                 |
| `ANTHROPIC_API_KEY`           | Anthropic API key                              |
| `GOOGLE_API_KEY`              | Google API key                                 |
| `BROWSER_USE_HEADLESS`        | Run browser headlessly (`true`/`false`)        |
| `BROWSER_USE_LOGGING_LEVEL`   | Log level: `debug`, `info`, `warning`, `error` |
| `BROWSER_USE_ALLOWED_DOMAINS` | Comma-separated domain allowlist               |
| `ANONYMIZED_TELEMETRY`        | Enable/disable anonymous telemetry             |

> See [Configuration Guide](./docs/CONFIGURATION.md) for the full list.

## 🔌 MCP Server (Claude Desktop)

Browser-Use can run as an [MCP](https://modelcontextprotocol.io/) server, exposing browser automation as tools for Claude Desktop:

```bash
npx browser-use --mcp
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "your-api-key"
      }
    }
  }
}
```

Core MCP tools include `retry_with_browser_use_agent`, `browser_navigate`, `browser_click`, `browser_type`, `browser_get_state`, `browser_extract_content`, `browser_scroll`, `browser_go_back`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_list_sessions`, `browser_close_session`, and `browser_close_all`. The server also exposes registered controller actions as additional MCP tools.

> See [MCP Server Guide](./docs/MCP_SERVER.md) for more details.

## 🔒 Security

- **Sensitive Data Masking** — Credentials are automatically masked in logs and LLM context
- **Domain Restrictions** — Lock browser navigation to trusted domains
- **Domain-scoped Secrets** — Credentials are only injected on matching domains
- **Sensitive Data Warning** — Browser-Use warns when `sensitive_data` is used without `allowed_domains`
- **Chromium Sandbox** — Enabled by default for production security

```typescript
const agent = new Agent({
  task: 'Login and fetch invoices',
  llm,
  sensitive_data: {
    '*.example.com': {
      username: process.env.USERNAME!,
      password: process.env.PASSWORD!,
    },
  },
  browser_session: new BrowserSession({
    browser_profile: new BrowserProfile({
      allowed_domains: ['*.example.com'],
    }),
  }),
});
```

> See [Security Guide](./docs/SECURITY.md) for production deployment best practices.

## 📚 Documentation

| Document                                 | Description                          |
| ---------------------------------------- | ------------------------------------ |
| [Quick Start](./docs/QUICKSTART.md)      | Get started in 5 minutes             |
| [Architecture](./docs/ARCHITECTURE.md)   | System design and component overview |
| [API Reference](./docs/API_REFERENCE.md) | Complete API documentation           |
| [Configuration](./docs/CONFIGURATION.md) | All configuration options            |
| [LLM Providers](./docs/LLM_PROVIDERS.md) | Provider setup and comparison        |
| [Actions](./docs/ACTIONS.md)             | Built-in and custom actions          |
| [MCP Server](./docs/MCP_SERVER.md)       | MCP integration guide                |
| [Security](./docs/SECURITY.md)           | Security best practices              |
| [Examples](./docs/EXAMPLES.md)           | More code examples                   |
| [Contributing](./docs/CONTRIBUTING.md)   | Contribution guidelines              |

## 🛠️ Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Lint & format
pnpm lint
pnpm prettier

# Type checking
pnpm typecheck

# Run an example
pnpm exec tsx examples/simple-search.ts
```

## Requirements

- **Node.js** >= 18.0.0
- **LLM API Key** — At least one supported provider
- **Playwright** — Installed automatically as a dependency

## 📄 License

[MIT](./LICENSE)
