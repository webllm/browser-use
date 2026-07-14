export const MAX_LLM_RETRIES = 100;

export const validateMaxRetries = (value: number, minimum = 0): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAX_LLM_RETRIES
  ) {
    throw new RangeError(
      `maxRetries must be an integer between ${minimum} and ${MAX_LLM_RETRIES}.`
    );
  }
  return value;
};
