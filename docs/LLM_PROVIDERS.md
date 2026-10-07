# LLM Providers Guide

Browser-Use supports multiple LLM providers through a unified interface. This guide covers setup and configuration for each provider.

## Supported Providers

| Provider      | Vision Support | Reasoning Models | Caching | Notes                             |
| ------------- | -------------- | ---------------- | ------- | --------------------------------- |
| OpenAI        | ✅             | ✅ (o1, o3, o4)  | ❌      | Default provider                  |
| Codex         | ✅             | ✅               | ❌      | Experimental ChatGPT/Codex OAuth  |
| Anthropic     | ✅             | ✅               | ✅      | Adaptive thinking and tool output |
| Google Gemini | ✅             | ✅               | ❌      | Extended thinking support         |
| Azure OpenAI  | ✅             | ✅               | ❌      | Enterprise deployment             |
| AWS Bedrock   | ✅             | ❌               | ❌      | Claude via AWS                    |
| Groq          | ❌             | ❌               | ❌      | Fastest inference                 |
| Ollama        | ❌             | ❌               | ❌      | Local models                      |
| DeepSeek      | ❌             | ❌               | ❌      | Cost-effective                    |
| OpenRouter    | Varies         | Varies           | ❌      | Multi-model routing               |
| OrcaRouter    | Varies         | Varies           | ❌      | Multi-model routing               |
| Mistral       | Varies         | ❌               | ❌      | Mistral-hosted models             |
| Cerebras      | ❌             | ❌               | ❌      | Fast hosted inference             |
| Browser Use   | Varies         | Varies           | ❌      | Browser Use hosted LLM            |
| LiteLLM       | Varies         | Varies           | Varies  | OpenAI-compatible gateway         |
| OCI Raw       | Varies         | Varies           | ❌      | Oracle Cloud GenAI                |
| Vercel        | Varies         | Varies           | Varies  | AI Gateway / routed models        |

## OpenAI

### Setup

```bash
npm install openai  # Installed automatically with browser-use
```

Set your API key:

```bash
export OPENAI_API_KEY=sk-your-api-key
```

### Usage

```typescript
import { ChatOpenAI } from 'browser-use/llm/openai';

const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.7,
});
```

### Available Models

| Model         | Vision | Best For                    |
| ------------- | ------ | --------------------------- |
| `gpt-4o`      | ✅     | General tasks, best quality |
| `gpt-4o-mini` | ✅     | Fast, cost-effective        |
| `gpt-4-turbo` | ✅     | Complex reasoning           |
| `o1`          | ❌     | Advanced reasoning          |
| `o1-mini`     | ❌     | Fast reasoning              |
| `o3`          | ❌     | Next-gen reasoning          |
| `o3-mini`     | ❌     | Fast next-gen reasoning     |
| `o4-mini`     | ❌     | Latest reasoning            |

### Reasoning Models

For reasoning models (o1, o3, o4 series), use the `reasoningEffort` parameter:

```typescript
const llm = new ChatOpenAI({
  model: 'o3-mini',
  apiKey: process.env.OPENAI_API_KEY,
  reasoningEffort: 'medium', // 'low', 'medium', 'high'
});
```

### Advanced Options

```typescript
const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.7,
  baseURL: 'https://api.openai.com/v1', // Custom endpoint
  maxRetries: 3,
});
```

---

## Codex OAuth Provider

Codex support is an experimental independent provider for ChatGPT/Codex OAuth
sessions. It is separate from the standard OpenAI API-key provider and uses the
Codex Responses API backend at `https://chatgpt.com/backend-api/codex` by
default.

### Setup

Run a browser-use-owned Codex login:

```bash
npx browser-use auth codex login
```

This stores tokens in the browser-use config directory, for example
`~/.config/browseruse/auth.json`. The file is written with private permissions
on Unix systems. Browser-use does not write to `~/.codex/auth.json`.

You can explicitly import existing Codex CLI credentials:

```bash
npx browser-use auth codex import
```

Importing is a one-time copy into the browser-use auth store. Browser-use keeps
its own refresh lifecycle after import and still does not write the Codex CLI
auth file. Because OAuth refresh tokens can rotate, import is mainly a
convenience path; use `browser-use auth codex login` for the cleanest separation
from Codex CLI.

### Usage

```typescript
import { ChatCodex } from 'browser-use/llm/codex';

const llm = new ChatCodex({
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
});
```

CLI usage:

```bash
npx browser-use --provider codex -p "Open example.com and summarize it"
npx browser-use --model codex:gpt-5.5 -p "Check this workflow"
```

### Auth Commands

