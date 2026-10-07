import type { BaseChatModel } from './base.js';
import { ChatAnthropic } from './anthropic/chat.js';
import { ChatBedrockConverse } from './aws/chat-bedrock.js';
import { ChatAzure } from './azure/chat.js';
import { ChatBrowserUse } from './browser-use/chat.js';
import { ChatCerebras } from './cerebras/chat.js';
import { ChatDeepSeek } from './deepseek/chat.js';
import { ChatGoogle } from './google/chat.js';
import { ChatGroq } from './groq/chat.js';
import { ChatLiteLLM } from './litellm/chat.js';
import { ChatMistral } from './mistral/chat.js';
import { ChatOCIRaw } from './oci-raw/chat.js';
import { ChatOllama } from './ollama/chat.js';
import { ChatOpenAI } from './openai/chat.js';
import { ChatOpenRouter } from './openrouter/chat.js';
import { ChatOrcaRouter } from './orcarouter/chat.js';
import { ChatVercel } from './vercel/chat.js';

type ResolvedProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'openrouter'
  | 'orcarouter'
  | 'azure'
  | 'ollama'
  | 'aws'
  | 'browser-use'
  | 'mistral'
  | 'cerebras'
  | 'vercel'
  | 'litellm'
  | 'oci';

const AVAILABLE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'openrouter',
  'orcarouter',
  'azure',
  'ollama',
  'aws',
  'browser-use',
  'mistral',
  'cerebras',
  'vercel',
  'litellm',
  'oci',
] as const;

const MISTRAL_ALIAS_MAP: Record<string, string> = {
  large: 'mistral-large-latest',
  medium: 'mistral-medium-latest',
  small: 'mistral-small-latest',
  codestral: 'codestral-latest',
  // Pixtral Large was retired; Mistral names Mistral Medium as its replacement.
  'pixtral-large': 'mistral-medium-latest',
  pixtral_large: 'mistral-medium-latest',
};

const convertPythonModelPart = (modelPart: string): string => {
  if (modelPart.includes('gpt_4_1_mini')) {
    return modelPart.replace('gpt_4_1_mini', 'gpt-4.1-mini');
  }
  if (modelPart.includes('gpt_4o_mini')) {
    return modelPart.replace('gpt_4o_mini', 'gpt-4o-mini');
  }
  if (modelPart.includes('gpt_4o')) {
    return modelPart.replace('gpt_4o', 'gpt-4o');
  }
  if (modelPart.includes('gemini_2_0')) {
    return modelPart.replace('gemini_2_0', 'gemini-2.0').replace(/_/g, '-');
  }
  if (modelPart.includes('gemini_2_5')) {
    return modelPart.replace('gemini_2_5', 'gemini-2.5').replace(/_/g, '-');
  }
  if (modelPart.includes('llama3_1')) {
    return modelPart.replace('llama3_1', 'llama3.1').replace(/_/g, '-');
  }
  if (modelPart.includes('llama3_3')) {
    return modelPart.replace('llama3_3', 'llama-3.3').replace(/_/g, '-');
  }
  if (modelPart.includes('llama_4_scout')) {
    return modelPart
      .replace('llama_4_scout', 'llama-4-scout')
      .replace(/_/g, '-');
  }
  if (modelPart.includes('llama_4_maverick')) {
    return modelPart
      .replace('llama_4_maverick', 'llama-4-maverick')
      .replace(/_/g, '-');
  }
  if (modelPart.includes('gpt_oss_120b')) {
    return modelPart.replace('gpt_oss_120b', 'gpt-oss-120b');
  }
  if (modelPart.includes('zai_glm_4_7')) {
    return modelPart.replace('zai_glm_4_7', 'zai-glm-4.7');
  }
  if (modelPart.includes('qwen_3_32b')) {
    return modelPart.replace('qwen_3_32b', 'qwen-3-32b');
  }
  if (modelPart.includes('qwen_3_235b_a22b_instruct_2507')) {
    return modelPart.replace(
      'qwen_3_235b_a22b_instruct_2507',
      'qwen-3-235b-a22b-instruct-2507'
    );
  }
  if (modelPart.includes('qwen_3_235b_a22b_instruct')) {
    return modelPart.replace(
      'qwen_3_235b_a22b_instruct',
      'qwen-3-235b-a22b-instruct-2507'
    );
  }
  if (modelPart.includes('qwen_3_235b_a22b_thinking_2507')) {
    return modelPart.replace(
      'qwen_3_235b_a22b_thinking_2507',
      'qwen-3-235b-a22b-thinking-2507'
    );
  }
  if (modelPart.includes('qwen_3_235b_a22b_thinking')) {
    return modelPart.replace(
      'qwen_3_235b_a22b_thinking',
      'qwen-3-235b-a22b-thinking-2507'
    );
  }
  if (modelPart.includes('qwen_3_coder_480b')) {
    return modelPart.replace('qwen_3_coder_480b', 'qwen-3-coder-480b');
  }
  return modelPart.replace(/_/g, '-');
};

