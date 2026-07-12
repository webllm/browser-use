import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

let mockedPdfPages: string[] = [];
vi.mock('pdf-parse', () => {
  class PDFParse {
    constructor(_options: { data: Buffer }) {}

    async getInfo() {
      return { total: Math.max(1, mockedPdfPages.length) };
    }

    async getText(options?: { partial?: number[] }) {
      const partial = options?.partial;
      if (Array.isArray(partial) && partial.length > 0) {
        const pageNumber = partial[0] ?? 1;
        return { text: mockedPdfPages[pageNumber - 1] ?? '' };
      }
      return { text: mockedPdfPages.join('\n\n') };
    }

    async destroy() {}
  }

  return { PDFParse };
});

import { FileSystem } from '../src/filesystem/file-system.js';

describe('FileSystem PDF external read alignment', () => {
  it('returns full page-tagged content when PDF fits budget', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-fs-pdf-')
    );
    const fileSystem = new FileSystem(tempDir, false);
    const pdfPath = path.join(tempDir, 'small.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf');
    mockedPdfPages = ['Executive summary', 'Revenue increased by 12%'];

    try {
      const result = await fileSystem.read_file_structured(pdfPath, true);
      expect(result.message).toContain(`Read from file ${pdfPath} (2 pages,`);
      expect(result.message).toContain('--- Page 1 ---');
      expect(result.message).toContain('Executive summary');
      expect(result.message).toContain('--- Page 2 ---');
      expect(result.message).toContain('Revenue increased by 12%');
      expect(result.message).not.toContain(
        'Use extract with start_from_char to read further into the file.'
      );
    } finally {
      mockedPdfPages = [];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses relevance-prioritized truncation for oversized PDFs', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-fs-pdf-')
    );
    const fileSystem = new FileSystem(tempDir, false);
    const pdfPath = path.join(tempDir, 'large.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf');
    mockedPdfPages = [
      'overview market context '.repeat(1600),
      'revenue growth forecast margin guidance '.repeat(1800),
      'appendix legal disclaimer notes '.repeat(1800),
    ];

    try {
      const result = await fileSystem.read_file_structured(pdfPath, true);
      expect(result.message).toContain(`Read from file ${pdfPath} (3 pages,`);
      expect(result.message).toContain('--- Page 1 ---');
      expect(result.message).toContain('[Showing');
      expect(result.message).toContain('Skipped pages:');
      expect(result.message).toContain(
        'Use extract with start_from_char to read further into the file.'
      );
      expect(result.message).toContain('[...truncated]');
    } finally {
      mockedPdfPages = [];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('caps the number of PDF pages parsed from untrusted files', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-fs-pdf-')
    );
    const fileSystem = new FileSystem(tempDir, false);
    const pdfPath = path.join(tempDir, 'many-pages.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf');
    mockedPdfPages = Array.from(
      { length: 250 },
      (_, index) => `Page ${index + 1}`
    );

    try {
      const result = await fileSystem.read_file_structured(pdfPath, true);
      expect(result.message).toContain('Showing 200 of 250 pages');
      expect(result.message).toContain('Skipped pages: [201, 202');
    } finally {
      mockedPdfPages = [];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
