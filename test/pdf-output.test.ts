import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SAVED_PDF_BYTES,
  readBoundedCdpPdf,
} from '../src/browser/pdf-output.js';

describe('bounded CDP PDF output', () => {
  it('reads and closes a CDP stream in bounded chunks', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        data: Buffer.from('%PDF-').toString('base64'),
        base64Encoded: true,
        eof: false,
      })
      .mockResolvedValueOnce({
        data: Buffer.from('1.4').toString('base64'),
        base64Encoded: true,
        eof: true,
      })
      .mockResolvedValueOnce({});

    const result = await readBoundedCdpPdf(
      { send },
      { stream: 'pdf-stream' },
      100
    );

    expect(result.toString()).toBe('%PDF-1.4');
    expect(send).toHaveBeenLastCalledWith('IO.close', {
      handle: 'pdf-stream',
    });
  });

  it('rejects and closes an oversized CDP stream', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        data: Buffer.from('too large').toString('base64'),
        base64Encoded: true,
        eof: true,
      })
      .mockResolvedValueOnce({});

    await expect(
      readBoundedCdpPdf({ send }, { stream: 'pdf-stream' }, 4)
    ).rejects.toThrow('maximum size');
    expect(send).toHaveBeenLastCalledWith('IO.close', {
      handle: 'pdf-stream',
    });
  });

  it('bounds legacy inline PDF responses', async () => {
    const send = vi.fn();
    await expect(
      readBoundedCdpPdf(
        { send },
        { data: Buffer.from('too large').toString('base64') },
        4
      )
    ).rejects.toThrow('maximum size');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'uses the safe default for invalid byte limit %s',
    async (invalidLimit) => {
      const send = vi.fn();
      const byteLength = vi
        .spyOn(Buffer, 'byteLength')
        .mockReturnValue(MAX_SAVED_PDF_BYTES + 1);
      try {
        await expect(
          readBoundedCdpPdf(
            { send },
            { data: Buffer.from('pdf').toString('base64') },
            invalidLimit
          )
        ).rejects.toThrow('maximum size');
      } finally {
        byteLength.mockRestore();
      }
    }
  );

  it.each([MAX_SAVED_PDF_BYTES + 1, Number.MAX_SAFE_INTEGER])(
    'enforces the hard byte limit for oversized budget %s',
    async (limit) => {
      const send = vi.fn();
      const byteLength = vi
        .spyOn(Buffer, 'byteLength')
        .mockReturnValue(MAX_SAVED_PDF_BYTES + 1);
      try {
        await expect(
          readBoundedCdpPdf(
            { send },
            { data: Buffer.from('pdf').toString('base64') },
            limit
          )
        ).rejects.toThrow('maximum size');
      } finally {
        byteLength.mockRestore();
      }
    }
  );
});
