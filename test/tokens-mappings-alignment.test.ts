import { describe, expect, it } from 'vitest';
import { CUSTOM_MODEL_PRICING } from '../src/tokens/custom-pricing.js';
import { MODEL_TO_LITELLM } from '../src/tokens/mappings.js';

describe('tokens mappings alignment', () => {
  it('keeps browser-use custom pricing aliases aligned to bu-2-0', () => {
    expect(CUSTOM_MODEL_PRICING['bu-latest']).toBe(
      CUSTOM_MODEL_PRICING['bu-2-0']
    );
    expect(CUSTOM_MODEL_PRICING.smart).toBe(CUSTOM_MODEL_PRICING['bu-2-0']);
  });

  it('maps gemini-flash-latest to litellm provider-prefixed name', () => {
    expect(MODEL_TO_LITELLM['gemini-flash-latest']).toBe(
      'gemini/gemini-flash-latest'
    );
  });

  it('includes current Claude pricing and one-hour cache writes', () => {
    const fable = CUSTOM_MODEL_PRICING['claude-fable-5'];
    const anthropicFable = CUSTOM_MODEL_PRICING['anthropic/claude-fable-5'];

    expect(fable.input_cost_per_token).toBeCloseTo(10 / 1_000_000);
    expect(fable.cache_creation_input_token_cost).toBeCloseTo(12.5 / 1_000_000);
    expect(fable.cache_creation_1h_input_token_cost).toBeCloseTo(
      20 / 1_000_000
    );
    expect(anthropicFable.cache_creation_1h_input_token_cost).toBe(
      fable.cache_creation_1h_input_token_cost
    );
  });

  it('maps gateway Claude model ids to their canonical custom pricing', () => {
    expect(CUSTOM_MODEL_PRICING['anthropic/claude-sonnet-4-6']).toBe(
      CUSTOM_MODEL_PRICING['claude-sonnet-4-6']
    );
    expect(CUSTOM_MODEL_PRICING['anthropic/claude-opus-4-6']).toBe(
      CUSTOM_MODEL_PRICING['claude-opus-4-6']
    );
  });
});
