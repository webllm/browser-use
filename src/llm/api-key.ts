import { ModelProviderError } from './exceptions.js';

/**
 * The OpenAI SDK reads OPENAI_API_KEY whenever `apiKey` is undefined. Adapters
 * that point the SDK at another provider pass this placeholder instead, so an
 * unrelated OpenAI key is never sent to a third-party endpoint.
 */
export const MISSING_PROVIDER_API_KEY = 'browser-use-missing-api-key';

const hasKeyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const resolveProviderApiKey = (
  explicitKey: unknown,
  envNames: readonly string[]
): string | null => {
  if (hasKeyText(explicitKey)) {
    return explicitKey;
  }
  for (const name of envNames) {
    const value = process.env[name];
    if (hasKeyText(value)) {
      return value;
    }
  }
  return null;
};

export const createMissingApiKeyError = (
  providerLabel: string,
  envNames: readonly string[],
  model: string
) =>
  new ModelProviderError(
    `Missing ${providerLabel} API key. Set ${envNames.join(' or ')} or pass apiKey.`,
    401,
    model
  );
