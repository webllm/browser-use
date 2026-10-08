# Architecture Overview

This document provides a comprehensive overview of Browser-Use's architecture, explaining how the various components work together to enable autonomous browser automation.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Browser-Use                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐             │
│  │    Agent     │◄──│   Message    │◄──│     LLM      │             │
│  │   Service    │   │   Manager    │   │   Providers  │             │
│  └──────┬───────┘   └──────────────┘   └──────────────┘             │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐             │
│  │  Controller  │──►│   Action     │──►│   Browser    │             │
│  │   Service    │   │   Registry   │   │   Session    │             │
│  └──────────────┘   └──────────────┘   └──────┬───────┘             │
│                                               │                     │
│                                               ▼                     │
│                                        ┌──────────────┐             │
│                                        │     DOM      │             │
│                                        │   Service    │             │
│                                        └──────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Agent (`src/agent/`)

The **Agent** is the central orchestrator that coordinates all other components to accomplish tasks.

```
src/agent/
├── service.ts          # Main Agent class
├── views.ts            # Data types (AgentOutput, ActionResult, AgentHistory)
├── prompts.ts          # System prompt generation
├── message-manager/    # LLM context management
│   └── service.ts
└── cloud-events.ts     # Event emission for cloud sync
```

#### Agent Lifecycle

```
                    ┌─────────────┐
                    │   Created   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
        ┌──────────│   Running   │──────────┐
        │          └──────┬──────┘          │
        │                 │                 │
        ▼                 ▼                 ▼
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  Paused  │◄───►│ Stepping │────►│  Done    │
  └──────────┘     └──────────┘     └──────────┘
```

#### Key Responsibilities

- **Task Management**: Receives and interprets natural language tasks
- **Step Execution**: Runs the main loop of observe → think → act
- **State Tracking**: Maintains history of all actions and results
- **Error Recovery**: Handles failures with retry logic

### 2. Browser Session (`src/browser/`)

The **Browser Session** wraps Playwright and manages browser lifecycle.

```
src/browser/
├── session.ts      # BrowserSession class
├── profile.ts      # BrowserProfile configuration
├── types.ts        # Playwright type re-exports
└── views.ts        # BrowserStateSummary, TabInfo, etc.
```

#### BrowserSession Responsibilities

- **Browser Lifecycle**: Launch, connect, close browsers
- **Context Management**: Handle multiple browser contexts
- **Tab Management**: Track and switch between tabs
- **Page State**: Extract current URL, title, content
- **Screenshot Capture**: Take full-page or viewport screenshots
- **Download Tracking**: Monitor file downloads

#### BrowserProfile Configuration

```typescript
interface BrowserProfileOptions {
  // Display
  headless: boolean;
  viewport: { width: number; height: number };
  window_size: { width: number; height: number };

  // Identity
  user_agent: string;
  locale: string;
  timezone_id: string;
  geolocation: { latitude: number; longitude: number };

  // Network
  proxy: ProxySettings;
  ignore_https_errors: boolean;

  // Storage
  user_data_dir: string;
  storage_state: string | StorageState;

  // Performance
  slow_mo: number;
  timeout: number;

  // Browser-Use specific
  viewport_expansion: number;
  highlight_elements: boolean;
  wait_for_network_idle_page_load_time: number;
}
```

### 3. DOM Service (`src/dom/`)

The **DOM Service** extracts and processes page structure for AI understanding.

```
src/dom/
├── service.ts                  # DomService class
├── views.ts                    # DOM node types
└── history-tree-processor/     # Element tracking across navigations
    ├── service.ts
    └── views.ts
```

#### DOM Extraction Process

```
Page HTML
    │
    ▼
┌─────────────────┐
│  DOM Extraction │ ◄── JavaScript injection
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Element Parsing │ ◄── Extract interactive elements
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Coordinate Calc │ ◄── Viewport position calculation
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Index Mapping  │ ◄── Assign #1, #2, #3... indices
└────────┬────────┘
         │
         ▼
DOMState { element_tree, selector_map }
```

#### Element Types

```typescript
// Interactive element with full metadata
class DOMElementNode {
  is_visible: boolean;
  parent: DOMElementNode | null;
  tag_name: string;
  xpath: string;
  attributes: Record<string, string>;
  children: (DOMElementNode | DOMTextNode)[];
  is_interactive: boolean;
  is_top_element: boolean;
  shadow_root: boolean;
  highlight_index: number | null;
  page_coordinates: Coordinates | null;
  viewport_coordinates: Coordinates | null;
}

// Text content node
class DOMTextNode {
  text: string;
  is_visible: boolean;
}
```