```bash
npx browser-use auth codex status
npx browser-use auth codex login --force
npx browser-use auth codex logout
```

### Local Smoke E2E

After logging in with `browser-use auth codex login`, run the local Codex smoke
suite from the repo:

```bash
pnpm test:e2e:codex
```

This validates the browser-use auth store, CLI JSON status path, a direct Codex
Responses call, and structured output. To also run a real one-step Agent smoke
that verifies agent monitoring events, use:

```bash
pnpm test:e2e:codex:agent
```

These tests intentionally require local auth and real network access, so they
are excluded from the default unit test command.

### Environment Overrides

```bash
export BROWSER_USE_CODEX_MODEL=gpt-5.5
export BROWSER_USE_CODEX_BASE_URL=https://chatgpt.com/backend-api/codex
export BROWSER_USE_CODEX_ACCESS_TOKEN=your-access-token
```

`BROWSER_USE_CODEX_ACCESS_TOKEN` is intended for short-lived testing and
automation. Prefer `browser-use auth codex login` for normal local use so
browser-use can refresh its own token store.

---

## Anthropic

### Setup

```bash
npm install @anthropic-ai/sdk
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-api-key
```

### Usage

```typescript
import { ChatAnthropic } from 'browser-use/llm/anthropic';

const llm = new ChatAnthropic({
  model: 'claude-opus-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

### Example Models

Model identifiers are passed through to Anthropic. `ChatAnthropic` defaults to
`claude-opus-5`; other current examples include `claude-sonnet-5`,
`claude-haiku-4-5`, and `claude-fable-5-1`. Claude Opus 4.7 and later reject
sampling parameters such as `temperature`, so leave them unset for those
models. Consult Anthropic's model catalog before choosing one.

### Cache Control

Anthropic supports prompt caching for reduced costs:

```typescript
import { SystemMessage } from 'browser-use/llm/messages';

// Mark messages for caching
const systemMsg = new SystemMessage('Your system prompt...');
systemMsg.cache = true; // Enable caching
```

### Advanced Options

```typescript
const llm = new ChatAnthropic({
  model: 'claude-fable-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinking: { type: 'adaptive', display: 'summarized' },
  outputConfig: { effort: 'high' },
  fallbacks: [{ model: 'claude-sonnet-4-6' }],
  inferenceGeo: 'us',
});
```

Anthropic integrations MUST use adaptive thinking for models that only support
that mode, including Claude Fable 5 and Claude Mythos 5. When thinking is
active, structured output uses automatic tool selection and accepts valid JSON
text if the model does not emit a tool call. Server-side fallbacks automatically
enable the required Anthropic beta; explicitly supplied `betas` are preserved.

Usage results retain thinking blocks, redacted thinking, stop details, and the
separate 5-minute and 1-hour cache-write token counts. Setting
`inferenceGeo: 'us'` also applies Anthropic's US-only pricing multiplier in cost
summaries.

The option contract is defined by
[`ChatAnthropicOptions`](../src/llm/anthropic/chat.ts). Verify the behavior with:

```bash
pnpm vitest run test/llm-anthropic-alignment.test.ts test/token-cost-alignment.test.ts
```

---

## Google Gemini

### Setup

```bash
npm install @google/genai
```

Set your API key:

```bash
export GOOGLE_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatGoogle } from 'browser-use/llm/google';

const llm = new ChatGoogle('gemini-2.5-flash');
// Configure GOOGLE_API_KEY in env.
// Optional env overrides: GOOGLE_API_BASE_URL, GOOGLE_API_VERSION.
```

### Available Models

| Model                  | Vision | Best For              |
| ---------------------- | ------ | --------------------- |
| `gemini-2.0-flash`     | ✅     | Default, fast         |
| `gemini-2.0-flash-exp` | ✅     | Experimental features |
| `gemini-exp-05-28`     | ✅     | Latest experimental   |
| `gemini-1.5-pro`       | ✅     | Complex tasks         |
| `gemini-1.5-flash`     | ✅     | Cost-effective        |

### Notes

Google provider configuration is environment-driven in this implementation.
Use `GOOGLE_API_KEY` plus optional `GOOGLE_API_BASE_URL` and `GOOGLE_API_VERSION`.

---

## Azure OpenAI

### Setup

Set your credentials:

```bash
export AZURE_OPENAI_API_KEY=your-api-key
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
```

### Usage

```typescript
import { ChatAzure } from 'browser-use/llm/azure';

const llm = new ChatAzure('gpt-4o');
// Configure AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION in env.
```

### Notes

```typescript
// Constructor currently accepts only the deployment/model name:
const llm = new ChatAzure('gpt-4o');
```

---

## AWS Bedrock

### Setup

Configure AWS credentials:

```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

