import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystem } from '../src/filesystem/file-system.js';
import {
  parseInlineMarkdown,
  parseMarkdownForPdf,
  splitHeading,
} from '../src/filesystem/markdown-pdf.js';

const tempDirs: string[] = [];
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-md-pdf-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE = [
  '# Weekly report',
  '',
  'Revenue grew **12%** with *steady* demand in `eu-west`.',
  '- first item',
  '  - nested item',
  '```',
  'const total = a * b * c;',
  '```',
  '#hashtag stays text',
].join('\n');

describe('markdown to PDF rendering', () => {
  it('splits only real ATX headings', () => {
    expect(splitHeading('## Summary')).toEqual(['Summary', 2]);
    expect(splitHeading('#hashtag')).toEqual(['#hashtag', null]);
  });

  it('renders bold, italic, and code spans as separate font runs', () => {
    expect(
      parseInlineMarkdown('Revenue **grew** with *steady* use of `npm ci`.')
    ).toEqual([
      { text: 'Revenue ', font: 'Helvetica' },
      { text: 'grew', font: 'Helvetica-Bold' },
      { text: ' with ', font: 'Helvetica' },
      { text: 'steady', font: 'Helvetica-Oblique' },
      { text: ' use of ', font: 'Helvetica' },
      { text: 'npm ci', font: 'Courier' },
      { text: '.', font: 'Helvetica' },
    ]);
  });

  it('keeps arithmetic, globs, snake_case, and code markers literal', () => {
    for (const text of [
      '2 * 3 * 4',
      '*.txt and **/*.py',
      '**/foo/**',
      'snake_case_name',
    ]) {
      expect(parseInlineMarkdown(text)).toEqual([{ text, font: 'Helvetica' }]);
    }
    expect(parseInlineMarkdown('`**not bold**`')).toEqual([
      { text: '**not bold**', font: 'Courier' },
    ]);
  });

  it('parses headings, bullets, and fenced code blocks', () => {
    const blocks = parseMarkdownForPdf(SAMPLE);

    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      fontSize: 20,
      runs: [{ text: 'Weekly report', font: 'Helvetica-Bold' }],
    });
    expect(blocks[1]).toEqual({ kind: 'space' });
    expect(blocks[3]).toMatchObject({
      runs: [{ text: '• first item', font: 'Helvetica' }],
    });
    expect(blocks[4]).toMatchObject({
      runs: [{ text: '  • nested item', font: 'Helvetica' }],
    });
    expect(blocks[5]).toEqual({
      kind: 'paragraph',
      fontSize: 10,
      runs: [{ text: 'const total = a * b * c;', font: 'Courier' }],
    });
    expect(blocks[6]).toMatchObject({
      runs: [{ text: '#hashtag stays text', font: 'Helvetica' }],
    });
  });

  it('writes styled PDFs through the async and synchronous writers', async () => {
    const asyncDir = createTempDir();
    const fileSystem = new FileSystem(asyncDir);
    await fileSystem.write_file('report.pdf', SAMPLE);
    const asyncPdf = fs.readFileSync(
      path.join(fileSystem.get_dir(), 'report.pdf'),
      'latin1'
    );

    const syncDir = createTempDir();
    const restored = FileSystem.from_state_sync({
      base_dir: syncDir,
      extracted_content_count: 0,
      files: {
        'report.pdf': {
          type: 'PdfFile',
          data: { name: 'report', content: SAMPLE },
        },
      },
    });
    const syncPdf = fs.readFileSync(
      path.join(restored.get_dir(), 'report.pdf'),
      'latin1'
    );

    for (const pdf of [asyncPdf, syncPdf]) {
      expect(pdf.startsWith('%PDF')).toBe(true);
      expect(pdf).toContain('/BaseFont /Helvetica-Bold');
      expect(pdf).toContain('/BaseFont /Helvetica-Oblique');
      expect(pdf).toContain('/BaseFont /Courier');
    }
  });
});
