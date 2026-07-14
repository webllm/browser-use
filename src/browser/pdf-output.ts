export const MAX_SAVED_PDF_BYTES = 50 * 1024 * 1024;
export const PDF_STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_PDF_STREAM_READS = 1024;

type CdpSessionLike = {
  send: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
};

const pdfTooLargeError = (maxBytes: number) =>
  new Error(
    `Generated PDF exceeds maximum size of ${maxBytes.toLocaleString()} bytes`
  );

const decodeBoundedChunk = (
  data: string,
  base64Encoded: boolean,
  remainingBytes: number,
  maxBytes: number
) => {
  const byteLength = Buffer.byteLength(data, base64Encoded ? 'base64' : 'utf8');
  if (byteLength > remainingBytes) {
    throw pdfTooLargeError(maxBytes);
  }
  return Buffer.from(data, base64Encoded ? 'base64' : 'utf8');
};

export const readBoundedCdpPdf = async (
  cdpSession: CdpSessionLike,
  result: Record<string, unknown>,
  maxBytes = MAX_SAVED_PDF_BYTES
): Promise<Buffer> => {
  const boundedMaxBytes = Number.isFinite(maxBytes)
    ? Math.min(MAX_SAVED_PDF_BYTES, Math.max(1, Math.floor(maxBytes)))
    : MAX_SAVED_PDF_BYTES;
  const stream = typeof result.stream === 'string' ? result.stream : '';
  if (!stream) {
    const data = typeof result.data === 'string' ? result.data : '';
    if (!data) {
      throw new Error('CDP Page.printToPDF returned no data or stream.');
    }
    return decodeBoundedChunk(data, true, boundedMaxBytes, boundedMaxBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let reads = 0;
  try {
    while (reads < MAX_PDF_STREAM_READS) {
      reads += 1;
      const entry = await cdpSession.send('IO.read', {
        handle: stream,
        size: PDF_STREAM_CHUNK_BYTES,
      });
      const data = typeof entry.data === 'string' ? entry.data : '';
      const eof = entry.eof === true;
      if (data) {
        const chunk = decodeBoundedChunk(
          data,
          entry.base64Encoded !== false,
          boundedMaxBytes - totalBytes,
          boundedMaxBytes
        );
        chunks.push(chunk);
        totalBytes += chunk.length;
      } else if (!eof) {
        throw new Error('CDP PDF stream stalled before reaching EOF.');
      }
      if (eof) {
        return Buffer.concat(chunks, totalBytes);
      }
    }
    throw new Error('CDP PDF stream exceeded the maximum read count.');
  } finally {
    try {
      await cdpSession.send('IO.close', { handle: stream });
    } catch {
      // Closing is best-effort and must not mask a size/read failure.
    }
  }
};
