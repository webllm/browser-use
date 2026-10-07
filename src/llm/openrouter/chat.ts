import {
  OpenAIRouterChat,
  type OpenAIRouterChatOptions,
  type OpenAIRouterProvider,
} from '../openai-router.js';

const OPENROUTER: OpenAIRouterProvider = {
  provider: 'openrouter',
  label: 'OpenRouter',
  apiKeyEnv: ['OPENROUTER_API_KEY'],
  defaultBaseURL: 'https://openrouter.ai/api/v1',
};

export interface ChatOpenRouterOptions extends Omit<
  OpenAIRouterChatOptions,
  'model'
> {
  model?: string;
  /** Sent as the `HTTP-Referer` header for OpenRouter app attribution. */
  httpReferer?: string | null;
}

export class ChatOpenRouter extends OpenAIRouterChat {
  constructor(options: string | ChatOpenRouterOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'openai/gpt-4o',
      httpReferer = null,
      ...rest
    } = normalizedOptions;
    super(
      OPENROUTER,
      { ...rest, model },
      httpReferer ? { 'HTTP-Referer': httpReferer } : null
    );
  }
}
