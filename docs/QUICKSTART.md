# Quick Start Guide

Get up and running with Browser-Use in 5 minutes.

## Prerequisites

- Node.js 20.20+ (Node 20) or 22.22+ installed
- An API key from a supported LLM provider (OpenAI, Anthropic, etc.)

## Step 1: Install Browser-Use

```bash
npm install browser-use
```

This will also install Playwright as a dependency.

## Step 2: Install Browser Binaries

```bash
npx playwright install chromium
```

## Step 3: Set Up Environment Variables

Create a `.env` file in your project root:

```env
# Choose your LLM provider
OPENAI_API_KEY=sk-your-openai-key
# or
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
# or
GOOGLE_API_KEY=your-google-key
```

## Step 4: Create Your First Agent

Create a file `example.ts`:

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';
import 'dotenv/config';

async function main() {
  // Initialize the LLM
  const llm = new ChatOpenAI({
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Create the agent with a task
  const agent = new Agent({
    task: 'Search for "browser automation" on Google and tell me the first result',
    llm,
    use_vision: true, // Enable screenshot analysis
  });

  // Run the agent
  const history = await agent.run();

  // Output results
  if (history.is_successful()) {
    console.log('Task completed successfully!');
    console.log('Result:', history.final_result());
  } else {
    console.log('Task failed');
    console.log('Errors:', history.errors());
  }
}

main().catch(console.error);
```

## Step 5: Run Your Agent

```bash
npx tsx example.ts
```

## Using the CLI

Browser-Use includes a CLI for quick tasks:

```bash
# Start interactive mode (TTY only)
npx browser-use

# Run a simple task
npx browser-use "Go to example.com and extract the page title"

# Equivalent one-shot mode
npx browser-use -p "Go to example.com and extract the page title"

# Select model/provider by model name prefix
npx browser-use --model claude-opus-5 -p "Search for AI news"

# Select provider explicitly (uses provider default model)
npx browser-use --provider anthropic -p "Search for AI news"

# Experimental Codex OAuth provider
npx browser-use auth codex login
npx browser-use --provider codex -p "Search for AI news"

# Headless mode
npx browser-use --headless -p "Check the weather"

# Restrict navigation to trusted domains
npx browser-use --allowed-domains "example.com,*.example.org" -p "Check account status"

# Attach to existing Chromium via CDP
npx browser-use --cdp-url http://localhost:9222 -p "Open current tab and summarize"

# Start MCP server mode
npx browser-use --mcp
```

Interactive mode commands:

- `help`: show interactive usage
- `exit`: quit interactive mode

Supported CLI options:

- `--version`: print package version
- `--provider <name>`: force provider (`openai|anthropic|google|deepseek|groq|openrouter|azure|codex|mistral|cerebras|vercel|oci|ollama|browser-use|aws|aws-anthropic`)
- `--model <name>`: choose model/provider (for example `gpt-*`, `codex:gpt-5.5`, `claude-*`, `gemini-*`)
- `-p, --prompt <task>`: one-shot task
- `--headless`: headless browser mode
- `--allowed-domains <items>`: comma-separated navigation allowlist
- `--window-width <px>`, `--window-height <px>`: browser window size
- `--user-data-dir <path>`, `--profile-directory <name>`: Chrome profile controls
- `--cdp-url <url>`: connect to existing Chromium via CDP
- `--debug`: verbose debug logging
- `--mcp`: run MCP server

## Using with Claude Desktop (MCP)

Start Browser-Use as an MCP server:

```bash
npx browser-use --mcp
```

Then add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"]
    }
  }
}
```

## Common Options

### Headless Mode

Run without displaying the browser:

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  browser_profile: new BrowserProfile({ headless: true }),
});
```

### Custom Browser Session

Use an existing Playwright browser:

```typescript
import { chromium } from 'playwright';
import { BrowserSession } from 'browser-use';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

const session = new BrowserSession({
  browser,
  browser_context: context,
  page,
});

const agent = new Agent({
  task: 'Your task',
  llm,
  browser_session: session,
});
```

### Vision Mode

Enable or disable screenshot-based understanding:

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  use_vision: true, // Enable vision
  vision_detail_level: 'high', // 'auto', 'low', or 'high'
});
```

### Step Limits

Control maximum execution steps:

```typescript
// Limit to 20 steps
const history = await agent.run(20);
```

## Next Steps

- Read the [Architecture](./ARCHITECTURE.md) guide to understand how Browser-Use works
- Explore [Built-in Actions](./ACTIONS.md) available to agents
- Learn about [LLM Provider Configuration](./LLM_PROVIDERS.md)
- Check out [Examples](./EXAMPLES.md) for more use cases

## Troubleshooting

### Browser doesn't launch

Ensure Playwright browsers are installed:

```bash
npx playwright install chromium
```

### LLM errors

1. Verify your API key is set correctly
2. Check your API quota/limits
3. Try a different model if rate-limited

### Timeout errors

Increase timeouts in agent settings:

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  llm_timeout: 120, // 120 seconds for LLM calls
  step_timeout: 300, // 300 seconds per step
});
```
