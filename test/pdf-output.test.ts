import { describe, expect, it, vi } from 'vitest';
import { readBoundedCdpPdf } from '../src/controller/pdf-output.js';

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
});
