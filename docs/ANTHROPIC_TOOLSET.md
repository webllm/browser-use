# Claude Browser Toolset

`browser-use/integrations/anthropic` runs Anthropic's browser toolset
(`browser_toolset_20260801`) on a Browser Use browser. Claude calls toolset
members such as `navigate`, `left_click`, and `read_page`; Browser Use executes
them and returns `tool_result` blocks, including the `browser_state` tab
inventory the API expects. A bounded Bash tool for local computation and
deliverables ships alongside it.

This is a port of the Python integration (`browser_use.integrations.anthropic`).

## Quickstart

Requires `ANTHROPIC_API_KEY`. The Bash tool needs a POSIX host with `/bin/bash`.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import {
  BrowserUseToolset,
  createBashTool,
  runBrowserToolsetConversation,
} from 'browser-use/integrations/anthropic';

const toolset = new BrowserUseToolset({
  // These members are disabled by default.
  configs: {
    javascript_exec: { enabled: true },
    read_console: { enabled: true },
    read_network: { enabled: true },
  },
});
const bash = createBashTool({ outputDir: 'outputs' });

try {
  const { message } = await runBrowserToolsetConversation({
    client: new Anthropic(),
    toolset,
    tools: [bash],
    model: 'claude-opus-5-5',
    system: 'Complete the task with the browser tools and Bash.',
    task: 'Read the first three Hacker News posts and save their titles and URLs to hacker-news.md.',
  });
  console.log(message.content);
} finally {
  await toolset.close();
}
```

A runnable version is in
[`examples/anthropic-browser-toolset.ts`](../examples/anthropic-browser-toolset.ts).

`runBrowserToolsetConversation` streams each request, appends Claude's reply,
resumes `pause_turn` responses, runs every `tool_use` block in order, and
repeats until Claude stops calling tools or `maxIterations` (default 100) is
reached. It is needed because the SDK's tool runner dispatches tools by name,
and the browser toolset is a single nameless `tools[]` entry whose members
carry `toolset_name: "browser"`.

## Browser runtimes

| Runtime                    | Driver                                      | Who starts and stops it? |
| -------------------------- | ------------------------------------------- | ------------------------ |
| Local Chromium             | `new BrowserUseToolset()`                   | The toolset              |
| Browser Use Cloud          | `new BrowserUseToolset({ useCloud: true })` | The toolset              |
| An existing BrowserSession | `new BrowserUseToolset({ browser })`        | Your application         |

- `browserProfile` configures the local browser the toolset launches.
- `useCloud` requires `BROWSER_USE_API_KEY`; pass a `CreateBrowserRequest`
  object instead of `true` to set the cloud profile, proxy country, or timeout.
- A borrowed `BrowserSession` must already be started, and `close()` leaves it
  running.

The toolset starts lazily on the first call (or explicitly with `start()`).
Always call `close()`: it releases held mouse buttons, detaches listeners, and
stops browsers the toolset launched.

## Members

All 31 members of the toolset are implemented:

| Group               | Members                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation and tabs | `navigate`, `new_tab`, `list_tabs`, `switch_tab`, `close_tab`                                                                                                                    |
| Page state          | `screenshot`, `zoom`, `read_page`, `find`, `get_page_text`, `wait`                                                                                                               |
| Pointer             | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `hover`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `left_click_drag`, `scroll`, `scroll_to` |
| Input               | `type`, `key`, `hold_key`, `form_input`, `file_upload`                                                                                                                           |
| Diagnostics         | `read_console`, `read_network`, `javascript_exec`                                                                                                                                |

Behavior worth knowing:

- **Element references.** `read_page` and `find` return lines such as
  `[ref_12] button "Sign in"`. Refs are stable for an element while its
  document lives, are scoped to their tab, and become stale after navigation
  or when the element leaves the DOM; stale refs return an error asking Claude
  to read the page again. Same-origin and cross-origin iframes are walked from
  their own frames, so refs inside them work with every member.
- **Coordinates** are CSS pixels of the visible viewport, matching
  `screenshot`. Viewports larger than 2000 pixels on an edge are downscaled in
  screenshots, and incoming coordinates are scaled back.
- **`navigate`** accepts a URL (a missing scheme becomes `https://`) or
  `back`, `forward`, or `reload`, honors the browser profile's
  `allowed_domains` and `prohibited_domains`, and reports the final URL, title,
  and HTTP status.
- **`form_input`** fills text fields and content-editable elements, selects
  `<select>` options by value or label, sets range and color inputs, and checks
  or unchecks checkboxes and radios, verifying that the page kept the value.

## Browser state and batches

Every result answers its `tool_use` with `toolset_name: "browser"`.

- Tab members (`new_tab`, `list_tabs`, `switch_tab`, `close_tab`) return exactly
  one `browser_state` block with the full tab inventory.
- Other members attach a `browser_state` block only when the inventory or the
  active tab changed, or when there are `state_changes` to report: tabs opened
  by the page (popups, `target="_blank"`) and downloads
  (`download_started`, `download_completed`, `download_failed`).
- Failed calls never carry a `browser_state` block.
- Calls in one turn run in order. After the first failure, the remaining calls
  of that turn are not executed and report
  `Not executed: an earlier action in this turn failed.`

The browser session saves completed downloads to its profile's
`downloads_path`; the toolset lists them in `toolset.completedDownloadPaths`.

## Safety controls

| Control            | Default                                                                   | Purpose                                                      |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `configs`          | `javascript_exec`, `file_upload`, `read_console`, `read_network` disabled | Members are only offered to Claude when enabled              |
| `confirm`          | none                                                                      | Approve or decline each browser action before it runs        |
| `uploadRoots`      | none (local uploads refused)                                              | Directories `file_upload` may read local paths from          |
| `documentResolver` | none                                                                      | Maps `file_upload` document IDs to files on the browser host |
| `actionTimeoutMs`  | 120000                                                                    | Upper bound for one member call                              |

`confirm` covers browser actions only. Bash runs on the SDK host:

```typescript
const bash = createBashTool({
  outputDir: 'outputs', // working directory and HOME; created if missing
  timeoutSeconds: 120, // the whole process group is killed on timeout
  maxOutputBytes: 50_000, // combined stdout/stderr returned to Claude
});
```

Commands run with `/bin/bash --noprofile --norc` and a stripped environment
(no inherited API keys or credentials). Each result is JSON with `exit_code`,
`timed_out`, `truncated`, and `output`. `createBashTool` returns an SDK
runnable tool, so it also works with `client.beta.messages.toolRunner`.

## Running your own loop

Use the driver directly when you manage requests yourself:

```typescript
const response = await client.beta.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 16_000,
  tools: [toolset.toolParam()],
  messages,
});
messages.push({ role: 'assistant', content: response.content });

const toolUses = response.content.filter((block) => block.type === 'tool_use');
const results = await toolset.executeBatch(
  toolUses.filter((block) => toolset.handles(block))
);
messages.push({ role: 'user', content: results });
```

`execute(block)` runs one call and never throws: failures become `is_error`
results. `haltResult(block)` builds the batch-halt result when you interleave
browser calls with other tools.