const normalizeMistralModel = (model: string): string => {
  const key = model.trim().toLowerCase();
  return MISTRAL_ALIAS_MAP[key] ?? model;
};

const inferProviderFromModel = (model: string): ResolvedProvider | null => {
  const lower = model.toLowerCase();
  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.startsWith('gpt-5')
  ) {
    return 'openai';
  }
  if (lower.startsWith('claude')) {
    return 'anthropic';
  }
  if (lower.startsWith('gemini')) {
    return 'google';
  }
  if (lower.startsWith('deepseek')) {
    return 'deepseek';
  }
  if (lower.startsWith('groq:')) {
    return 'groq';
  }
  if (lower.startsWith('openrouter:')) {
    return 'openrouter';
  }
  if (lower.startsWith('orcarouter:')) {
    return 'orcarouter';
  }
  if (lower.startsWith('azure:')) {
    return 'azure';
  }
  if (lower.startsWith('ollama:')) {
    return 'ollama';
  }
  if (lower.startsWith('mistral:')) {
    return 'mistral';
  }
  if (lower.startsWith('cerebras:')) {
    return 'cerebras';
  }
  if (lower.startsWith('vercel:')) {
    return 'vercel';
  }
  if (lower.startsWith('litellm:')) {
    return 'litellm';
  }
  if (lower.startsWith('oci:')) {
    return 'oci';
  }
  if (
    lower.startsWith('mistral-') ||
    lower.startsWith('codestral') ||
    lower.startsWith('pixtral')
  ) {
    return 'mistral';
  }
  if (
    lower.startsWith('llama3.') ||
    lower.startsWith('llama-4-') ||
    lower.startsWith('gpt-oss-') ||
    lower.startsWith('qwen-3-') ||
    lower.startsWith('zai-glm-')
  ) {
    return 'cerebras';
  }
  if (lower.startsWith('bedrock:')) {
    return 'aws';
  }
  if (lower.startsWith('anthropic.')) {
    return 'aws';
  }
  if (lower.startsWith('bu-') || lower.startsWith('browser-use/')) {
    return 'browser-use';
  }
  if (
    lower.includes('/') &&
    !lower.startsWith('http://') &&
    !lower.startsWith('https://')
  ) {
    return 'openrouter';
  }
  return null;
};

const normalizeModelForProvider = (
  provider: ResolvedProvider,
  model: string
): string => {
  const lower = model.toLowerCase();
  if (provider === 'groq' && lower.startsWith('groq:')) {
    return model.slice('groq:'.length);
  }
  if (provider === 'openrouter' && lower.startsWith('openrouter:')) {
    return model.slice('openrouter:'.length);
  }
  if (provider === 'orcarouter' && lower.startsWith('orcarouter:')) {
    return model.slice('orcarouter:'.length);
  }
  if (provider === 'azure' && lower.startsWith('azure:')) {
    return model.slice('azure:'.length);
  }
  if (provider === 'ollama' && lower.startsWith('ollama:')) {
    return model.slice('ollama:'.length);
  }
  if (provider === 'mistral' && lower.startsWith('mistral:')) {
    return model.slice('mistral:'.length);
  }
  if (provider === 'cerebras' && lower.startsWith('cerebras:')) {
    return model.slice('cerebras:'.length);
  }
  if (provider === 'vercel' && lower.startsWith('vercel:')) {
    return model.slice('vercel:'.length);
  }
  if (provider === 'litellm' && lower.startsWith('litellm:')) {
    return model.slice('litellm:'.length);
  }
  if (provider === 'oci' && lower.startsWith('oci:')) {
    return model.slice('oci:'.length);
  }
  if (provider === 'aws' && lower.startsWith('bedrock:')) {
    return model.slice('bedrock:'.length);
  }
  return model;
};

