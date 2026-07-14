import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PRICING_METADATA_BYTES,
  TokenCost,
} from '../src/tokens/service.js';
import {
  OPENROUTER_MODELS_URL,
  resetOpenRouterPricingCacheForTesting,
} from '../src/tokens/openrouter-pricing.js';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

const mockedAxiosGet = vi.mocked(axios.get);

describe('TokenCost alignment', () => {
  beforeEach(() => {
    mockedAxiosGet.mockReset();
    resetOpenRouterPricingCacheForTesting();
  });

  it('returns custom browser-use pricing without LiteLLM cache', async () => {
    const tokenCost = new TokenCost(false);
    const pricing = await tokenCost.getModelPricing('bu-2-0');

    expect(pricing).not.toBeNull();
    expect(pricing?.model).toBe('bu-2-0');
    expect(pricing?.input_cost_per_token).toBeCloseTo(0.6 / 1_000_000);
    expect(pricing?.output_cost_per_token).toBeCloseTo(3.5 / 1_000_000);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(0.06 / 1_000_000);
  });

  it('keeps bu-latest and smart aliases aligned with bu-2-0 pricing', async () => {
    const tokenCost = new TokenCost(false);

    const canonical = await tokenCost.getModelPricing('bu-2-0');
    const latest = await tokenCost.getModelPricing('bu-latest');
    const smart = await tokenCost.getModelPricing('smart');

    expect(latest?.input_cost_per_token).toBe(canonical?.input_cost_per_token);
    expect(latest?.output_cost_per_token).toBe(
      canonical?.output_cost_per_token
    );
    expect(latest?.cache_read_input_token_cost).toBe(
      canonical?.cache_read_input_token_cost
    );
    expect(smart?.input_cost_per_token).toBe(canonical?.input_cost_per_token);
    expect(smart?.output_cost_per_token).toBe(canonical?.output_cost_per_token);
    expect(smart?.cache_read_input_token_cost).toBe(
      canonical?.cache_read_input_token_cost
    );
  });

  it('prices Anthropic cache TTLs and US-only inference independently', async () => {
    const tokenCost = new TokenCost(true);
    const usage = {
      prompt_tokens: 100,
      prompt_cached_tokens: 20,
      prompt_cache_creation_tokens: 7,
      prompt_cache_creation_5m_tokens: 3,
      prompt_cache_creation_1h_tokens: 4,
      prompt_image_tokens: null,
      completion_tokens: 10,
      total_tokens: 110,
      pricing_multiplier: 1.1,
    };

    const cost = await tokenCost.calculateCost('claude-fable-5', usage);

    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(cost?.new_prompt_cost).toBeCloseTo(0.00088);
    expect(cost?.prompt_read_cached_cost).toBeCloseTo(0.000022);
    expect(cost?.prompt_cache_creation_cost).toBeCloseTo(0.00012925);
    expect(cost?.completion_cost).toBeCloseTo(0.00055);

    tokenCost.addUsage('claude-fable-5', usage);
    const summary = await tokenCost.get_usage_summary();
    expect(summary.total_prompt_cache_creation_tokens).toBe(7);
    expect(summary.total_prompt_cache_creation_cost).toBeCloseTo(0.00012925);
    expect(summary.total_prompt_cost).toBeCloseTo(0.00103125);
  });

  it('keeps aggregate cache-write pricing for providers without TTL buckets', async () => {
    const tokenCost = new TokenCost(true);
    const cost = await tokenCost.calculateCost('claude-sonnet-4-6', {
      prompt_tokens: 10,
      prompt_cached_tokens: null,
      prompt_cache_creation_tokens: 8,
      prompt_image_tokens: null,
      completion_tokens: 2,
      total_tokens: 12,
    });

    expect(cost?.prompt_cache_creation_cost).toBeCloseTo(0.00003);
  });

  it('keeps malformed usage and pricing from corrupting cost totals', async () => {
    const tokenCost = new TokenCost(true);
    const malformedUsage = {
      prompt_tokens: 10,
      prompt_cached_tokens: 20,
      prompt_cache_creation_tokens: -1,
      prompt_cache_creation_5m_tokens: Number.POSITIVE_INFINITY,
      prompt_cache_creation_1h_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: Number.NaN,
      total_tokens: Number.NaN,
      pricing_multiplier: Number.POSITIVE_INFINITY,
    };

    const cost = await tokenCost.calculateCost(
      'claude-sonnet-4-6',
      malformedUsage
    );
    tokenCost.addUsage('claude-sonnet-4-6', malformedUsage);
    const summary = await tokenCost.get_usage_summary();

    expect(cost).toMatchObject({
      new_prompt_tokens: 10,
      new_prompt_cost: 0,
      prompt_read_cached_tokens: 10,
      completion_tokens: 0,
      completion_cost: 0,
    });
    expect(cost?.prompt_read_cached_cost).toBeCloseTo(0.000003);
    expect(cost?.prompt_cache_creation_cost).toBeNull();
    expect(summary.total_tokens).toBe(10);
    expect(summary.total_cost).toBeCloseTo(0.000003);
    expect(Number.isFinite(summary.total_cost)).toBe(true);

    (tokenCost as any).pricingData = {
      'malformed-model': {
        input_cost_per_token: -1,
        output_cost_per_token: Number.POSITIVE_INFINITY,
        cache_read_input_token_cost: Number.NaN,
        cache_creation_input_token_cost: -1,
        cache_creation_1h_input_token_cost: Number.POSITIVE_INFINITY,
        max_tokens: null,
        max_input_tokens: null,
        max_output_tokens: null,
      },
    };
    const malformedPricingCost = await tokenCost.calculateCost(
      'malformed-model',
      {
        prompt_tokens: 10,
        prompt_cached_tokens: 2,
        prompt_cache_creation_tokens: 2,
        prompt_image_tokens: null,
        completion_tokens: 4,
        total_tokens: 14,
      }
    );
    expect(malformedPricingCost?.new_prompt_cost).toBe(0);
    expect(malformedPricingCost?.prompt_read_cached_cost).toBeNull();
    expect(malformedPricingCost?.prompt_cache_creation_cost).toBeNull();
    expect(malformedPricingCost?.completion_cost).toBe(0);
  });

  it('prices provider-prefixed gateway Claude ids without a metadata fetch', async () => {
    const tokenCost = new TokenCost(true);
    const pricing = await tokenCost.getModelPricing(
      'anthropic/claude-sonnet-4-6'
    );

    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(pricing?.input_cost_per_token).toBeCloseTo(3 / 1_000_000);
    expect(pricing?.output_cost_per_token).toBeCloseTo(15 / 1_000_000);
    expect(pricing?.cache_creation_1h_input_token_cost).toBeCloseTo(
      6 / 1_000_000
    );
  });

  it('maps gemini-flash-latest to the LiteLLM namespaced key', async () => {
    const tokenCost = new TokenCost(false);
    (tokenCost as any).pricingData = {
      'gemini/gemini-flash-latest': {
        input_cost_per_token: 1.23e-7,
        output_cost_per_token: 4.56e-7,
        cache_read_input_token_cost: 7.89e-8,
        cache_creation_input_token_cost: null,
        max_tokens: 123456,
        max_input_tokens: 65536,
        max_output_tokens: 8192,
      },
    };

    const pricing = await tokenCost.getModelPricing('gemini-flash-latest');

    expect(pricing).not.toBeNull();
    expect(pricing?.model).toBe('gemini-flash-latest');
    expect(pricing?.max_input_tokens).toBe(65536);
    expect(pricing?.input_cost_per_token).toBeCloseTo(1.23e-7);
    expect(pricing?.output_cost_per_token).toBeCloseTo(4.56e-7);
  });

  it('loads explicit OpenRouter pricing without waiting for LiteLLM metadata', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            pricing: {
              prompt: '0.0000008',
              completion: '0.000004',
              input_cache_read: '0.00000008',
              input_cache_write: '0.000001',
            },
            context_length: 200000,
            top_provider: { max_completion_tokens: 8192 },
          },
        ],
      },
    });

    const tokenCost = new TokenCost(false);
    const pricing = await tokenCost.getModelPricing(
      'openrouter/anthropic/claude-sonnet-4'
    );

    expect(mockedAxiosGet).toHaveBeenCalledWith(OPENROUTER_MODELS_URL, {
      timeout: 30_000,
      maxContentLength: MAX_PRICING_METADATA_BYTES,
      maxBodyLength: MAX_PRICING_METADATA_BYTES,
      maxRedirects: 0,
    });
    expect(pricing).not.toBeNull();
    expect(pricing?.model).toBe('openrouter/anthropic/claude-sonnet-4');
    expect(pricing?.input_cost_per_token).toBeCloseTo(0.0000008);
    expect(pricing?.output_cost_per_token).toBeCloseTo(0.000004);
    expect(pricing?.cache_read_input_token_cost).toBeCloseTo(0.00000008);
    expect(pricing?.cache_creation_input_token_cost).toBeCloseTo(0.000001);
    expect(pricing?.cache_creation_1h_input_token_cost).toBeNull();
    expect(pricing?.max_input_tokens).toBe(200000);
    expect(pricing?.max_output_tokens).toBe(8192);
  });

  it('rejects oversized local pricing caches before reading them', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pricing-'));
    const cachePath = path.join(tempDir, 'pricing.json');
    fs.writeFileSync(cachePath, '{}');
    fs.truncateSync(cachePath, MAX_PRICING_METADATA_BYTES + 1);

    try {
      const tokenCost = new TokenCost(true);
      await expect((tokenCost as any).loadFromCache(cachePath)).rejects.toThrow(
        `exceeds ${MAX_PRICING_METADATA_BYTES} bytes`
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds LiteLLM pricing downloads and disables redirects', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pricing-'));
    mockedAxiosGet.mockResolvedValueOnce({ data: {} });

    try {
      const tokenCost = new TokenCost(true);
      (tokenCost as any).cacheDir = tempDir;
      await tokenCost.initialize();

      expect(mockedAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('model_prices_and_context_window.json'),
        {
          timeout: 30_000,
          maxContentLength: MAX_PRICING_METADATA_BYTES,
          maxBodyLength: MAX_PRICING_METADATA_BYTES,
          maxRedirects: 0,
        }
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to OpenRouter pricing for slash model ids missing from LiteLLM', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'deepseek/deepseek-chat-v3-0324',
            pricing: {
              prompt: '0.00000027',
              completion: '0.0000011',
            },
            context_length: '163840',
          },
        ],
      },
    });

    const tokenCost = new TokenCost(false);
    (tokenCost as any).pricingData = {};
    const pricing = await tokenCost.getModelPricing(
      'deepseek/deepseek-chat-v3-0324'
    );

    expect(pricing).not.toBeNull();
    expect(pricing?.model).toBe('deepseek/deepseek-chat-v3-0324');
    expect(pricing?.input_cost_per_token).toBeCloseTo(0.00000027);
    expect(pricing?.output_cost_per_token).toBeCloseTo(0.0000011);
    expect(pricing?.max_tokens).toBe(163840);
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
  });
});