Or use AWS profiles:

```bash
export AWS_PROFILE=your-profile
```

### Usage

```typescript
import { ChatAnthropicBedrock } from 'browser-use/llm/aws';

const llm = new ChatAnthropicBedrock({
  model: 'global.anthropic.claude-opus-4-6-v1',
  region: 'us-east-1',
  max_tokens: 4096,
});
```

### With Explicit Credentials

```typescript
// Credentials are resolved from the AWS SDK environment/profile chain.
const llm = new ChatAnthropicBedrock({
  model: 'global.anthropic.claude-opus-4-6-v1',
  region: 'us-east-1',
});
```

### Available Models

The Bedrock adapters use the Converse API. Newer Claude models are served
through cross-region inference profiles, so pass the profile ID (for example
with a `global.` or `us.` prefix) rather than the base model ID.

| Model ID                                          | Description       |
| ------------------------------------------------- | ----------------- |
| `global.anthropic.claude-opus-4-6-v1`             | Claude Opus 4.6   |
| `global.anthropic.claude-sonnet-4-6`              | Claude Sonnet 4.6 |
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5  |

---

## Groq

### Setup

Set your API key:

```bash
export GROQ_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatGroq } from 'browser-use/llm/groq';

const llm = new ChatGroq('openai/gpt-oss-120b');
```

### Available Models

| Model                                           | Structured output |
| ----------------------------------------------- | ----------------- |
| `openai/gpt-oss-120b` (default)                 | JSON schema       |
| `openai/gpt-oss-20b`                            | JSON schema       |
| `meta-llama/llama-4-maverick-17b-128e-instruct` | JSON schema       |
| `meta-llama/llama-4-scout-17b-16e-instruct`     | JSON schema       |

**Note:** Groq currently doesn't support vision. Use with `use_vision: false`.

---

## Ollama

### Setup

