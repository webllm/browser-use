# MCP Server Guide

Browser-Use includes a Model Context Protocol (MCP) server that enables integration with Claude Desktop and other MCP-compatible clients.

## What is MCP?

The Model Context Protocol (MCP) is Anthropic's open standard for connecting AI assistants to external tools and data sources. Browser-Use's MCP server exposes browser automation capabilities as MCP tools.

## Quick Start

### Starting the MCP Server

```bash
# Start in MCP mode
npx browser-use --mcp
```

### Minimal Coding-Agent Server

Use the smaller CLI-oriented server when a coding agent needs direct,
persistent browser control without the autonomous Agent and full Controller
tool catalog:

```bash
npx browser-use --cli-mcp
```

This mode exposes exactly two tools:

| Tool                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `browser_exec`       | Run one `browser-use-direct` command with an argument array    |
| `browser_screenshot` | Return a viewport or full-page PNG, optionally using `max_dim` |

`browser_exec` MUST NOT invoke a shell; `command` and `args` are passed to the
in-process direct-command runner. Calls are serialized so they cannot race the
persistent browser state. Text output is capped at 100,000 characters by
default; set `BROWSER_USE_CLI_MCP_MAX_OUTPUT_CHARS` to a positive integer to
change the cap. The collector stops retaining data as soon as this shared
stdout/stderr budget is exhausted.

PNG screenshots are limited to 32 MiB of encoded image data and 33,554,432
pixels before image decoding. Set
`BROWSER_USE_CLI_MCP_MAX_SCREENSHOT_BYTES` or
`BROWSER_USE_CLI_MCP_MAX_SCREENSHOT_PIXELS` to positive integers when a
different ceiling is required. Use `browser_screenshot` for in-memory images;
`browser_exec screenshot` is accepted only when an output path is supplied.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "browser-use-cli": {
      "command": "npx",
      "args": ["browser-use", "--cli-mcp"]
    }
  }
}
```

The protocol and validation behavior are verified by:

```bash
pnpm vitest run test/mcp-cli-server.test.ts test/skill-cli-direct-alignment.test.ts
```

### Configuring Claude Desktop

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

## Core MCP Tools

Browser-Use registers a set of convenience `browser_*` MCP tools and also exposes registered controller actions as additional tools.

| Tool                           | Purpose                                                                       | Key Parameters                                                    |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `retry_with_browser_use_agent` | Run an autonomous multi-step task with the agent                              | `task`, `max_steps?`, `model?`, `allowed_domains?`, `use_vision?` |
| `browser_navigate`             | Navigate to a URL                                                             | `url`, `new_tab?`                                                 |
| `browser_click`                | Click an element by index from `browser_get_state`                            | `index`, `new_tab?`                                               |
| `browser_type`                 | Type text into an element by index                                            | `index`, `text`                                                   |
| `browser_get_state`            | Inspect the current page, tabs, interactive elements, and optional screenshot | `include_screenshot?`, `include_recent_events?`                   |
| `browser_extract_content`      | Extract structured content from the current page                              | `query`, `extract_links?`                                         |
| `browser_scroll`               | Scroll the page up or down                                                    | `direction?`                                                      |
| `browser_go_back`              | Navigate back                                                                 | None                                                              |
| `browser_list_tabs`            | List open tabs                                                                | None                                                              |
| `browser_switch_tab`           | Switch tab by `tab_id`, `page_id`, or `tab_index`                             | `tab_id?`, `page_id?`, `tab_index?`                               |
| `browser_close_tab`            | Close a tab by `tab_id`, `page_id`, or `tab_index`                            | `tab_id?`, `page_id?`, `tab_index?`                               |
| `browser_list_sessions`        | List tracked browser sessions                                                 | None                                                              |
| `browser_close_session`        | Close one tracked browser session                                             | `session_id`                                                      |
| `browser_close_all`            | Close all tracked browser sessions                                            | None                                                              |

### Example: Autonomous Task

```json
{
  "task": "Go to amazon.com and search for 'wireless keyboard'",
  "max_steps": 30,
  "use_vision": true
}
```

### Example: Inspect Current Page State

```json
{
  "include_screenshot": true,
  "include_recent_events": false
}
```

## MCP Prompts

The MCP server also exposes prompt templates:

### web_search

Prompt for web search tasks.

```
Search the web for: {query}
```

### form_fill

Prompt for form filling tasks.

```
Fill out the form at {url} with the following data: {data}
```

### data_extraction

Prompt for data extraction tasks.

```
Extract {data_type} from {url}
```

## Configuration Options

### Environment Variables

```bash
# LLM Configuration
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
BROWSER_USE_LLM_MODEL=gpt-4o

