# Agent

```typescript
import { Agent, BrowserProfile, BrowserSession } from 'browser-use';
```

## Common options

| Option                         | Default             | Notes                                    |
| ------------------------------ | ------------------- | ---------------------------------------- |
| `task`                         | required            | Natural-language task                    |
| `llm`                          | required            | Any `BaseChatModel`, see `models.md`     |
| `browser_session`              | auto-created        | Share or configure the browser           |
| `browser_profile`              | default profile     | Used when the agent creates the session  |
| `controller`                   | built-in actions    | Custom actions, see `tools.md`           |
| `use_vision`                   | `true`              | Send screenshots to the model            |
| `max_actions_per_step`         | `5`                 | Actions the model may batch per step     |
| `max_failures`                 | `3`                 | Consecutive failures before stopping     |
| `flash_mode`                   | `false`             | Shorter prompts and outputs for speed    |
| `use_thinking`                 | `true`              | Ask the model to reason before acting    |
| `extend_system_message`        | `null`              | Append instructions to the system prompt |
| `sensitive_data`               | `null`              | Credentials injected by placeholder      |
| `output_model_schema`          | `null`              | Zod schema for the final result          |
| `llm_timeout` / `step_timeout` | model-based / `180` | Seconds                                  |
| `generate_gif`                 | `false`             | `true` or a file path                    |
| `use_judge`                    | `true`              | Judge the final trace                    |

## Running and results

```typescript
const history = await agent.run(50); // max steps
history.is_successful(); // true | false | null
history.final_result(); // string | null
history.errors(); // per-step errors
history.urls(); // visited URLs
```

`agent.pause()`, `agent.resume()`, `agent.stop()`, and
`agent.addNewTask(text)` control a running agent. Call `await agent.close()`
when finished.

## Structured output

```typescript
import { z } from 'zod';

const Result = z.object({
  products: z.array(z.object({ name: z.string(), price: z.string() })),
});

const agent = new Agent({
  task: 'List the first 3 products',
  llm,
  output_model_schema: Result,
});
const history = await agent.run();
console.log(history.structured_output); // parsed with Result, or null
```

## Sensitive data

The model sees placeholder names, never the values. Restrict domains so the
values are only used where intended:

```typescript
const agent = new Agent({
  task: 'Log in with x_user and x_pass, then open the dashboard',
  llm,
  sensitive_data: {
    '*.example.com': {
      x_user: process.env.SITE_USER!,
      x_pass: process.env.SITE_PASS!,
    },
  },
  browser_session: new BrowserSession({
    browser_profile: new BrowserProfile({ allowed_domains: ['*.example.com'] }),
  }),
});
```

## Events

```typescript
agent.eventbus.on('CreateAgentStepEvent', (event) => {
  console.log('step', event.step_id);
});
```