Install Ollama from [ollama.ai](https://ollama.ai):

```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3
```

### Usage

```typescript
import { ChatOllama } from 'browser-use/llm/ollama';

const llm = new ChatOllama('llama3', 'http://localhost:11434');
```

### Available Models

Any model available in Ollama:

- `llama3`, `llama3:70b`
- `mistral`, `mixtral`
- `codellama`
- `phi3`
- And many more...

**Note:** Most Ollama models don't support vision. Use with `use_vision: false`.

---

## DeepSeek

### Setup

Set your API key:

```bash
export DEEPSEEK_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatDeepSeek } from 'browser-use/llm/deepseek';

const llm = new ChatDeepSeek('deepseek-v4-flash');
```

DeepSeek retired `deepseek-chat` and `deepseek-reasoner` on 2026-07-24.
`ChatDeepSeek` defaults to `deepseek-v4-flash` and disables V4 server-side
thinking unless you pass `thinking: true`.

### Available Models

| Model               | Best For                |
| ------------------- | ----------------------- |
| `deepseek-v4-flash` | Fast general agent work |

**Note:** DeepSeek doesn't support vision yet. Use with `use_vision: false`.

---

## OpenRouter

### Setup

Set your API key:

```bash
export OPENROUTER_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatOpenRouter } from 'browser-use/llm/openrouter';

const llm = new ChatOpenRouter('anthropic/claude-3-opus');
```

### Model Selection

OpenRouter provides access to multiple providers. Use provider/model format:

| Model                             | Provider  |
| --------------------------------- | --------- |
| `anthropic/claude-3-opus`         | Anthropic |
| `openai/gpt-4-turbo`              | OpenAI    |
| `google/gemini-pro`               | Google    |
| `meta-llama/llama-3-70b-instruct` | Meta      |

---

## OrcaRouter

OrcaRouter is an OpenAI-compatible gateway that routes to many upstream
models. Usage is priced with OrcaRouter's own model names
(`orcarouter/<model>`), never with the upstream provider's prices.

```bash
export ORCAROUTER_API_KEY=your-api-key
```

```typescript
import { ChatOrcaRouter } from 'browser-use/llm/orcarouter';

const llm = new ChatOrcaRouter({
  model: 'anthropic/claude-sonnet-5',
  // baseURL defaults to https://api.orcarouter.ai/v1
});
```

The model name is required. The API key is read from `apiKey` or
`ORCAROUTER_API_KEY` only, never from `OPENAI_API_KEY`. `getLlmByName` accepts
`orcarouter:<model>` names.

---

## Additional Adapters

These adapters are also exported and supported by the package:

### Mistral

```bash
export MISTRAL_API_KEY=your-api-key
```

```typescript
import { ChatMistral } from 'browser-use/llm/mistral';

const llm = new ChatMistral('mistral-large-latest');
```

### Cerebras

```bash
export CEREBRAS_API_KEY=your-api-key
```

```typescript
import { ChatCerebras } from 'browser-use/llm/cerebras';

const llm = new ChatCerebras('gpt-oss-120b');
// Other current catalog models: 'zai-glm-4.7', 'gemma-4-31b'
```

### Browser Use

```bash
export BROWSER_USE_API_KEY=your-api-key
```

```typescript
import { ChatBrowserUse } from 'browser-use/llm/browser-use';

const llm = new ChatBrowserUse({ model: 'bu-latest' });
```

Aliases: `bu-latest` and `bu-2-0` (default), `bu-2-0-mini-preview` (cheaper,
opt-in while in preview), `bu-qa-1` (website QA), and the legacy `bu-1-0`, which
the gateway redirects to `bu-2-0`. Provider-prefixed ids such as
`anthropic/claude-sonnet-4-6` are routed by the gateway.

### LiteLLM

```bash
export LITELLM_API_KEY=your-api-key
export LITELLM_BASE_URL=http://localhost:4000
```

```typescript
import { ChatLiteLLM } from 'browser-use/llm/litellm';

const llm = new ChatLiteLLM('gpt-4o-mini');
```

### OCI Raw

```bash
export OCI_SERVICE_ENDPOINT=https://inference.generativeai.us-chicago-1.oci.oraclecloud.com
export OCI_COMPARTMENT_ID=ocid1.compartment.oc1...
export OCI_MODEL_ID=cohere.command-r-plus
```

```typescript
import { ChatOCIRaw } from 'browser-use/llm/oci-raw';

const llm = new ChatOCIRaw({ model: 'cohere.command-r-plus' });
```

### Vercel

```bash
export AI_GATEWAY_API_KEY=your-api-key
# VERCEL_OIDC_TOKEN and the legacy VERCEL_API_KEY are also accepted
```

```typescript
import { ChatVercel } from 'browser-use/llm/vercel';

const llm = new ChatVercel('openai/gpt-4o');
```

---

## Provider Comparison

### Speed vs Quality

```
Speed  ←──────────────────────────────────────────→ Quality
       Groq    Gemini-Flash    GPT-4o-mini    GPT-4o    Claude-Opus
       Ollama  DeepSeek        Gemini-Pro     Claude-Sonnet
```

### Cost Considerations

| Provider           | Input Tokens | Output Tokens | Notes                  |
| ------------------ | ------------ | ------------- | ---------------------- |
| OpenAI GPT-4o      | $2.50/1M     | $10/1M        | Standard pricing       |
| OpenAI GPT-4o-mini | $0.15/1M     | $0.60/1M      | Budget option          |
| Anthropic Claude   | $3/1M        | $15/1M        | With caching discounts |
| Google Gemini      | $0.075/1M    | $0.30/1M      | Cost-effective         |
| Groq               | Free tier    | Free tier     | Rate limited           |
| Ollama             | Free         | Free          | Self-hosted            |

### Recommended Configurations

**For Development:**

```typescript
// Fast iteration, low cost
const llm = new ChatOpenAI({ model: 'gpt-4o-mini' });
// or
const llm = new ChatGroq('llama-3.3-70b-versatile');
```

**For Production:**

```typescript
// Best quality
const llm = new ChatOpenAI({ model: 'gpt-4o' });
// or
const llm = new ChatAnthropic({ model: 'claude-opus-5' });
```

**For Complex Reasoning:**

```typescript
const llm = new ChatOpenAI({
  model: 'o3-mini',
  reasoningEffort: 'high',
});
```

**For Local/Privacy:**

```typescript
const llm = new ChatOllama('llama3:70b');
```

---

## Custom Provider Implementation

To add a custom LLM provider, implement the `BaseChatModel` interface:

```typescript
import { BaseChatModel, Message, ChatInvokeCompletion } from 'browser-use';

class MyCustomLLM implements BaseChatModel {
  model: string;
  provider = 'my-provider';

  constructor(options: { model: string; apiKey: string }) {
    this.model = options.model;
  }

  async ainvoke(
    messages: Message[],
    output_format?: ZodSchema
  ): Promise<ChatInvokeCompletion> {
    // Implement your LLM call here
    const response = await this.callMyAPI(messages);

    return new ChatInvokeCompletion(response.content, {
      prompt_tokens: response.usage.input,
      completion_tokens: response.usage.output,
      total_tokens: response.usage.total,
    });
  }
}
```
