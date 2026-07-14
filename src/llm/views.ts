export interface ChatInvokeUsage {
  prompt_tokens: number;
  prompt_cached_tokens?: number | null;
  prompt_cache_creation_tokens?: number | null;
  prompt_cache_creation_5m_tokens?: number | null;
  prompt_cache_creation_1h_tokens?: number | null;
  prompt_image_tokens?: number | null;
  completion_tokens: number;
  total_tokens: number;
  pricing_multiplier?: number | null;
}

const parseTokenCount = (value: unknown, fallback: number | null) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const parsePricingMultiplier = (value: unknown) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const normalizeChatInvokeUsage = (
  usage: Partial<ChatInvokeUsage> | null | undefined
): ChatInvokeUsage => {
  const promptTokens = parseTokenCount(usage?.prompt_tokens, 0) ?? 0;
  const cachedTokens = parseTokenCount(usage?.prompt_cached_tokens, null);

  return {
    prompt_tokens: promptTokens,
    prompt_cached_tokens:
      cachedTokens == null ? null : Math.min(cachedTokens, promptTokens),
    prompt_cache_creation_tokens: parseTokenCount(
      usage?.prompt_cache_creation_tokens,
      null
    ),
    prompt_cache_creation_5m_tokens: parseTokenCount(
      usage?.prompt_cache_creation_5m_tokens,
      null
    ),
    prompt_cache_creation_1h_tokens: parseTokenCount(
      usage?.prompt_cache_creation_1h_tokens,
      null
    ),
    prompt_image_tokens: parseTokenCount(usage?.prompt_image_tokens, null),
    completion_tokens: parseTokenCount(usage?.completion_tokens, 0) ?? 0,
    total_tokens: parseTokenCount(usage?.total_tokens, 0) ?? 0,
    pricing_multiplier: parsePricingMultiplier(usage?.pricing_multiplier),
  };
};

export class ChatInvokeCompletion<T = string> {
  constructor(
    public completion: T,
    public usage: ChatInvokeUsage | null = null,
    public thinking: string | null = null,
    public redacted_thinking: string | null = null,
    public stop_reason: string | null = null,
    public stop_details: Record<string, unknown> | null = null
  ) {}
}
