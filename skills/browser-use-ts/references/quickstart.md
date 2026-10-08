# Quickstart

## Install

```bash
npm install browser-use
npx playwright install chromium
```

Set the key for the provider you use, for example:

```bash
export ANTHROPIC_API_KEY=...
# or OPENAI_API_KEY, GOOGLE_API_KEY, BROWSER_USE_API_KEY, ...
```

## First agent

```typescript
import { Agent } from 'browser-use';
import { ChatAnthropic } from 'browser-use/llm/anthropic';

const agent = new Agent({
  task: 'Open example.com and report the page title',
  llm: new ChatAnthropic({ model: 'claude-opus-5' }),
});

try {
  const history = await agent.run(30);
  console.log(history.is_successful(), history.final_result());
} finally {
  await agent.close();
}
```

Run TypeScript files with `npx tsx file.ts`.

## CLI

```bash
npx browser-use "Find the latest release notes on example.com"
npx browser-use --model claude-opus-5 -p "Summarize the front page of example.com"
npx browser-use --provider openai --headless -p "Check the weather in Paris"
npx browser-use --allowed-domains "example.com,*.example.org" -p "..."
npx browser-use --cdp-url http://localhost:9222 -p "Summarize the current tab"
npx browser-use --mcp          # MCP server with an autonomous agent tool
npx browser-use --cli-mcp      # MCP server with direct browser commands
```

`browser-use-direct` drives a persistent browser one command at a time (see
`integrations.md`).

## Useful environment variables

| Variable                    | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `BROWSER_USE_HEADLESS`      | Default `headless` for new BrowserProfile instances |
| `BROWSER_USE_LOGGING_LEVEL` | `debug`, `info`, `warning`, or `error`              |
| `BROWSER_USE_API_KEY`       | Browser Use Cloud browsers and `ChatBrowserUse`     |

The package sends no telemetry.