### 4. Controller & Action Registry (`src/controller/`)

The **Controller** manages action registration and execution.

```
src/controller/
├── service.ts          # Controller class
└── registry/
    ├── service.ts      # Registry class
    └── views.ts        # RegisteredAction, ActionModel
```

#### Action Registration Pattern

```typescript
// Decorator-based registration
registry.action('Navigate to URL', {
  param_model: z.object({
    url: z.string().url().describe('The URL to navigate to'),
    new_tab: z.boolean().optional().describe('Open in new tab'),
  }),
  allowed_domains: ['*.example.com'],
})(async function go_to_url(params, ctx) {
  await ctx.page.goto(params.url);
  return new ActionResult({ success: true });
});
```

#### Built-in Actions (45+)

| Category    | Actions                                       |
| ----------- | --------------------------------------------- |
| Navigation  | `go_to_url`, `go_back`, `search_google`       |
| Interaction | `click_element`, `input_text`, `send_keys`    |
| Scrolling   | `scroll`, `scroll_to_text`                    |
| Forms       | `select_dropdown`, `upload_file`              |
| Tabs        | `switch_tab`, `close_tab`, `open_tab`         |
| Content     | `extract_structured_data`, `dropdown_options` |
| Files       | `read_file`, `write_file`, `replace_file_str` |
| Control     | `done`, `wait`                                |

### 5. LLM Module (`src/llm/`)

The **LLM Module** provides a unified interface for multiple AI providers.

```
src/llm/
├── base.ts             # BaseChatModel interface
├── messages.ts         # Message types
├── schema.ts           # Schema optimization
├── views.ts            # Completion types
├── exceptions.ts       # Error types
├── openai/             # OpenAI provider
├── anthropic/          # Anthropic provider
├── google/             # Google Gemini provider
├── azure/              # Azure OpenAI provider
├── aws/                # AWS Bedrock provider
├── groq/               # Groq provider
├── ollama/             # Ollama provider
├── deepseek/           # DeepSeek provider
└── openrouter/         # OpenRouter provider
```

#### Provider Interface

```typescript
interface BaseChatModel {
  model: string;
  provider: string;

  ainvoke(
    messages: Message[],
    output_format?: ZodSchema
  ): Promise<ChatInvokeCompletion>;
}
```

#### Message Types

```typescript
class SystemMessage {
  role: 'system';
  content: string | ContentPartTextParam[];
  name?: string;
  cache?: boolean;
}

class UserMessage {
  role: 'user';
  content: string | ContentPart[];
  name?: string;
}

class AssistantMessage {
  role: 'assistant';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  refusal?: string;
}
```

## Data Flow

### Step Execution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Agent.run(max_steps)                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │              For each step:                  │
         │  ┌─────────────────────────────────────────┐ │
         │  │     1. Get Browser State                │ │
         │  │  ┌─────────────────────────────────────┐│ │
         │  │  │ - DomService.get_clickable_elements ││ │
         │  │  │ - Take screenshot (if vision=true)  ││ │
         │  │  │ - Build BrowserStateSummary         ││ │
         │  │  └─────────────────────────────────────┘│ │
         │  └─────────────────────────────────────────┘ │
         │                      │                       │
         │                      ▼                       │
         │  ┌─────────────────────────────────────────┐ │
         │  │     2. Prepare LLM Context              │ │
         │  │  ┌─────────────────────────────────────┐│ │
         │  │  │ - MessageManager.encode_state       ││ │
         │  │  │ - Add action history                ││ │
         │  │  │ - Add feedback from last action     ││ │
         │  │  └─────────────────────────────────────┘│ │
         │  └─────────────────────────────────────────┘ │
         │                      │                       │
         │                      ▼                       │
         │  ┌─────────────────────────────────────────┐ │
         │  │     3. Call LLM                         │ │
         │  │  ┌─────────────────────────────────────┐│ │
         │  │  │ - LLM.ainvoke(messages, schema)     ││ │
         │  │  │ - Parse AgentOutput                 ││ │
         │  │  │ - Extract actions array             ││ │
         │  │  └─────────────────────────────────────┘│ │
         │  └─────────────────────────────────────────┘ │
         │                      │                       │
         │                      ▼                       │
         │  ┌─────────────────────────────────────────┐ │
         │  │     4. Execute Actions                  │ │
         │  │  ┌─────────────────────────────────────┐│ │
         │  │  │ - Validate parameters               ││ │
         │  │  │ - Replace sensitive data            ││ │
         │  │  │ - Registry.execute_action()         ││ │
         │  │  │ - Collect ActionResult[]            ││ │
         │  │  └─────────────────────────────────────┘│ │
         │  └─────────────────────────────────────────┘ │
         │                      │                       │
         │                      ▼                       │
         │  ┌─────────────────────────────────────────┐ │
         │  │     5. Record History                   │ │
         │  │  ┌─────────────────────────────────────┐│ │
         │  │  │ - Create AgentHistory entry         ││ │
         │  │  │ - Emit CreateAgentStepEvent         ││ │
         │  │  └─────────────────────────────────────┘│ │
         │  └─────────────────────────────────────────┘ │
         │                      │                       │
         │                      ▼                       │
         │        Check: is_done? max_steps?            │
         └──────────────────────────────────────────────┘
                                │
                                ▼
         ┌─────────────────────────────────────────────┐
         │           Return AgentHistoryList           │
         └─────────────────────────────────────────────┘
