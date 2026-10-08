---
name: browser-use-ts
description: Reference for writing TypeScript or JavaScript code with the browser-use npm package (the unofficial, community-maintained TypeScript port of the Python browser-use library). Use when code imports from "browser-use" or its subpaths, or when the user asks how to configure Agent, BrowserSession, BrowserProfile, custom actions (Controller/Tools), LLM providers, the Actor API, structured output, sensitive data, the MCP server, or the Claude browser toolset integration. Do not use it to drive a browser directly from the shell; use the browser-use skill for that.
---

# Browser Use for TypeScript

Reference for building with the `browser-use` npm package. Read the file that
matches the task before writing code.

| Topic                                                               | Read                         |
| ------------------------------------------------------------------- | ---------------------------- |
| Install, first agent, CLI, environment variables                    | `references/quickstart.md`   |
| Agent options, results, structured output, sensitive data, events   | `references/agent.md`        |
| BrowserSession, BrowserProfile, existing Chrome, domains, downloads | `references/browser.md`      |
| Custom actions, ActionResult, excluding built-in actions            | `references/tools.md`        |
| LLM providers, import paths, API key variables                      | `references/models.md`       |
| Actor API: Page, Element, Mouse                                     | `references/actor.md`        |
| Claude browser toolset, MCP servers, direct CLI, skills             | `references/integrations.md` |

## Critical notes

- The package is ESM and requires Node.js 20.16+ (Node 20) or 22.3+. Import
  providers and integrations from subpaths, for example
  `browser-use/llm/anthropic` or `browser-use/integrations/anthropic`.
- Option names follow the Python library and use snake_case on Agent and
  BrowserProfile (`use_vision`, `allowed_domains`); provider constructors use
  camelCase (`apiKey`, `baseURL`).
- Each provider reads only its own API key variable (for example
  `ANTHROPIC_API_KEY`). OpenAI-compatible providers never fall back to
  `OPENAI_API_KEY`.
- Install a browser with `npx playwright install chromium` when Chromium is
  missing.
- Pair `sensitive_data` with `allowed_domains` so credentials can only be used
  on the intended sites.
- Close what you start: `await agent.close()` for agents and
  `await session.kill()` (or `stop()`) for sessions you launched yourself.