const buildProviderModel = (
  provider: ResolvedProvider,
  model: string
): BaseChatModel => {
  switch (provider) {
    case 'openai':
      return new ChatOpenAI({
        model,
        apiKey: process.env.OPENAI_API_KEY,
      });
    case 'anthropic':
      return new ChatAnthropic({
        model,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    case 'google':
      return new ChatGoogle({
        model,
        apiKey: process.env.GOOGLE_API_KEY || '',
      });
    case 'deepseek':
      return new ChatDeepSeek({
        model,
        apiKey: process.env.DEEPSEEK_API_KEY,
      });
    case 'groq':
      return new ChatGroq({
        model,
        apiKey: process.env.GROQ_API_KEY,
      });
    case 'openrouter':
      return new ChatOpenRouter({
        model,
        apiKey: process.env.OPENROUTER_API_KEY,
      });
    case 'orcarouter':
      return new ChatOrcaRouter({
        model,
        apiKey: process.env.ORCAROUTER_API_KEY,
      });
    case 'azure':
      return new ChatAzure({
        model,
        apiKey:
          process.env.AZURE_OPENAI_KEY ?? process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      });
    case 'ollama':
      return new ChatOllama({
        model,
        host: process.env.OLLAMA_HOST || 'http://localhost:11434',
      });
    case 'mistral':
      return new ChatMistral({
        model: normalizeMistralModel(model),
        apiKey: process.env.MISTRAL_API_KEY,
        baseURL: process.env.MISTRAL_BASE_URL,
      });
    case 'cerebras':
      return new ChatCerebras({
        model,
        apiKey: process.env.CEREBRAS_API_KEY,
        baseURL: process.env.CEREBRAS_BASE_URL,
      });
    case 'vercel':
      return new ChatVercel({
        model,
        apiKey: process.env.VERCEL_API_KEY,
        baseURL: process.env.VERCEL_BASE_URL,
      });
    case 'litellm':
      return new ChatLiteLLM({
        model,
        apiKey: process.env.LITELLM_API_KEY,
        baseURL: process.env.LITELLM_API_BASE ?? process.env.LITELLM_BASE_URL,
      });
    case 'oci':
      return new ChatOCIRaw({
        model,
      });
    case 'aws':
      return new ChatBedrockConverse({
        model,
        region: process.env.AWS_REGION || 'us-east-1',
      });
    case 'browser-use':
      return new ChatBrowserUse({
        model,
        apiKey: process.env.BROWSER_USE_API_KEY,
      });
    default:
      throw new Error(
        `Unknown provider '${provider}'. Available providers: ${AVAILABLE_PROVIDERS.join(', ')}`
      );
  }
};

export const getLlmByName = (modelName: string): BaseChatModel => {
  const normalizedName = modelName.trim();
  if (!normalizedName) {
    throw new Error('Model name cannot be empty');
  }

  if (normalizedName === 'bu_latest') {
    return buildProviderModel('browser-use', 'bu-latest');
  }
  if (normalizedName === 'bu_1_0') {
    return buildProviderModel('browser-use', 'bu-1-0');
  }
  if (normalizedName === 'bu_2_0') {
    return buildProviderModel('browser-use', 'bu-2-0');
  }

  if (normalizedName === 'mistral_large') {
    return buildProviderModel('mistral', 'mistral-large-latest');
  }
  if (normalizedName === 'mistral_medium') {
    return buildProviderModel('mistral', 'mistral-medium-latest');
  }
  if (normalizedName === 'mistral_small') {
    return buildProviderModel('mistral', 'mistral-small-latest');
  }
  if (normalizedName === 'codestral') {
    return buildProviderModel('mistral', 'codestral-latest');
  }
  if (normalizedName === 'pixtral_large') {
    return buildProviderModel('mistral', 'mistral-medium-latest');
  }

  const separator = normalizedName.indexOf('_');
  if (separator > 0) {
    const provider = normalizedName.slice(0, separator);
    const modelPart = normalizedName.slice(separator + 1);
    if (provider === 'bu') {
      return buildProviderModel(
        'browser-use',
        `bu-${modelPart.replace(/_/g, '-')}`
      );
    }
    if (provider === 'oci') {
      return buildProviderModel('oci', modelPart);
    }
    if (provider === 'browser-use') {
      return buildProviderModel('browser-use', modelPart.replace(/_/g, '/'));
    }
    if (AVAILABLE_PROVIDERS.includes(provider as any)) {
      return buildProviderModel(
        provider as ResolvedProvider,
        convertPythonModelPart(modelPart)
      );
    }
  }

  const inferredProvider = inferProviderFromModel(normalizedName);
  if (!inferredProvider) {
    throw new Error(
      `Invalid model name format: '${normalizedName}'. Expected provider-prefixed name like 'openai_gpt_4o' or a recognizable model prefix.`
    );
  }

  const normalizedModel = normalizeModelForProvider(
    inferredProvider,
    normalizedName
  );
  return buildProviderModel(inferredProvider, normalizedModel);
};
