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
