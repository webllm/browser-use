export const MAX_SCROLL_TEXT_QUERY_CHARS = 1_000;
export const MAX_SCROLL_TEXT_NODES = 100_000;
export const MAX_SCROLL_TEXT_CHARS = 2 * 1024 * 1024;
const SCROLL_TEXT_CHUNK_CHARS = 64 * 1024;

export type ScrollToTextPageResult = {
  found: boolean;
  truncated: boolean;
  visitedNodes: number;
  scannedChars: number;
};

const scriptSafeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export const buildScrollToTextExpression = (
  text: string,
  direction: 'up' | 'down'
): string => {
  const payload = scriptSafeJson({
    text: String(text).slice(0, MAX_SCROLL_TEXT_QUERY_CHARS),
    direction,
    maxNodes: MAX_SCROLL_TEXT_NODES,
    maxChars: MAX_SCROLL_TEXT_CHARS,
    chunkChars: SCROLL_TEXT_CHUNK_CHARS,
  });

  return `(() => {
    const payload = ${payload};
    const query = payload.text.toLowerCase();
    if (!query || !document.body) {
      return { found: false, truncated: false, visitedNodes: 0, scannedChars: 0 };
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const skippedTags = new Set(['script', 'style', 'noscript', 'template']);
    const carryLength = Math.max(0, query.length - 1);
    let carry = '';
    let visitedNodes = 0;
    let scannedChars = 0;
    let node = walker.nextNode();
    while (node && visitedNodes < payload.maxNodes && scannedChars < payload.maxChars) {
      visitedNodes += 1;
      const parent = node.parentElement;
      const parentTag = parent?.tagName?.toLowerCase() ?? '';
      if (parent && !skippedTags.has(parentTag)) {
        const value = node.nodeValue ?? '';
        let offset = 0;
        while (offset < value.length && scannedChars < payload.maxChars) {
          const remaining = payload.maxChars - scannedChars;
          const chunk = value.slice(offset, offset + Math.min(payload.chunkChars, remaining));
          const searchable = carry + chunk.toLowerCase();
          if (searchable.includes(query)) {
            parent.scrollIntoView({
              behavior: 'smooth',
              block: payload.direction === 'up' ? 'start' : 'center',
            });
            return { found: true, truncated: false, visitedNodes, scannedChars: scannedChars + chunk.length };
          }
          carry = carryLength > 0 ? searchable.slice(-carryLength) : '';
          offset += chunk.length;
          scannedChars += chunk.length;
        }
        if (offset < value.length) {
          return { found: false, truncated: true, visitedNodes, scannedChars };
        }
      }
      node = walker.nextNode();
    }
    return {
      found: false,
      truncated: Boolean(node),
      visitedNodes,
      scannedChars,
    };
  })()`;
};
