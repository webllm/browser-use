export const MAX_CLI_ELEMENT_TEXT_CHARS = 256 * 1024;
export const MAX_CLI_ELEMENT_VALUE_CHARS = 64 * 1024;
export const MAX_CLI_ELEMENT_ATTRIBUTES = 64;
export const MAX_CLI_ATTRIBUTE_NAME_CHARS = 256;
export const MAX_CLI_ATTRIBUTE_VALUE_CHARS = 4 * 1024;
export const MAX_CLI_ELEMENT_TEXT_NODES = 50_000;

type PageEvaluator = {
  evaluate: (...args: any[]) => Promise<unknown>;
};

export const readBoundedCliElementData = async (
  page: PageEvaluator,
  xpath: string,
  kind: 'text' | 'value' | 'attributes' | 'bbox'
) =>
  await page.evaluate(
    ({
      elementXPath,
      dataKind,
      maxTextChars,
      maxValueChars,
      maxAttributes,
      maxAttributeNameChars,
      maxAttributeValueChars,
      maxTextNodes,
    }: {
      elementXPath: string;
      dataKind: string;
      maxTextChars: number;
      maxValueChars: number;
      maxAttributes: number;
      maxAttributeNameChars: number;
      maxAttributeValueChars: number;
      maxTextNodes: number;
    }) => {
      const element = document.evaluate(
        elementXPath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue as HTMLElement | null;
      if (!element) return null;

      if (dataKind === 'text') {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const skippedTags = new Set([
          'script',
          'style',
          'noscript',
          'template',
        ]);
        const chunks: string[] = [];
        let remaining = maxTextChars;
        let visited = 0;
        let node = walker.nextNode();
        while (node && remaining > 0 && visited < maxTextNodes) {
          visited += 1;
          const parentTag = node.parentElement?.tagName?.toLowerCase() ?? '';
          if (!skippedTags.has(parentTag)) {
            const value = node.nodeValue ?? '';
            const bounded = value.slice(0, remaining);
            chunks.push(bounded);
            remaining -= bounded.length;
          }
          node = walker.nextNode();
        }
        return chunks.join('').trim();
      }
      if (dataKind === 'value') {
        return 'value' in element
          ? String((element as HTMLInputElement).value ?? '').slice(
              0,
              maxValueChars
            )
          : null;
      }
      if (dataKind === 'attributes') {
        const attributes: Record<string, string> = {};
        const count = Math.min(element.attributes.length, maxAttributes);
        for (let index = 0; index < count; index += 1) {
          const attribute = element.attributes.item(index);
          if (!attribute) continue;
          const name = attribute.name.slice(0, maxAttributeNameChars);
          if (!name) continue;
          attributes[name] = attribute.value.slice(0, maxAttributeValueChars);
        }
        return attributes;
      }
      if (dataKind === 'bbox') {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        };
      }
      return null;
    },
    {
      elementXPath: String(xpath).slice(0, 16 * 1024),
      dataKind: kind,
      maxTextChars: MAX_CLI_ELEMENT_TEXT_CHARS,
      maxValueChars: MAX_CLI_ELEMENT_VALUE_CHARS,
      maxAttributes: MAX_CLI_ELEMENT_ATTRIBUTES,
      maxAttributeNameChars: MAX_CLI_ATTRIBUTE_NAME_CHARS,
      maxAttributeValueChars: MAX_CLI_ATTRIBUTE_VALUE_CHARS,
      maxTextNodes: MAX_CLI_ELEMENT_TEXT_NODES,
    }
  );