# Browser Configuration
BROWSER_USE_HEADLESS=true

# MCP Configuration
BROWSER_USE_MCP_SESSION_TIMEOUT_MINUTES=10

# Telemetry
ANONYMIZED_TELEMETRY=false
```

### Claude Desktop with Full Configuration

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-your-key",
        "BROWSER_USE_HEADLESS": "true",
        "BROWSER_USE_LLM_MODEL": "gpt-4o",
        "ANONYMIZED_TELEMETRY": "false"
      }
    }
  }
}
```

## Usage Examples

### With Claude Desktop

Once configured, you can use natural language in Claude Desktop:

> "Use browser-use to search for the latest TypeScript release notes on GitHub"

Claude will:

1. Call `retry_with_browser_use_agent` or the direct `browser_*` tools
2. Display progress and results
3. Request screenshots via `browser_get_state` when needed

### Direct API Usage

```typescript
import { MCPServer } from 'browser-use/mcp';

const server = new MCPServer('browser-use', 'dev');

await server.start();
```

## Session Management

### Persistent Sessions

The MCP server tracks browser sessions across tool calls. This enables:

- Tab persistence
- Login state retention
- History tracking

### Session Lifecycle

1. **Start**: Browser launches on first tool call
2. **Active**: Session persists across subsequent calls
3. **Close**: Explicit `browser_close_session`, `browser_close_all`, or server shutdown

### Multiple Sessions

Use `browser_list_sessions`, `browser_close_session`, and `browser_close_all` to inspect and manage the sessions tracked by one MCP server process.

## Error Handling

### Common Errors

**Browser launch failed:**

```
Error: Browser failed to launch
```

Solution: Ensure Playwright browsers are installed:

```bash
npx playwright install chromium
```

**LLM API error:**

```
Error: API key not configured
```

Solution: Set the appropriate API key environment variable.

**Timeout error:**

```
Error: Operation timed out
```

Solution: Increase timeout or simplify the task.

### Error Responses

MCP tools return structured error responses:

```json
{
  "error": {
    "code": "BROWSER_ERROR",
    "message": "Navigation failed: Page not found"
  }
}
```

## Telemetry

The MCP server reports anonymous telemetry:

- Tool usage counts
- Success/failure rates
- Session durations

Disable with:

```bash
ANONYMIZED_TELEMETRY=false
```

## Security Considerations

### API Key Protection

Never expose API keys in shared configurations. Use environment variables:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

### Domain Restrictions

Limit browser access to specific domains:

```bash
BROWSER_USE_ALLOWED_DOMAINS=*.example.com,*.trusted.org
```

### Headless Mode

For security, run in headless mode in production:

```bash
BROWSER_USE_HEADLESS=true
```

## Debugging

### Enable Debug Logging

```bash
BROWSER_USE_LOGGING_LEVEL=debug npx browser-use --mcp
```

### View MCP Communication

Use the MCP Inspector:

```bash
npx @anthropic-ai/mcp-inspector browser-use --mcp
```

### Check Server Status

The server logs startup information:

```
INFO [browser_use.mcp.server] 🔌 MCP Server started (... tools, ... prompts registered)
```

## Advanced Usage

### Custom Tool Registration

Extend the MCP server with custom tools:

```typescript
import { MCPServer } from 'browser-use/mcp';
import { z } from 'zod';

const server = new MCPServer('browser-use', 'dev');

// Add custom tool
server.registerTool(
  'my_custom_tool',
  'My custom browser tool',
  z.object({
    param1: z.string(),
  }),
  async (params) => {
    return { result: `processed ${params.param1}` };
  }
);

await server.start();
```

### Integration with Other MCP Servers

Browser-Use can work alongside other MCP servers:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-server-filesystem"]
    },
    "database": {
      "command": "npx",
      "args": ["your-database-mcp-server"]
    }
  }
}
```

This enables Claude to combine browser automation with file system access and database operations.
