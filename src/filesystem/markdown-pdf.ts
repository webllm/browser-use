/**
 * Render a small markdown subset into pdfkit documents: ATX headings, bullet
 * lists, fenced code blocks, and inline bold, italic, and code spans.
 *
 * Parsing happens here; rendering is a self-contained function so the
 * synchronous writer can run it inside a child process.
 */

export type PdfFont =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Courier';

export interface PdfRun {
  text: string;
  font: PdfFont;
}

export type PdfBlock =
  | { kind: 'space' }
  | { kind: 'paragraph'; fontSize: number; runs: PdfRun[] };

const HEADING_FONT_SIZES: Record<number, number> = { 1: 20, 2: 16, 3: 14 };
const BODY_FONT_SIZE = 12;
const CODE_FONT_SIZE = 10;
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
// Bold content cannot start with "/" so globs like **/foo/** stay literal, and
// emphasis needs non-space boundaries so "2 * 3 * 4" stays literal. Underscore
// emphasis is intentionally unsupported so snake_case identifiers survive.
const EMPHASIS_RE =
  /\*\*([^\s*/](?:[^*]*[^\s*])?)\*\*|(?<!\*)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g;

const boldFont = (font: PdfFont): PdfFont =>
  font === 'Helvetica-Oblique' ? 'Helvetica-BoldOblique' : 'Helvetica-Bold';

const italicFont = (font: PdfFont): PdfFont =>
  font === 'Helvetica-Bold' ? 'Helvetica-BoldOblique' : 'Helvetica-Oblique';

/**
 * Split a markdown ATX heading into its text and level. Only `# `, `## `, and
 * `### ` (with the required space) are headings; `#hashtag` is plain text.
 */
export const splitHeading = (line: string): [string, number | null] => {
  if (line.startsWith('### ')) return [line.slice(4), 3];
  if (line.startsWith('## ')) return [line.slice(3), 2];
  if (line.startsWith('# ')) return [line.slice(2), 1];
  return [line, null];
};

const pushRun = (runs: PdfRun[], text: string, font: PdfFont) => {
  if (!text) return;
  const previous = runs[runs.length - 1];
  if (previous && previous.font === font) {
    previous.text += text;
  } else {
    runs.push({ text, font });
  }
};

export const parseInlineMarkdown = (
  text: string,
  baseFont: PdfFont = 'Helvetica'
): PdfRun[] => {
  const runs: PdfRun[] = [];
  // Code spans are handled first so emphasis markers inside them stay literal.
  for (const part of text.split(/(`[^`]+`)/)) {
    if (!part) continue;
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      pushRun(runs, part.slice(1, -1), 'Courier');
      continue;
    }
    let lastIndex = 0;
    for (const match of part.matchAll(EMPHASIS_RE)) {
      const index = match.index ?? 0;
      pushRun(runs, part.slice(lastIndex, index), baseFont);
      if (match[1] !== undefined) {
        pushRun(runs, match[1], boldFont(baseFont));
      } else {
        pushRun(runs, match[2] ?? '', italicFont(baseFont));
      }
      lastIndex = index + match[0].length;
    }
    pushRun(runs, part.slice(lastIndex), baseFont);
  }
  return runs;
};

export const parseMarkdownForPdf = (content: string): PdfBlock[] => {
  const blocks: PdfBlock[] = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!stripped) {
      blocks.push({ kind: 'space' });
      continue;
    }
    if (inFence) {
      // Fenced blocks are literal: no emphasis or inline-code conversion.
      blocks.push({
        kind: 'paragraph',
        fontSize: CODE_FONT_SIZE,
        runs: [{ text: line, font: 'Courier' }],
      });
      continue;
    }

    const [headingText, level] = splitHeading(line);
    if (level !== null) {
      blocks.push({
        kind: 'paragraph',
        fontSize: HEADING_FONT_SIZES[level] ?? BODY_FONT_SIZE,
        runs: parseInlineMarkdown(headingText, 'Helvetica-Bold'),
      });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const nesting = '  '.repeat(
        Math.min(Math.floor(bullet[1]!.length / 2), 6)
      );
      const runs: PdfRun[] = [];
      pushRun(runs, `${nesting}• `, 'Helvetica');
      for (const run of parseInlineMarkdown(bullet[2] ?? '')) {
        pushRun(runs, run.text, run.font);
      }
      blocks.push({ kind: 'paragraph', fontSize: BODY_FONT_SIZE, runs });
      continue;
    }

    blocks.push({
      kind: 'paragraph',
      fontSize: BODY_FONT_SIZE,
      runs: parseInlineMarkdown(line),
    });
  }
  return blocks;
};

/**
 * Draw parsed blocks into a pdfkit document. This function must stay
 * self-contained: the synchronous writer serializes it into a child process.
 */
export function renderPdfBlocks(doc: any, blocks: PdfBlock[]) {
  for (const block of blocks) {
    if (block.kind === 'space') {
      doc.moveDown(0.5);
      continue;
    }
    const runs =
      block.runs.length > 0 ? block.runs : [{ text: '', font: 'Helvetica' }];
    runs.forEach((run, index) => {
      doc
        .font(run.font)
        .fontSize(block.fontSize)
        .text(run.text, { width: 500, continued: index < runs.length - 1 });
    });
  }
}
