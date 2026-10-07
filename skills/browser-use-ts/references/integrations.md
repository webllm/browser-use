# Integrations

## Claude browser toolset

Run Anthropic's `browser_toolset_20260801` with Browser Use executing every
action, plus a bounded Bash tool:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import {
  BrowserUseToolset,
  createBashTool,
  runBrowserToolsetConversation,
} from 'browser-use/integrations/anthropic';

const toolset = new BrowserUseToolset(); // or { browser: session } / { useCloud: true }
try {
  const { message } = await runBrowserToolsetConversation({
    client: new Anthropic(),
    toolset,
    tools: [createBashTool({ outputDir: 'outputs' })],
    task: 'Save the titles of the first three Hacker News posts to hn.md',
  });
  console.log(message.content);
} finally {
  await toolset.close();
}
```

- `javascript_exec`, `file_upload`, `read_console`, and `read_network` are off
  unless enabled in `configs`.
- `confirm(call)` approves each browser action; `uploadRoots` limits which
  local files `file_upload` may read.
- Drive your own loop with `toolset.toolParam()`, `toolset.execute(block)`, and
  `toolset.executeBatch(blocks)`.

## MCP servers

- `npx browser-use --mcp` exposes an autonomous agent and browser tools.
- `npx browser-use --cli-mcp` exposes `browser_exec` (direct commands) and
  `browser_screenshot` for coding agents.

## Direct CLI and skills

- `browser-use-direct <command>` drives a persistent browser: `open`, `state`,
  `click`, `input`, `type`, `keys`, `screenshot`, `get`, `eval`, and more.
- `browser-use-direct script <file|->` runs a JavaScript file with browser
  helpers (`goto_url`, `state`, `click`, `js`, `print`, ...). It runs with your
  Node.js privileges and is not available through MCP.
- `browser-use skill install` installs the `browser-use` skill for coding
  agents; `browser-use skill install --skill browser-use-ts` installs this one.
