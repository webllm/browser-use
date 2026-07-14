import axios from 'axios';
import { createLogger } from '../logging-config.js';
import type { ModelPricing } from './views.js';
import { MAX_PRICING_METADATA_BYTES } from './pricing-limits.js';

const logger = createLogger('browser_use.tokens.openrouter');

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_MODELS_CACHE_MS = 60 * 60 * 1000;

type OpenRouterMetadata = Record<string, any>;

let openRouterModelsCache: Record<string, OpenRouterMetadata> | null = null;
let openRouterModelsCacheFetchedAt = 0;

const floatOrNull = (value: unknown) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const intOrNull = (value: unknown) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const normalizeOpenRouterModelId = (modelName: string) => {
  let modelId = modelName;
  if (modelId.startsWith('openrouter/')) {
    modelId = modelId.slice('openrouter/'.length);
  } else if (modelId.startsWith('openrouter-')) {
    modelId = modelId.slice('openrouter-'.length);
  }

  return modelId.includes('/') ? modelId : null;
};

export const isOpenRouterPricingModel = (modelName: string) =>
  modelName.startsWith('openrouter/') || modelName.startsWith('openrouter-');

export const resetOpenRouterPricingCacheForTesting = () => {
  openRouterModelsCache = null;
  openRouterModelsCacheFetchedAt = 0;
};

export async function getOpenRouterModelsMetadata(refresh = false) {
  const now = Date.now();
  if (
    !refresh &&
    openRouterModelsCache &&
    now - openRouterModelsCacheFetchedAt < OPENROUTER_MODELS_CACHE_MS
  ) {
    return openRouterModelsCache;
  }

  try {
    const response = await axios.get<{ data?: unknown[] }>(
      OPENROUTER_MODELS_URL,
      {
        timeout: 30_000,
        maxContentLength: MAX_PRICING_METADATA_BYTES,
        maxBodyLength: MAX_PRICING_METADATA_BYTES,
        maxRedirects: 0,
      }
    );
    const models = Array.isArray(response.data?.data) ? response.data.data : [];
    openRouterModelsCache = {};
    for (const model of models) {
      if (
        model &&
        typeof model === 'object' &&
        typeof (model as OpenRouterMetadata).id === 'string'
      ) {
        openRouterModelsCache[(model as OpenRouterMetadata).id] =
          model as OpenRouterMetadata;
      }
    }
    openRouterModelsCacheFetchedAt = now;
    return openRouterModelsCache;
  } catch (error) {
    logger.debug(
      `Failed to fetch OpenRouter pricing: ${(error as Error).message}`
    );
    return openRouterModelsCache ?? {};
  }
}

export async function getOpenRouterModelMetadata(
  modelName: string,
  refresh = false
) {
  const modelId = normalizeOpenRouterModelId(modelName);
  if (!modelId) {
    return null;
  }
  const models = await getOpenRouterModelsMetadata(refresh);
  return models[modelId] ?? null;
}

export function modelPricingFromOpenRouterMetadata(
  modelName: string,
  metadata: OpenRouterMetadata
): ModelPricing | null {
  const pricing = metadata.pricing;
  if (!pricing || typeof pricing !== 'object') {
    return null;
  }

  const inputCost = floatOrNull(pricing.prompt);
  const outputCost = floatOrNull(pricing.completion);
  if (inputCost == null && outputCost == null) {
    return null;
  }

  const contextLength = intOrNull(metadata.context_length);
  const topProvider = metadata.top_provider;
  const maxOutputTokens =
    topProvider && typeof topProvider === 'object'
      ? intOrNull(topProvider.max_completion_tokens)
      : null;

  return {
    model: modelName,
    input_cost_per_token: inputCost,
    output_cost_per_token: outputCost,
    cache_read_input_token_cost: floatOrNull(pricing.input_cache_read),
    cache_creation_input_token_cost: floatOrNull(pricing.input_cache_write),
    cache_creation_1h_input_token_cost: null,
    max_tokens: contextLength,
    max_input_tokens: contextLength,
    max_output_tokens: maxOutputTokens,
  };
}

export async function getOpenRouterModelPricing(
  modelName: string,
  refresh = false
) {
  const metadata = await getOpenRouterModelMetadata(modelName, refresh);
  if (!metadata) {
    return null;
  }
  return modelPricingFromOpenRouterMetadata(modelName, metadata);
}
