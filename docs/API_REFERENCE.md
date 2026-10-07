# API Reference

Complete API documentation for Browser-Use.

## Table of Contents

- [Agent](#agent)
- [BrowserSession](#browsersession)
- [BrowserProfile](#browserprofile)
- [Controller](#controller)
- [Registry](#registry)
- [LLM Providers](#llm-providers)
- [Claude Browser Toolset](#claude-browser-toolset)
- [Data Types](#data-types)
- [Utility Functions](#utility-functions)

---

## Agent

The main class for autonomous browser automation.

### Import

```typescript
import { Agent } from 'browser-use';
```

### Constructor

```typescript
new Agent(options: AgentOptions)
```

#### AgentOptions

| Parameter                      | Type                             | Required | Default                      | Description                                                                        |
| ------------------------------ | -------------------------------- | -------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `task`                         | `string`                         | Yes      | -                            | The task description in natural language                                           |
| `llm`                          | `BaseChatModel`                  | Yes      | -                            | LLM instance for decision making                                                   |
| `browser_session`              | `BrowserSession`                 | No       | Auto-created                 | Browser session to use                                                             |
| `browser_profile`              | `BrowserProfile`                 | No       | Default profile              | Browser configuration                                                              |
| `controller`                   | `Controller`                     | No       | Default controller           | Action controller                                                                  |
| `use_vision`                   | `boolean`                        | No       | `true`                       | Enable screenshot analysis                                                         |
| `vision_detail_level`          | `'auto' \| 'low' \| 'high'`      | No       | `'auto'`                     | Screenshot detail level                                                            |
| `use_thinking`                 | `boolean`                        | No       | `true`                       | Enable extended thinking prompts                                                   |
| `flash_mode`                   | `boolean`                        | No       | `false`                      | Use optimized prompts for speed                                                    |
| `max_failures`                 | `number`                         | No       | `3`                          | Max consecutive failures before stopping                                           |
| `retry_delay`                  | `number`                         | No       | `10`                         | Delay (seconds) between retries                                                    |
| `max_actions_per_step`         | `number`                         | No       | `5`                          | Max actions per step                                                               |
| `validate_output`              | `boolean`                        | No       | `false`                      | Validate LLM output strictly                                                       |
| `generate_gif`                 | `boolean \| string`              | No       | `false`                      | Generate GIF of session                                                            |
| `save_conversation_path`       | `string`                         | No       | `null`                       | Path to save conversation logs                                                     |
| `override_system_message`      | `string`                         | No       | `null`                       | Replace system message                                                             |
| `extend_system_message`        | `string`                         | No       | `null`                       | Append to system message                                                           |
| `include_attributes`           | `string[]`                       | No       | `DEFAULT_INCLUDE_ATTRIBUTES` | Additional HTML attributes to include                                              |
| `sensitive_data`               | `SensitiveDataMap`               | No       | `null`                       | Credentials for auto-fill; use `allowed_domains` for production credentialed tasks |
| `session_attachment_mode`      | `'copy' \| 'strict' \| 'shared'` | No       | `'copy'`                     | How Agent attaches to an existing `BrowserSession`                                 |
| `llm_timeout`                  | `number`                         | No       | Auto (model-dependent)       | LLM call timeout (seconds)                                                         |
| `step_timeout`                 | `number`                         | No       | `180`                        | Step execution timeout (seconds)                                                   |
| `final_response_after_failure` | `boolean`                        | No       | `true`                       | Allow one done-only recovery step after hitting `max_failures`                     |
| `use_judge`                    | `boolean`                        | No       | `true`                       | Run final trace judgement after task completion                                    |
| `judge_llm`                    | `BaseChatModel \| null`          | No       | `null`                       | Optional dedicated model for final trace judgement (defaults to `llm`)             |
| `ground_truth`                 | `string \| null`                 | No       | `null`                       | Optional expected answer or criteria for final judgement                           |
| `enable_planning`              | `boolean`                        | No       | `true`                       | Allow plan tracking via `plan_update` / `current_plan_item`                        |
| `planning_replan_on_stall`     | `number`                         | No       | `3`                          | Inject replan nudge after N consecutive failures                                   |
| `planning_exploration_limit`   | `number`                         | No       | `5`                          | Inject planning nudge after N steps without a plan                                 |

### Methods

#### run

Execute the agent's task.

```typescript
async run(max_steps?: number): Promise<AgentHistoryList>
```

**Parameters:**

- `max_steps` (optional): Maximum steps to execute. Defaults to `500`.

**Returns:** `AgentHistoryList` containing the execution history.

**Example:**

```typescript
const history = await agent.run(50);
console.log('Success:', history.is_successful());
```

#### pause

Pause agent execution.

```typescript
pause(): void
```

#### resume

Resume paused execution.

```typescript
resume(): void
```

#### stop

Stop agent execution.

```typescript
stop(): void
```

#### addNewTask

Add a follow-up task without restarting.

```typescript
addNewTask(task: string): void
```

**Example:**

```typescript
agent.addNewTask('Now click the submit button');
```

#### rerun_history

Replay recorded actions.

```typescript
async rerun_history(
  history: AgentHistoryList,
  options?: {
    max_retries?: number;
    delay_between_actions?: number;
    max_step_interval?: number;
    skip_failures?: boolean;
    signal?: AbortSignal | null;
  }
): Promise<ActionResult[]>
```

Defaults:

- `max_retries`: `3`
- `delay_between_actions`: `2`
- `max_step_interval`: `45`
- `skip_failures`: `false`

### Properties

| Property          | Type               | Description                |
| ----------------- | ------------------ | -------------------------- |
| `state`           | `AgentState`       | Current agent state        |
| `history`         | `AgentHistoryList` | Execution history          |
| `browser_session` | `BrowserSession`   | Associated browser session |
| `controller`      | `Controller`       | Action controller          |

### Events

Agents expose a per-agent event bus on `agent.eventbus`:

```typescript
const agent = new Agent({ task: '...', llm });

agent.eventbus.on('CreateAgentStepEvent', (event) => {
  console.log('Step:', event.step_id, event.model_output);
});
```

---

## BrowserSession

Manages browser lifecycle and page interactions.

### Import

```typescript
import { BrowserSession } from 'browser-use';
```

### Constructor

```typescript
new BrowserSession(options?: BrowserSessionOptions)
```

#### BrowserSessionOptions

| Parameter         | Type             | Required | Default | Description                        |
| ----------------- | ---------------- | -------- | ------- | ---------------------------------- |
| `browser`         | `Browser`        | No       | -       | Existing Playwright Browser        |
| `browser_context` | `BrowserContext` | No       | -       | Existing Playwright BrowserContext |
| `page`            | `Page`           | No       | -       | Existing Playwright Page           |
| `browser_profile` | `BrowserProfile` | No       | Default | Browser configuration              |
| `cdp_url`         | `string`         | No       | -       | CDP URL for remote browser         |
| `wss_url`         | `string`         | No       | -       | WebSocket URL for remote browser   |

### Methods

#### start

Initialize and start the browser session.

```typescript
async start(): Promise<void>
```

#### stop

Close the browser session.

```typescript
async stop(): Promise<void>
```

#### get_current_page

Get the currently active page.

```typescript
async get_current_page(): Promise<Page | null>
```

#### get_browser_state

Get current browser state summary.

```typescript
async get_browser_state(use_vision?: boolean): Promise<BrowserStateSummary>
```

#### navigate

Navigate to a URL.

```typescript
async navigate(url: string): Promise<void>
```

#### switch_to_tab

Switch to a specific tab by page ID.

```typescript
async switch_to_tab(page_id: number): Promise<void>
```

#### get_tabs

Get list of open tabs.

```typescript
get_tabs(): TabInfo[]
```

### Properties

| Property             | Type                     | Description                 |
| -------------------- | ------------------------ | --------------------------- |
| `browser`            | `Browser \| null`        | Playwright Browser instance |
| `browser_context`    | `BrowserContext \| null` | Playwright BrowserContext   |
| `agent_current_page` | `Page \| null`           | Currently active page       |

---

## BrowserProfile

Configuration for browser launch and behavior.

### Import

```typescript
import { BrowserProfile } from 'browser-use';
```

### Constructor

```typescript
new BrowserProfile(options?: Partial<BrowserProfileOptions>)
```

#### Key Options

| Option                                 | Type              | Default      | Description                                                                                               |
| -------------------------------------- | ----------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `headless`                             | `boolean \| null` | `null`       | Headless mode (null = auto-detect)                                                                        |
| `viewport`                             | `ViewportSize`    | `null`       | Browser viewport size                                                                                     |
| `window_size`                          | `ViewportSize`    | `null`       | Browser window size                                                                                       |
| `user_agent`                           | `string`          | `null`       | Custom user agent                                                                                         |
| `user_data_dir`                        | `string`          | Default path | User data directory for persistence                                                                       |
| `proxy`                                | `ProxySettings`   | `null`       | Proxy configuration                                                                                       |
| `timeout`                              | `number`          | `30000`      | Default timeout (ms)                                                                                      |
| `slow_mo`                              | `number`          | `0`          | Slow down operations (ms)                                                                                 |
| `args`                                 | `string[]`        | `[]`         | Additional Chromium launch arguments                                                                      |
| `chromium_sandbox`                     | `boolean`         | `!IN_DOCKER` | Enable Chromium sandbox. On sandbox launch failure, BrowserSession retries once with no-sandbox and warns |
| `ignore_https_errors`                  | `boolean`         | `false`      | Ignore HTTPS certificate errors                                                                           |
| `locale`                               | `string`          | `null`       | Browser locale                                                                                            |
| `timezone_id`                          | `string`          | `null`       | Timezone ID                                                                                               |
| `geolocation`                          | `Geolocation`     | `null`       | Geolocation override                                                                                      |
| `permissions`                          | `string[]`        | Default set  | Granted permissions                                                                                       |
| `stealth`                              | `boolean`         | `false`      | Enable stealth mode                                                                                       |
| `disable_security`                     | `boolean`         | `false`      | Disable web security                                                                                      |
| `viewport_expansion`                   | `number`          | `500`        | Viewport expansion for scrolling                                                                          |
| `highlight_elements`                   | `boolean`         | `true`       | Highlight interactive elements                                                                            |
| `wait_for_network_idle_page_load_time` | `number`          | `0.5`        | Network idle wait (seconds)                                                                               |
| `maximum_wait_page_load_time`          | `number`          | `5.0`        | Max page load wait (seconds)                                                                              |
| `enable_default_extensions`            | `boolean`         | `true`       | Load default extensions                                                                                   |

### Methods

#### detect_display_configuration

Auto-detect display settings.

```typescript
async detect_display_configuration(): Promise<void>
```

#### kwargs_for_launch

Get Playwright launch arguments.

```typescript
async kwargs_for_launch(): Promise<BrowserLaunchArgs>
```

#### kwargs_for_new_context

Get Playwright context arguments.

```typescript
kwargs_for_new_context(): BrowserNewContextArgs
```

### Properties

| Property        | Type                    | Description               |
| --------------- | ----------------------- | ------------------------- |
| `config`        | `BrowserProfileOptions` | Full configuration object |
| `viewport`      | `ViewportSize \| null`  | Configured viewport       |
| `user_data_dir` | `string \| null`        | User data directory       |

---

## Controller

Manages action registration and execution.

### Import

```typescript
import { Controller } from 'browser-use/controller';
```

### Constructor

```typescript
new Controller(options?: ControllerOptions)
```

#### ControllerOptions

| Option            | Type        | Default | Description          |
| ----------------- | ----------- | ------- | -------------------- |
| `exclude_actions` | `string[]`  | `[]`    | Actions to exclude   |
| `output_model`    | `ZodSchema` | `null`  | Custom output schema |

### Properties

| Property   | Type       | Description              |
| ---------- | ---------- | ------------------------ |
| `registry` | `Registry` | Action registry instance |

---

## Registry

Action registration and execution.

### Import

```typescript
import { Registry } from 'browser-use/controller';
```

### Methods

#### action

Register a new action using decorator pattern.

```typescript
action(
  description: string,
  options?: ActionOptions
): (handler: ActionHandler) => ActionHandler
```

**ActionOptions:**

| Option            | Type                      | Description                 |
| ----------------- | ------------------------- | --------------------------- |
| `param_model`     | `ZodSchema`               | Parameter validation schema |
| `allowed_domains` | `string[]`                | Domain restrictions         |
| `page_filter`     | `(page: Page) => boolean` | Page filter function        |

**Example:**

```typescript
const registry = new Registry();

registry.action('Click a button', {
  param_model: z.object({
    selector: z.string().describe('CSS selector'),
  }),
})(async function click_button(params, ctx) {
  await ctx.page.click(params.selector);
  return new ActionResult({ success: true });
});
```

#### execute_action

Execute a registered action.

```typescript
async execute_action(
  action_name: string,
  params: Record<string, unknown>,
  context?: ExecuteActionContext
): Promise<ActionResult>
```

#### get_action

Get a registered action by name.

```typescript
get_action(name: string): RegisteredAction | null
```

#### get_all_actions

Get all registered actions.

```typescript
get_all_actions(): Map<string, RegisteredAction>
```

#### get_prompt_description

Generate prompt description for available actions.

```typescript
get_prompt_description(page?: Page): string
```

---

## LLM Providers

### OpenAI

```typescript
import { ChatOpenAI } from 'browser-use/llm/openai';

const llm = new ChatOpenAI({
  model: 'gpt-4o', // Model name
  apiKey: 'sk-...', // API key
  temperature: 0.7, // Temperature (0-2)
  baseURL: '...', // Optional base URL
  reasoningEffort: 'medium', // For reasoning models
});
```

### Anthropic

```typescript
import { ChatAnthropic } from 'browser-use/llm/anthropic';

const llm = new ChatAnthropic({
  model: 'claude-opus-5',
  apiKey: 'sk-ant-...',
  // Claude Opus 4.7 and later reject sampling parameters such as temperature.
});
```

### Google Gemini

```typescript
import { ChatGoogle } from 'browser-use/llm/google';

const llm = new ChatGoogle('gemini-2.5-flash');
// Requires GOOGLE_API_KEY in env.
```

### Azure OpenAI

```typescript
import { ChatAzure } from 'browser-use/llm/azure';

const llm = new ChatAzure('gpt-4o');
// Requires AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT in env.
```

### AWS Bedrock

```typescript
import { ChatAnthropicBedrock } from 'browser-use/llm/aws';

const llm = new ChatAnthropicBedrock({
  model: 'global.anthropic.claude-opus-4-6-v1',
  region: 'us-east-1',
  max_tokens: 4096,
});
```

### Groq

```typescript
import { ChatGroq } from 'browser-use/llm/groq';

const llm = new ChatGroq('llama-3.3-70b-versatile');
```

### Ollama

```typescript
import { ChatOllama } from 'browser-use/llm/ollama';

const llm = new ChatOllama('llama3', 'http://localhost:11434');
```

### DeepSeek

```typescript
import { ChatDeepSeek } from 'browser-use/llm/deepseek';

const llm = new ChatDeepSeek('deepseek-v4-flash');
```

### OpenRouter

```typescript
import { ChatOpenRouter } from 'browser-use/llm/openrouter';

const llm = new ChatOpenRouter('anthropic/claude-3-opus');
```

### OrcaRouter

```typescript
import { ChatOrcaRouter } from 'browser-use/llm/orcarouter';

const llm = new ChatOrcaRouter('anthropic/claude-sonnet-5');
```

---

## Claude Browser Toolset

Runs Anthropic's `browser_toolset_20260801` on a Browser Use browser. See the
[Claude Browser Toolset guide](./ANTHROPIC_TOOLSET.md).

```typescript
import {
  BrowserUseToolset,
  createBashTool,
  runBash,
  runBrowserToolsetConversation,
} from 'browser-use/integrations/anthropic';
```

| Export                                   | Description                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new BrowserUseToolset(options?)`        | Driver for all 31 members. Options: `browser`, `browserProfile`, `useCloud`, `configs`, `confirm`, `uploadRoots`, `documentResolver`, `downloadsPath`, `maxLogEntries`, `actionTimeoutMs` |
| `toolset.toolParam()`                    | The `tools[]` entry for the request                                                                                                                                                       |
| `toolset.execute(block)`                 | Run one browser `tool_use` block; returns a `tool_result` (never throws)                                                                                                                  |
| `toolset.executeBatch(blocks)`           | Run a turn's browser calls in order, halting after the first failure                                                                                                                      |
| `toolset.start()` / `toolset.close()`    | Start lazily-started resources / release them (stops browsers the toolset launched)                                                                                                       |
| `runBrowserToolsetConversation(options)` | Agentic loop: `client`, `toolset`, `tools`, `task` or `messages`, `system`, `model`, `maxTokens`, `maxIterations`, `params`, `signal`, `onMessage`, `onToolResult`                        |
| `createBashTool(options?)`               | Bounded `bash` runnable tool: `outputDir`, `timeoutSeconds`, `maxOutputBytes`                                                                                                             |
| `runBash(command, options?)`             | Run one command and get `{ exit_code, timed_out, truncated, output }` as JSON                                                                                                             |

---

## Data Types

### ActionResult

Result of an action execution.

```typescript
class ActionResult {
  is_done?: boolean; // Task completed
  success?: boolean; // Action successful (only with is_done)
  error?: string; // Error message
  extracted_content?: string; // Extracted data
  long_term_memory?: string; // Memory to persist
  attachments?: string[]; // File attachments
  include_in_memory?: boolean; // Include in history
}
```

### AgentOutput

LLM output structure.

```typescript
class AgentOutput {
  thinking?: string; // Internal reasoning
  evaluation_previous_goal?: string; // Evaluation of last action
  memory?: string; // Working memory
  next_goal?: string; // Next goal
  action: ActionModel[]; // Actions to execute
}
```

### AgentHistory

Single step history record.

```typescript
class AgentHistory {
  model_output: AgentOutput; // LLM output
  result: ActionResult[]; // Action results
  state: BrowserStateHistory; // Browser state snapshot
  metadata: StepMetadata; // Step metadata
}
```

### AgentHistoryList

Complete execution history.

```typescript
class AgentHistoryList {
  history: AgentHistory[];

  is_done(): boolean; // Check if task completed
  is_successful(): boolean; // Check if task succeeded
  final_result(): string; // Get final result
  action_history(): any[]; // Get all actions
  errors(): string[]; // Get all errors
  model_actions(): any[]; // Get all model outputs
  urls_visited(): string[]; // Get all URLs visited
}
```

### BrowserStateSummary

Current browser state.

```typescript
interface BrowserStateSummary {
  url: string; // Current URL
  title: string; // Page title
  tabs: TabInfo[]; // Open tabs
  screenshot?: string; // Base64 screenshot
  element_tree: DOMElementNode; // DOM tree
  selector_map: SelectorMap; // Element index map
  scroll_info: ScrollInfo; // Scroll position
}
```

### SensitiveDataMap

Sensitive data configuration.

```typescript
interface SensitiveDataMap {
  [domainOrKey: string]: string | Record<string, string>;
}

// Example
const sensitiveData: SensitiveDataMap = {
  // Domain-scoped
  '*.example.com': {
    username: 'user@example.com',
    password: 'secret123',
  },
  // Global
  api_key: 'sk-...',
};
```

---

## Utility Functions

### Quick Execution Pattern

Use `Agent` directly for one-shot task execution:

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

const agent = new Agent({
  task: 'Your task',
  llm: new ChatOpenAI({ model: 'gpt-4o', apiKey: 'sk-...' }),
});

const history = await agent.run(50);
```

### createLogger

Create a named logger.

```typescript
import { createLogger } from 'browser-use';

const logger = createLogger('my-module');
logger.info('Hello');
logger.debug('Debug info');
logger.warning('Warning');
logger.error('Error');
```

### EventBus

Each `Agent` has an event bus available at `agent.eventbus`:

```typescript
const agent = new Agent({ task: '...', llm });

agent.eventbus.on('CreateAgentStepEvent', (event) => {
  console.log(event.step_id);
});
```
