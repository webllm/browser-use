export const MAX_MAIN_PAGE_HTML_CHARS = 4 * 1024 * 1024;
export const MAX_IFRAME_HTML_CHARS = 512 * 1024;
export const MAX_COMBINED_PAGE_HTML_CHARS = 8 * 1024 * 1024;
export const MAX_EXTRACTED_IFRAMES = 20;
export const MAX_PAGE_HTML_SELECTOR_CHARS = 2_048;

const MAX_SERIALIZED_NODES = 100_000;
const MAX_SERIALIZATION_DEPTH = 512;
const MAX_ATTRIBUTES_PER_ELEMENT = 64;
const MAX_ATTRIBUTE_VALUE_CHARS = 4_096;
const ESCAPE_CHUNK_CHARS = 16 * 1024;

export type BoundedPageHtml = {
  html: string;
  truncated: boolean;
  visitedNodes: number;
  sourceUrl: string;
  rootFound: boolean;
};

export type BoundedPageHtmlOptions = {
  selector?: string | null;
};

type PageContentSource = {
  evaluate?: (...args: any[]) => Promise<unknown>;
  content?: () => Promise<unknown>;
};

export const extractBoundedPageHtml = async (
  source: PageContentSource,
  maxChars: number,
  options: BoundedPageHtmlOptions = {}
): Promise<BoundedPageHtml> => {
  const boundedMaxChars = Number.isFinite(maxChars)
    ? Math.min(MAX_MAIN_PAGE_HTML_CHARS, Math.max(0, Math.floor(maxChars)))
    : MAX_MAIN_PAGE_HTML_CHARS;
  const selector =
    options.selector?.trim().slice(0, MAX_PAGE_HTML_SELECTOR_CHARS) || null;
  if (typeof source.evaluate === 'function') {
    const rawResult = await source.evaluate(
      ({
        maxOutputChars,
        maxNodes,
        maxDepth,
        maxAttributes,
        maxAttributeValueChars,
        escapeChunkChars,
        rootSelector,
      }: {
        maxOutputChars: number;
        maxNodes: number;
        maxDepth: number;
        maxAttributes: number;
        maxAttributeValueChars: number;
        escapeChunkChars: number;
        rootSelector: string | null;
      }) => {
        const output: string[] = [];
        let remainingChars = maxOutputChars;
        let visitedNodes = 0;
        let truncated = false;
        const skippedTags = new Set([
          'script',
          'style',
          'noscript',
          'template',
        ]);
        const voidTags = new Set([
          'area',
          'base',
          'br',
          'col',
          'embed',
          'hr',
          'img',
          'input',
          'link',
          'meta',
          'param',
          'source',
          'track',
          'wbr',
        ]);

        // Array destructuring prevents esbuild's keepNames transform from
        // introducing a free `__name` helper into this serialized callback.
        const [append] = [
          (value: string) => {
            if (!value || remainingChars <= 0) {
              if (value) truncated = true;
              return;
            }
            const bounded = value.slice(0, remainingChars);
            output.push(bounded);
            remainingChars -= bounded.length;
            if (bounded.length < value.length) truncated = true;
          },
        ];
        const [appendEscaped] = [
          (
            value: string,
            attribute: boolean,
            rawLimit = Number.POSITIVE_INFINITY
          ) => {
            const limit = Math.min(value.length, rawLimit);
            let offset = 0;
            while (offset < limit && remainingChars > 0) {
              const chunk = value.slice(
                offset,
                Math.min(limit, offset + escapeChunkChars)
              );
              const escaped = attribute
                ? chunk
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                : chunk
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
              append(escaped);
              offset += chunk.length;
            }
            if (offset < value.length) truncated = true;
          },
        ];

        const [visit] = [
          (node: Node, depth: number): void => {
            if (remainingChars <= 0 || visitedNodes >= maxNodes) {
              truncated = true;
              return;
            }
            visitedNodes += 1;

            if (node.nodeType === Node.TEXT_NODE) {
              appendEscaped(node.nodeValue ?? '', false);
              return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            const element = node as Element;
            const tag = element.tagName.toLowerCase().slice(0, 128);
            if (!tag || skippedTags.has(tag)) return;
            append(`<${tag}`);
            const attributes = element.attributes;
            const attributeCount = Math.min(attributes.length, maxAttributes);
            for (let index = 0; index < attributeCount; index += 1) {
              if (remainingChars <= 0) break;
              const attributeNode = attributes.item(index);
              if (!attributeNode) continue;
              const name = attributeNode.name.slice(0, 256);
              if (!name) continue;
              append(` ${name}="`);
              appendEscaped(attributeNode.value, true, maxAttributeValueChars);
              append('"');
            }
            if (attributes.length > attributeCount) truncated = true;
            append('>');

            if (!voidTags.has(tag)) {
              if (depth >= maxDepth) {
                if (element.firstChild) truncated = true;
              } else {
                let child = element.firstChild;
                while (child && remainingChars > 0 && visitedNodes < maxNodes) {
                  visit(child, depth + 1);
                  child = child.nextSibling;
                }
                if (child) truncated = true;
              }
              append(`</${tag}>`);
            }
          },
        ];

        const root = rootSelector
          ? document.querySelector(rootSelector)
          : document.documentElement;
        if (root) visit(root, 0);
        return {
          html: output.join(''),
          truncated,
          visitedNodes,
          sourceUrl: window.location.href.slice(0, 16 * 1024),
          rootFound: Boolean(root),
        };
      },
      {
        maxOutputChars: boundedMaxChars,
        maxNodes: MAX_SERIALIZED_NODES,
        maxDepth: MAX_SERIALIZATION_DEPTH,
        maxAttributes: MAX_ATTRIBUTES_PER_ELEMENT,
        maxAttributeValueChars: MAX_ATTRIBUTE_VALUE_CHARS,
        escapeChunkChars: ESCAPE_CHUNK_CHARS,
        rootSelector: selector,
      }
    );

    if (!rawResult || typeof rawResult !== 'object') {
      throw new Error('Bounded page serialization returned an invalid result');
    }
    const result = rawResult as Record<string, unknown>;
    const rawHtml = typeof result.html === 'string' ? result.html : '';
    return {
      html: rawHtml.slice(0, boundedMaxChars),
      truncated: result.truncated === true || rawHtml.length > boundedMaxChars,
      visitedNodes:
        typeof result.visitedNodes === 'number' &&
        Number.isSafeInteger(result.visitedNodes)
          ? Math.max(0, result.visitedNodes)
          : 0,
      sourceUrl:
        typeof result.sourceUrl === 'string'
          ? result.sourceUrl.slice(0, 16 * 1024)
          : '',
      rootFound:
        result.rootFound === true ||
        (result.rootFound !== false && rawHtml.length > 0),
    };
  }

  if (typeof source.content === 'function') {
    if (selector) {
      return {
        html: '',
        truncated: false,
        visitedNodes: 0,
        sourceUrl:
          typeof (source as any).url === 'function'
            ? String((source as any).url() ?? '').slice(0, 16 * 1024)
            : '',
        rootFound: false,
      };
    }
    const rawHtml = await source.content();
    const html = typeof rawHtml === 'string' ? rawHtml : '';
    return {
      html: html.slice(0, boundedMaxChars),
      truncated: html.length > boundedMaxChars,
      visitedNodes: 0,
      sourceUrl:
        typeof (source as any).url === 'function'
          ? String((source as any).url() ?? '').slice(0, 16 * 1024)
          : '',
      rootFound: true,
    };
  }

  return {
    html: '',
    truncated: false,
    visitedNodes: 0,
    sourceUrl: '',
    rootFound: false,
  };
};
