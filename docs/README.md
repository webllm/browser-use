# Browser-Use Documentation

> **Browser-Use** is a powerful TypeScript/Node.js library for autonomous browser automation powered by Large Language Models (LLMs).

## Overview

Browser-Use enables AI agents to autonomously control web browsers, making decisions based on page content, executing actions, and completing complex multi-step tasks. It bridges the gap between natural language instructions and browser automation.

## Key Features

- **Autonomous Browser Control**: AI-driven navigation, clicking, typing, and form filling
- **Multi-LLM Support**: Compatible with OpenAI, Anthropic, Google Gemini, Azure, AWS Bedrock, Groq, Ollama, DeepSeek, OpenRouter, Mistral, Cerebras, Browser Use, LiteLLM, OCI Raw, and Vercel
- **Vision Capabilities**: Screenshot-based understanding for visual web interactions
- **Custom Actions**: Extensible action registry for domain-specific operations
- **Security First**: Built-in sensitive data masking and domain restrictions
- **MCP Integration**: Model Context Protocol support for Claude Desktop
- **Comprehensive Logging**: Detailed telemetry, event tracking, and debugging

## Documentation Index

| Document                                 | Description                                         |
| ---------------------------------------- | --------------------------------------------------- |
| [Quick Start](./QUICKSTART.md)           | Get started in 5 minutes                            |
| [Architecture](./ARCHITECTURE.md)        | System design and component overview                |
| [Architecture decisions](./adr/index.md) | Long-lived technical decisions and their rationale  |
| [API Reference](./API_REFERENCE.md)      | Complete API documentation                          |
| [Configuration](./CONFIGURATION.md)      | Configuration options and environment variables     |
| [LLM Providers](./LLM_PROVIDERS.md)      | Setting up different LLM providers                  |
| [Actions](./ACTIONS.md)                  | Built-in actions and custom action development      |
| [MCP Server](./MCP_SERVER.md)            | Model Context Protocol integration                  |
| [Security](./SECURITY.md)                | Sensitive data handling and security best practices |
| [Examples](./EXAMPLES.md)                | Code examples and use cases                         |
| [Contributing](./CONTRIBUTING.md)        | Contribution guidelines                             |

## Installation

```bash
# Using npm
npm install browser-use

# Using pnpm
pnpm add browser-use
```

## Quick Example

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

// Create an agent with a task
const agent = new Agent({
  task: 'Go to google.com and search for "TypeScript tutorials"',
  llm: new ChatOpenAI({
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

// Run the agent
const history = await agent.run();

// Check results
console.log('Task completed:', history.is_successful());
console.log('Final result:', history.final_result());
```

## Requirements

- **Node.js**: >= 18.0.0
- **Playwright**: Installed automatically as dependency
- **LLM API Key**: At least one supported LLM provider

## License

MIT License - see [LICENSE](../LICENSE) for details.

## Support

- **GitHub Issues**: [Report bugs and request features](https://github.com/webllm/browser-use/issues)
- **Discussions**: [Community discussions](https://github.com/webllm/browser-use/discussions)
