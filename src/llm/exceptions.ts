export class ModelError extends Error {}

export class ModelProviderError extends ModelError {
  constructor(
    message: string,
    public statusCode = 502,
    public model: string | null = null
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export class ModelRateLimitError extends ModelProviderError {
  constructor(message: string, statusCode = 429, model: string | null = null) {
    super(message, statusCode, model);
    this.name = 'ModelRateLimitError';
  }
}

export class ModelOutputTruncatedError extends ModelProviderError {
  constructor(message: string, model: string | null = null) {
    // A truncation is not retryable on the same provider, but Agent may switch
    // to a fallback model with a larger output-token budget.
    super(message, 400, model);
    this.name = 'ModelOutputTruncatedError';
  }
}

export interface OutputTruncationDetails {
  model?: string | null;
  tokenLimit?: number | null;
  tokenLimitName?: string;
}

const OUTPUT_TRUNCATION_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
]);

export const isOutputTruncationReason = (reason: unknown): boolean => {
  const normalized = String(reason ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return OUTPUT_TRUNCATION_REASONS.has(normalized);
};

export const raiseIfOutputTruncated = (
  reason: unknown,
  details: OutputTruncationDetails = {}
): void => {
  if (!isOutputTruncationReason(reason)) {
    return;
  }

  const limit =
    details.tokenLimit == null
      ? "the model's output token limit"
      : `${details.tokenLimitName ?? 'max_tokens'}=${details.tokenLimit}`;
  throw new ModelOutputTruncatedError(
    `Model output was truncated at ${limit}; the structured output is incomplete. ` +
      'Increase the output-token limit or request shorter output.',
    details.model ?? null
  );
};
