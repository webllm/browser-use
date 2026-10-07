# LLM providers

Every provider implements `BaseChatModel` and reads only its own API key
variable. Pass `apiKey` to override it.

| Provider          | Import                                              | Key variable           | Example model                         |
| ----------------- | --------------------------------------------------- | ---------------------- | ------------------------------------- |
| Anthropic         | `ChatAnthropic` from `browser-use/llm/anthropic`    | `ANTHROPIC_API_KEY`    | `claude-opus-5`                       |
| OpenAI            | `ChatOpenAI` from `browser-use/llm/openai`          | `OPENAI_API_KEY`       | `gpt-5-mini`                          |
| Google            | `ChatGoogle` from `browser-use/llm/google`          | `GOOGLE_API_KEY`       | `gemini-2.5-flash`                    |
| Browser Use       | `ChatBrowserUse` from `browser-use/llm/browser-use` | `BROWSER_USE_API_KEY`  | `bu-latest`                           |
| Azure OpenAI      | `ChatAzure` from `browser-use/llm/azure`            | `AZURE_OPENAI_API_KEY` | deployment name                       |
| AWS Bedrock       | `ChatBedrockConverse` from `browser-use/llm/aws`    | AWS credentials        | `global.anthropic.claude-opus-4-6-v1` |
| Groq              | `ChatGroq` from `browser-use/llm/groq`              | `GROQ_API_KEY`         | `openai/gpt-oss-120b`                 |
| DeepSeek          | `ChatDeepSeek` from `browser-use/llm/deepseek`      | `DEEPSEEK_API_KEY`     | `deepseek-v4-flash`                   |
| Mistral           | `ChatMistral` from `browser-use/llm/mistral`        | `MISTRAL_API_KEY`      | `mistral-medium-latest`               |
| Cerebras          | `ChatCerebras` from `browser-use/llm/cerebras`      | `CEREBRAS_API_KEY`     | `gpt-oss-120b`                        |
| OpenRouter        | `ChatOpenRouter` from `browser-use/llm/openrouter`  | `OPENROUTER_API_KEY`   | `anthropic/claude-sonnet-5`           |
| OrcaRouter        | `ChatOrcaRouter` from `browser-use/llm/orcarouter`  | `ORCAROUTER_API_KEY`   | `anthropic/claude-sonnet-5`           |
| Vercel AI Gateway | `ChatVercel` from `browser-use/llm/vercel`          | `AI_GATEWAY_API_KEY`   | `openai/gpt-5`                        |
| Ollama            | `ChatOllama` from `browser-use/llm/ollama`          | none (`OLLAMA_HOST`)   | local model name                      |
| LiteLLM proxy     | `ChatLiteLLM` from `browser-use/llm/litellm`        | `LITELLM_API_KEY`      | proxy model name                      |

```typescript
import { ChatAnthropic } from 'browser-use/llm/anthropic';

const llm = new ChatAnthropic({
  model: 'claude-opus-5',
  thinking: { type: 'adaptive' },
});
```

Build a model from a name with `getLlmByName` (exported from `browser-use`):
prefixes such as `openrouter:`, `orcarouter:`, `azure:`, `groq:`, `ollama:`,
`bedrock:` select the provider, and plain names like `gpt-*`, `claude-*`, and
`gemini-*` are inferred.

Token usage and cost are tracked per agent; router gateways are priced with
their own model names, never with the upstream provider's prices.
