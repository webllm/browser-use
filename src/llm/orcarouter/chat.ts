import {
  OpenAIRouterChat,
  type OpenAIRouterChatOptions,
  type OpenAIRouterProvider,
} from '../openai-router.js';

const ORCAROUTER: OpenAIRouterProvider = {
  provider: 'orcarouter',
  label: 'OrcaRouter',
  apiKeyEnv: ['ORCAROUTER_API_KEY'],
  defaultBaseURL: 'https://api.orcarouter.ai/v1',
};

export type ChatOrcaRouterOptions = OpenAIRouterChatOptions;

/**
 * OrcaRouter's OpenAI-compatible gateway, which routes to many upstream
 * models. The model name is required; the API key comes from `apiKey` or
 * ORCAROUTER_API_KEY.
 */
export class ChatOrcaRouter extends OpenAIRouterChat {
  constructor(options: string | ChatOrcaRouterOptions) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    if (!normalizedOptions?.model?.trim()) {
      throw new Error('ChatOrcaRouter requires a model name');
    }
    super(ORCAROUTER, normalizedOptions);
  }
}