```

### Action Execution Detail

```
Registry.execute_action(action_name, params, context)
         │
         ▼
┌──────────────────────────────────────────────┐
│  1. Lookup Action                            │
│     action = registry.get(action_name)       │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  2. Validate Parameters                      │
│     parsed = action.paramSchema.parse(params)│
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  3. Replace Sensitive Data                   │
│     - Check domain patterns                  │
│     - Replace <secret>key</secret> tokens    │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  4. Build Execution Context                  │
│     ctx = { page, browser_session, ... }     │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  5. Execute Handler                          │
│     result = await action.handler(params,ctx)│
└──────────────────────┬───────────────────────┘
                       │
                       ▼
                 ActionResult
```

## Configuration System

### Configuration Hierarchy

```
Priority (highest to lowest):
1. Constructor parameters
2. Environment variables
3. Config file (~/.config/browseruse/config.json)
4. Default values
```

### Configuration Proxy

```typescript
// Unified CONFIG singleton combines multiple sources
const CONFIG = new Proxy(
  {},
  {
    get(_, prop) {
      // Try each config source in order
      return OldConfig[prop] ?? FlatEnvConfig[prop] ?? ConfigCore[prop];
    },
  }
);
```

## Event System

### Event Types

```typescript
// Session-level events
CreateAgentSessionEvent { session_id, created_at }
UpdateAgentSessionEvent { session_id, status }

// Task-level events
CreateAgentTaskEvent { task_id, session_id, task }
UpdateAgentTaskEvent { task_id, status, result }

// Step-level events
CreateAgentStepEvent { step_id, task_id, model_output, result }
```

### Event Bus

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
});
const agent = new Agent({ task: '...', llm });

// Subscribe to events
agent.eventbus.on('CreateAgentStepEvent', (event) => {
  console.log('Step completed:', event.step_id);
});

// Events are emitted automatically during agent execution
```

## Design Patterns

### 1. Proxy Pattern

Used in configuration system to combine multiple config sources transparently.

### 2. Registry Pattern

Used for action registration with decorator-based API.

### 3. Observer Pattern

Used in event bus for loose coupling between components.

### 4. Strategy Pattern

Used for LLM providers - same interface, different implementations.

### 5. Template Method Pattern

Used in Agent.\_step() to define the step execution workflow.

### 6. Factory Pattern

Used in Controller to create dynamic action models based on registered actions.

### 7. Singleton Pattern

Used for Logger instances.

### 8. Decorator Pattern

Used for performance timing and observability wrappers.

## Error Handling

### Error Types

```typescript
// Browser errors
class BrowserError extends Error {}
class URLNotAllowedError extends BrowserError {}

// LLM errors
class ModelError extends Error {}
class ModelProviderError extends ModelError {
  statusCode: number;
  model: string;
}
class ModelRateLimitError extends ModelProviderError {}
```

### Recovery Strategies

1. **Retry Logic**: Actions are retried up to `max_failures` times
2. **Graceful Degradation**: If vision fails, falls back to DOM-only
3. **Timeout Handling**: Configurable timeouts at step and LLM levels
4. **State Recovery**: Browser state refresh on navigation errors

## Performance Considerations

### Token Optimization

- Configurable history window (`max_history_items`)
- Vision detail levels (low/auto/high)
- DOM tree pruning for large pages

### Caching

- Element selector maps cached per step
- Screenshot caching when page hasn't changed
- LLM response caching (provider-dependent)

### Parallel Execution

- Multi-action execution within a step
- Element freshness validation between actions
- Network idle detection for reliable page loads
