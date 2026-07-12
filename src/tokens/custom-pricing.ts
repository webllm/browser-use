import type { ModelPricing } from './views.js';

export const CUSTOM_MODEL_PRICING: Record<
  string,
  Partial<ModelPricing> & Record<string, number | null | string>
> = {
  'bu-1-0': {
    input_cost_per_token: 0.2 / 1_000_000,
    output_cost_per_token: 2.0 / 1_000_000,
    cache_read_input_token_cost: 0.02 / 1_000_000,
    cache_creation_input_token_cost: null,
    max_tokens: null,
    max_input_tokens: null,
    max_output_tokens: null,
  },
  'bu-2-0': {
    input_cost_per_token: 0.6 / 1_000_000,
    output_cost_per_token: 3.5 / 1_000_000,
    cache_read_input_token_cost: 0.06 / 1_000_000,
    cache_creation_input_token_cost: null,
    max_tokens: null,
    max_input_tokens: null,
    max_output_tokens: null,
  },
  'claude-sonnet-4-6': {
    input_cost_per_token: 3 / 1_000_000,
    output_cost_per_token: 15 / 1_000_000,
    cache_read_input_token_cost: 0.3 / 1_000_000,
    cache_creation_input_token_cost: 3.75 / 1_000_000,
    cache_creation_1h_input_token_cost: 6 / 1_000_000,
    max_tokens: null,
    max_input_tokens: null,
    max_output_tokens: null,
  },
  'anthropic/claude-sonnet-4.6': {
    input_cost_per_token: 3 / 1_000_000,
    output_cost_per_token: 15 / 1_000_000,
    cache_read_input_token_cost: 0.3 / 1_000_000,
    cache_creation_input_token_cost: 3.75 / 1_000_000,
    cache_creation_1h_input_token_cost: 6 / 1_000_000,
    max_tokens: null,
    max_input_tokens: null,
    max_output_tokens: null,
  },
  'claude-opus-4-6': {
    input_cost_per_token: 5 / 1_000_000,
    output_cost_per_token: 25 / 1_000_000,
    cache_read_input_token_cost: 0.5 / 1_000_000,
    cache_creation_input_token_cost: 6.25 / 1_000_000,
    cache_creation_1h_input_token_cost: 10 / 1_000_000,
    max_tokens: null,
    max_input_tokens: null,
    max_output_tokens: null,
  },
  'anthropic/claude-opus-4.6': {
    input_cost_per_token: 5 / 1_000_000,
    output_cost_per_token: 25 / 1_000_000,
    cache_read_input_token_cost: 0.5 / 1_000_000,
    cache_creation_input_token_cost: 6.25 / 1_000_000,
    cache_creation_1h_input_token_cost: 10 / 1_000_000,
    max_tokens: null,
    max_input_tokens: null,
    max_output_tokens: null,
  },
  'claude-fable-5': {
    input_cost_per_token: 10 / 1_000_000,
    output_cost_per_token: 50 / 1_000_000,
    cache_read_input_token_cost: 1 / 1_000_000,
    cache_creation_input_token_cost: 12.5 / 1_000_000,
    cache_creation_1h_input_token_cost: 20 / 1_000_000,
    max_tokens: 1_000_000,
    max_input_tokens: 1_000_000,
    max_output_tokens: 128_000,
  },
  'anthropic/claude-fable-5': {
    input_cost_per_token: 10 / 1_000_000,
    output_cost_per_token: 50 / 1_000_000,
    cache_read_input_token_cost: 1 / 1_000_000,
    cache_creation_input_token_cost: 12.5 / 1_000_000,
    cache_creation_1h_input_token_cost: 20 / 1_000_000,
    max_tokens: 1_000_000,
    max_input_tokens: 1_000_000,
    max_output_tokens: 128_000,
  },
};

CUSTOM_MODEL_PRICING['bu-latest'] = CUSTOM_MODEL_PRICING['bu-2-0'];
CUSTOM_MODEL_PRICING.smart = CUSTOM_MODEL_PRICING['bu-2-0'];
CUSTOM_MODEL_PRICING['anthropic/claude-sonnet-4-6'] =
  CUSTOM_MODEL_PRICING['claude-sonnet-4-6'];
CUSTOM_MODEL_PRICING['anthropic/claude-opus-4-6'] =
  CUSTOM_MODEL_PRICING['claude-opus-4-6'];
