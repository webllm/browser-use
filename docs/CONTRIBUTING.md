# Contributing Guide

Thank you for your interest in contributing to Browser-Use for TypeScript! This guide will help you get started.

This repository is an unofficial port maintained independently of the official
Python [browser-use](https://github.com/browser-use/browser-use) project. Open
issues and pull requests for the TypeScript port here, and report problems with
the Python library to the official project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Issue Guidelines](#issue-guidelines)
- [Documentation](#documentation)
- [Release Process](#release-process)

---

## Getting Started

### Prerequisites

- Node.js 22 (recommended; see `.nvmrc`)
- pnpm
- Git
- A supported LLM API key (OpenAI, Anthropic, etc.)

### Quick Setup

```bash
# Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/browser-use.git
cd browser-use

# Use the project Node version
nvm use

# Install dependencies
pnpm install

# Install Playwright browsers
npx playwright install chromium

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Run tests
pnpm test

# Build the project
pnpm build
```

---

## Development Setup

### Environment Variables

Create a `.env` file:

```env
# Required for testing
OPENAI_API_KEY=sk-your-key

# Optional - for testing other providers
ANTHROPIC_API_KEY=sk-ant-your-key
GOOGLE_API_KEY=your-google-key

# Development settings
BROWSER_USE_LOGGING_LEVEL=debug
```

### IDE Setup

#### VS Code

Recommended extensions:

- ESLint
- Prettier
- TypeScript and JavaScript Language Features

Settings (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

#### WebStorm/IntelliJ

- Enable ESLint integration
- Set TypeScript language service version to workspace
- Configure code style to match ESLint/Prettier

### Development Commands

```bash
# Build
pnpm build             # Build production
pnpm build:watch       # Build with watch mode

# Test
pnpm test              # Run all tests
pnpm test:coverage     # Run tests with coverage
pnpm test:watch        # Watch mode
pnpm test:pack         # Validate packaged public exports
pnpm check             # Full local CI gate (lint/typecheck/tests/pack)

# Lint
pnpm lint              # Run ESLint
pnpm lint:fix          # Fix auto-fixable issues

# Type check
pnpm typecheck         # Run TypeScript compiler check

# Format
pnpm format            # Format with Prettier
pnpm format:check      # Check formatting
```

---

## Project Structure

```
browser-use/
├── src/
│   ├── index.ts              # Main entry point
│   ├── cli.ts                # CLI entry point
│   │
│   ├── agent/                # Agent system
│   │   ├── index.ts          # Agent class
│   │   ├── views.ts          # Data models
│   │   ├── message_manager/  # Message handling
│   │   └── prompts.ts        # System prompts
│   │
│   ├── browser/              # Browser management
│   │   ├── session.ts        # BrowserSession
│   │   └── profile.ts        # BrowserProfile
│   │
│   ├── controller/           # Action system
│   │   ├── index.ts          # Controller
│   │   └── registry/         # Action registry
│   │       ├── index.ts      # Registry class
│   │       └── views.ts      # Action types
│   │
│   ├── dom/                  # DOM processing
│   │   ├── index.ts          # DomService
│   │   ├── views.ts          # DOM types
│   │   └── buildDomTree.ts   # DOM extraction
│   │
│   ├── llm/                  # LLM providers
│   │   ├── index.ts          # Base interfaces
│   │   ├── openai.ts         # OpenAI
│   │   ├── anthropic.ts      # Anthropic
│   │   ├── google.ts         # Google Gemini
│   │   └── ...               # Other providers
│   │
│   └── mcp/                  # MCP server
│       ├── server.ts         # Server implementation
│       └── tools.ts          # MCP tools
│
├── tests/                    # Test files
│   ├── unit/                 # Unit tests
│   └── integration/          # Integration tests
│
├── docs/                     # Documentation
├── examples/                 # Example code
└── scripts/                  # Build scripts
```

### Key Components

| Component        | Responsibility                           |
| ---------------- | ---------------------------------------- |
| `Agent`          | Orchestrates browser automation with LLM |
| `BrowserSession` | Manages Playwright browser lifecycle     |
| `BrowserProfile` | Browser configuration                    |
| `Controller`     | Manages and executes actions             |
| `Registry`       | Action registration and lookup           |
| `DomService`     | DOM extraction and processing            |
| `LLM providers`  | Abstract LLM interactions                |

---

## Coding Standards

### TypeScript Guidelines

```typescript
// Use explicit types for function parameters and returns
function processElement(element: DOMElement): ProcessedElement {
  // ...
}

// Use interfaces for object shapes
interface ActionOptions {
  param_model?: ZodSchema;
  allowed_domains?: string[];
}

// Use type for unions and aliases
type LogLevel = 'debug' | 'info' | 'warning' | 'error';

// Prefer const assertions for literal types
const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'google'] as const;

// Use async/await over promises
async function fetchData(): Promise<Data> {
  const response = await fetch(url);
  return response.json();
}
```

### Naming Conventions

```typescript
// Classes: PascalCase
class BrowserSession {}

// Interfaces: PascalCase
interface ActionResult {}

// Functions and variables: camelCase
function executeAction() {}
const browserContext = {};

// Constants: UPPER_SNAKE_CASE
const MAX_RETRY_ATTEMPTS = 3;

// Private members: underscore prefix
class Agent {
  private _state: AgentState;
}

// Files: kebab-case or snake_case
// browser-session.ts or browser_session.ts
```

### Error Handling

```typescript
// Use custom error classes
class BrowserError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

// Always handle errors explicitly
try {
  await page.click(selector);
} catch (error) {
  if (error instanceof TimeoutError) {
    return new ActionResult({ error: 'Element not found within timeout' });
  }
  throw error;
}

// Return errors from actions, don't throw
async function myAction(params, ctx): Promise<ActionResult> {
  if (!params.required_field) {
    return new ActionResult({ error: 'Missing required field' });
  }
  // ...
}
```

### Documentation

````typescript
/**
 * Executes a browser action by its name.
 *
 * @param actionName - The registered action name
 * @param params - Action parameters
 * @param context - Execution context including page and session
 * @returns The action result
 * @throws {ActionNotFoundError} If action is not registered
 *
 * @example
 * ```typescript
 * const result = await registry.execute_action('click_element', { index: 5 }, ctx);
 * ```
 */
async execute_action(
  actionName: string,
  params: Record<string, unknown>,
  context: ExecuteActionContext
): Promise<ActionResult> {
  // ...
}
````

---

## Testing

### Test Structure

```typescript
// tests/unit/controller/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from '../../../src/controller/registry';

describe('Registry', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  describe('action registration', () => {
    it('should register an action', () => {
      registry.action('Test action', {})(async () => new ActionResult({}));

      const action = registry.get_action('test_action');
      expect(action).toBeDefined();
    });

    it('should throw on duplicate registration', () => {
      registry.action('Test action', {})(async () => new ActionResult({}));

      expect(() => {
        registry.action('Test action', {})(async () => new ActionResult({}));
      }).toThrow();
    });
  });
});
```

### Test Categories

| Category    | Location                    | Purpose                           |
| ----------- | --------------------------- | --------------------------------- |
| Unit        | `test/*.test.ts`            | Test individual functions/classes |
| Integration | `test/integration*.test.ts` | Test component interactions       |
| Packaging   | `scripts/smoke-pack.mjs`    | Validate npm public entrypoints   |

### Running Tests

```bash
# All tests
pnpm test

# Specific file
pnpm test test/controller.test.ts

# With coverage
pnpm test:coverage

# Watch mode
pnpm test:watch

# Validate published package exports
pnpm test:pack
```

### Writing Good Tests

```typescript
// Test one thing per test
it('should return null for non-existent action', () => {
  const action = registry.get_action('nonexistent');
  expect(action).toBeNull();
});

// Use descriptive names
it('should mask sensitive data in extracted content', () => {
  // ...
});

// Test edge cases
describe('edge cases', () => {
  it('should handle empty input', () => {
    const result = processInput('');
    expect(result).toEqual([]);
  });

  it('should handle special characters', () => {
    const result = processInput('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
  });
});

// Mock external dependencies
import { vi } from 'vitest';

it('should call LLM with correct parameters', async () => {
  const mockLLM = {
    ainvoke: vi.fn().mockResolvedValue({ content: 'response' }),
  };

  await agent.executeStep(mockLLM);

  expect(mockLLM.ainvoke).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ role: 'system' })])
  );
});
```

---

## Pull Request Process

### Before Submitting

1. **Fork and branch**

   ```bash
   git checkout -b feature/my-feature
   # or
   git checkout -b fix/bug-description
   ```

2. **Write code and tests**
   - Follow coding standards
   - Add tests for new functionality
   - Update documentation if needed

3. **Run checks**

   ```bash
   pnpm check
   ```

4. **Commit with clear messages**
   ```bash
   git commit -m "feat(agent): add pause/resume functionality"
   git commit -m "fix(browser): handle navigation timeout"
   git commit -m "docs(readme): update installation instructions"
   ```

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting
- `refactor`: Code restructuring
- `test`: Tests
- `chore`: Maintenance

### PR Checklist

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] All checks pass
- [ ] PR description explains changes

### Review Process

1. Submit PR with clear description
2. CI checks run automatically
3. Maintainer reviews code
4. Address feedback
5. PR merged when approved

---

## Issue Guidelines

### Bug Reports

Use the bug report template:

```markdown
## Bug Description

A clear description of the bug.

## Steps to Reproduce

1. Create agent with config...
2. Run task "..."
3. Observe error...

## Expected Behavior

What should happen.

## Actual Behavior

What actually happens.

## Environment

- Browser-Use version: x.x.x
- Node.js version: x.x.x
- OS: macOS/Linux/Windows
- LLM Provider: OpenAI/Anthropic/etc.

## Additional Context

Any relevant logs, screenshots, etc.
```

### Feature Requests

```markdown
## Feature Description

What you'd like to see.

## Use Case

Why this feature would be useful.

## Proposed Solution

How you think it could be implemented.

## Alternatives Considered

Other approaches you've thought about.
```

### Good Issue Titles

```
# Good
fix: Agent crashes when navigating to invalid URL
feat: Add support for Firefox browser
docs: Clarify configuration options for proxy

# Bad
Bug
Help needed
Not working
```

---

## Documentation

### Where to Document

| Change Type          | Documentation Location     |
| -------------------- | -------------------------- |
| New feature          | API Reference, Examples    |
| Configuration option | Configuration Guide        |
| Breaking change      | Migration guide, CHANGELOG |
| Bug fix              | CHANGELOG                  |
| New LLM provider     | LLM Providers Guide        |

### Documentation Style

```markdown
## Feature Name

Brief description of what this feature does.

### Usage

\`\`\`typescript
// Code example
const result = await feature.use();
\`\`\`

### Parameters

| Parameter | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `name`    | `string` | Yes      | Parameter description |

### Example

\`\`\`typescript
// Complete working example
\`\`\`

### Notes

- Important consideration 1
- Important consideration 2
```

---

## Release Process

### Version Numbers

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes
- **MINOR** (1.0.0 → 1.1.0): New features, backward compatible
- **PATCH** (1.0.0 → 1.0.1): Bug fixes, backward compatible

### Release Checklist

1. Update versions with `pnpm version:bump <version>`, `pnpm version:patch`, `pnpm version:minor`, or `pnpm version:major`
2. Update CHANGELOG.md
3. Run full test suite
4. Build and verify package exports
5. Create git tag
6. Publish to npm
7. Create GitHub release

### Changelog Format

```markdown
## [1.2.0] - 2024-01-15

### Added

- New feature description (#123)
- Another new feature (#124)

### Changed

- Modified behavior of X (#125)

### Fixed

- Bug fix description (#126)

### Deprecated

- Feature X will be removed in 2.0

### Removed

- Removed deprecated feature Y

### Security

- Fixed security issue (#127)
```

---

## Code of Conduct

We are committed to providing a welcoming and inclusive experience for everyone.

### Our Standards

- Be respectful and inclusive
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards others

### Unacceptable Behavior

- Harassment or discrimination
- Trolling or insulting comments
- Personal or political attacks
- Publishing others' private information

### Enforcement

Violations can be reported to the maintainers. All complaints will be reviewed and investigated.

---

## Getting Help

- **Discord**: Join our community server
- **GitHub Discussions**: Ask questions
- **Issues**: Report bugs or request features

Thank you for contributing to Browser-Use!
