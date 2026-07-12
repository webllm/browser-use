export const MAX_DROPDOWN_OPTIONS = 500;
export const MAX_DROPDOWN_SCANNED_OPTIONS = 10_000;
export const MAX_DROPDOWN_FIELD_CHARS = 2_048;
export const MAX_DROPDOWN_PAYLOAD_CHARS = 64 * 1024;
export const MAX_DROPDOWN_MESSAGE_CHARS = 256 * 1024;

export type DropdownOptionSummary = {
  index: number;
  text: string;
  value: string;
};

export type NormalizedDropdownOptions = {
  options: DropdownOptionSummary[];
  truncated: boolean;
};

const primitiveText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return '';
};

export const normalizeDropdownOptions = (
  rawOptions: unknown,
  alreadyTruncated = false
): NormalizedDropdownOptions => {
  if (!Array.isArray(rawOptions)) {
    return { options: [], truncated: alreadyTruncated };
  }

  const options: DropdownOptionSummary[] = [];
  let remainingChars = MAX_DROPDOWN_PAYLOAD_CHARS;
  let truncated = alreadyTruncated || rawOptions.length > MAX_DROPDOWN_OPTIONS;
  const count = Math.min(rawOptions.length, MAX_DROPDOWN_OPTIONS);

  for (let index = 0; index < count; index += 1) {
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    const raw = rawOptions[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const rawText = primitiveText(record.text);
    const rawValue = primitiveText(record.value);
    const take = (value: string) => {
      const limit = Math.max(
        0,
        Math.min(MAX_DROPDOWN_FIELD_CHARS, remainingChars)
      );
      const bounded = value.slice(0, limit);
      remainingChars -= bounded.length;
      if (bounded.length < value.length) truncated = true;
      return bounded;
    };
    const text = take(rawText);
    const value = take(rawValue);
    if (!text && !value) continue;
    options.push({
      index:
        typeof record.index === 'number' && Number.isSafeInteger(record.index)
          ? record.index
          : index,
      text,
      value,
    });
  }

  return { options, truncated };
};

export const formatDropdownOptions = (
  options: DropdownOptionSummary[],
  truncated = false
): { text: string; truncated: boolean } => {
  const lines: string[] = [];
  let remainingChars = MAX_DROPDOWN_MESSAGE_CHARS;
  let outputTruncated = truncated;
  for (const option of options.slice(0, MAX_DROPDOWN_OPTIONS)) {
    const line = `${option.index}: text=${JSON.stringify(option.text)}, value=${JSON.stringify(option.value)}`;
    if (line.length + 1 > remainingChars) {
      outputTruncated = true;
      break;
    }
    lines.push(line);
    remainingChars -= line.length + 1;
  }
  if (options.length > MAX_DROPDOWN_OPTIONS) outputTruncated = true;
  if (outputTruncated) {
    const notice =
      '... additional dropdown options or text were truncated for safety.';
    while (lines.length > 0 && notice.length + 1 > remainingChars) {
      const removed = lines.pop() ?? '';
      remainingChars += removed.length + 1;
    }
    lines.push(notice);
  }
  return { text: lines.join('\n'), truncated: outputTruncated };
};

export const serializeDropdownOptions = (
  options: DropdownOptionSummary[]
): { json: string; truncated: boolean } => {
  const parts: string[] = [];
  let length = 2;
  let truncated = false;
  for (const option of options.slice(0, MAX_DROPDOWN_OPTIONS)) {
    const part = JSON.stringify(option);
    const addedLength = part.length + (parts.length > 0 ? 1 : 0);
    if (length + addedLength > MAX_DROPDOWN_MESSAGE_CHARS) {
      truncated = true;
      break;
    }
    parts.push(part);
    length += addedLength;
  }
  if (options.length > parts.length) truncated = true;
  return { json: `[${parts.join(',')}]`, truncated };
};

export const boundDropdownMessage = (value: unknown): string => {
  return primitiveText(value).slice(0, MAX_DROPDOWN_MESSAGE_CHARS);
};
