# Custom actions

`Controller` (also exported as `Tools`) owns the action registry. Register an
action with a description and a Zod parameter schema; the handler receives the
parsed parameters and a context with `page` and `browser_session`.

```typescript
import fs from 'node:fs/promises';
import { ActionResult, Agent, Controller } from 'browser-use';
import { z } from 'zod';

const controller = new Controller();

controller.registry.action('Save a screenshot of the current page', {
  param_model: z.object({ filename: z.string().describe('Output file name') }),
})(async function save_screenshot(params, ctx) {
  await fs.writeFile(params.filename, await ctx.page.screenshot());
  return new ActionResult({ extracted_content: `Saved ${params.filename}` });
});

const agent = new Agent({ task: '...', llm, controller });
```

Action options:

| Option            | Purpose                                 |
| ----------------- | --------------------------------------- |
| `param_model`     | Zod schema for the parameters           |
| `allowed_domains` | Offer the action only on matching pages |
| `page_filter`     | `(page) => boolean` availability check  |

## ActionResult

| Field                 | Meaning                                       |
| --------------------- | --------------------------------------------- |
| `extracted_content`   | Text returned to the model                    |
| `error`               | Failure message; counts toward `max_failures` |
| `is_done` / `success` | End the task and report the outcome           |
| `long_term_memory`    | Short note kept in the agent's memory         |
| `include_in_memory`   | Keep the result in the conversation           |
| `attachments`         | File paths to attach to the final result      |

## Built-in actions

Exclude actions the model must not use:

```typescript
const controller = new Controller({
  exclude_actions: ['upload_file', 'write_file'],
});
```

Built-ins cover navigation, clicking and typing by index, scrolling, tabs,
dropdowns, file uploads, extraction, a sandboxed file system (`write_file`,
`read_file`, `replace_file`), and `done`.
