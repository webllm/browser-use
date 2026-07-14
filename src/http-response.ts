export const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

export class HttpResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(
      `HTTP response exceeds maximum size of ${maxBytes.toLocaleString()} bytes`
    );
    this.name = 'HttpResponseTooLargeError';
  }
}

type ResponseLike = {
  headers?: { get?: (name: string) => string | null } | null;
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

const assertContentLength = (response: ResponseLike, maxBytes: number) => {
  const raw = response.headers?.get?.('content-length');
  if (!raw) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new HttpResponseTooLargeError(maxBytes);
  }
};

const assertTextSize = (text: string, maxBytes: number) => {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new HttpResponseTooLargeError(maxBytes);
  }
};

const normalizeResponseLimit = (maxBytes: number) =>
  Number.isFinite(maxBytes)
    ? Math.max(1, Math.floor(maxBytes))
    : DEFAULT_MAX_HTTP_RESPONSE_BYTES;

export const readBoundedResponseText = async (
  response: ResponseLike,
  maxBytes = DEFAULT_MAX_HTTP_RESPONSE_BYTES
): Promise<string> => {
  const boundedMaxBytes = normalizeResponseLimit(maxBytes);
  assertContentLength(response, boundedMaxBytes);

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > boundedMaxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpResponseTooLargeError(boundedMaxBytes);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }

  if (typeof response.text !== 'function') {
    throw new Error('HTTP response does not expose a readable body');
  }
  const text = await response.text();
  assertTextSize(text, boundedMaxBytes);
  return text;
};

export const readBoundedResponseJson = async (
  response: ResponseLike,
  maxBytes = DEFAULT_MAX_HTTP_RESPONSE_BYTES
): Promise<unknown> => {
  if (response.body?.getReader || typeof response.text === 'function') {
    const text = await readBoundedResponseText(response, maxBytes);
    return text ? JSON.parse(text) : null;
  }

  // Compatibility path for lightweight test/custom fetch adapters. Native
  // fetch responses take the streaming path above.
  if (typeof response.json !== 'function') {
    throw new Error('HTTP response does not expose a readable JSON body');
  }
  const payload = await response.json();
  const rendered = JSON.stringify(payload);
  assertTextSize(rendered ?? 'null', normalizeResponseLimit(maxBytes));
  return payload;
};
