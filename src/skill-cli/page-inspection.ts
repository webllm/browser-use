export const MAX_CLI_ELEMENT_TEXT_CHARS = 256 * 1024;
export const MAX_CLI_ELEMENT_VALUE_CHARS = 64 * 1024;
export const MAX_CLI_ELEMENT_ATTRIBUTES = 64;
export const MAX_CLI_ATTRIBUTE_NAME_CHARS = 256;
export const MAX_CLI_ATTRIBUTE_VALUE_CHARS = 4 * 1024;
export const MAX_CLI_ELEMENT_TEXT_NODES = 50_000;
export const MAX_CLI_EVAL_OUTPUT_CHARS = 100_000;
export const MAX_CLI_EVAL_ENTRIES = 5_000;
export const MAX_CLI_EVAL_DEPTH = 20;

type PageEvaluator = {
  evaluate: (...args: any[]) => Promise<unknown>;
};

export type BoundedCliEvaluation = {
  ok: boolean;
  output?: string;
  truncated?: boolean;
  error?: string;
};

export const evaluateBoundedCliScript = async (
  page: PageEvaluator,
  script: string
): Promise<BoundedCliEvaluation> =>
  (await page.evaluate(
    async ({
      code,
      maxOutputChars,
      maxEntries,
      maxDepth,
    }: {
      code: string;
      maxOutputChars: number;
      maxEntries: number;
      maxDepth: number;
    }) => {
      try {
        const raw = await Promise.resolve((0, eval)(code));
        let remainingTextChars = maxOutputChars;
        let remainingEntries = maxEntries;
        let truncated = false;
        const seen = new WeakSet<object>();

        // Array destructuring prevents esbuild's keepNames transform from
        // introducing a free `__name` helper into this serialized callback.
        const [takeText] = [
          (value: string, limit = maxOutputChars) => {
            const length = Math.min(value.length, limit, remainingTextChars);
            const result = value.slice(0, length);
            remainingTextChars -= result.length;
            if (result.length < value.length) truncated = true;
            return result;
          },
        ];
        const [boundedClone] = [
          (value: unknown, depth = 0): unknown => {
            if (value === undefined) return '[undefined]';
            if (value === null) return null;
            if (typeof value === 'string') return takeText(value);
            if (typeof value === 'boolean' || typeof value === 'number') {
              return value;
            }
            if (typeof value === 'bigint' || typeof value === 'symbol') {
              return takeText(String(value), 256);
            }
            if (typeof value === 'function') {
              return `[Function ${takeText(value.name || 'anonymous', 128)}]`;
            }
            if (depth >= maxDepth || remainingEntries <= 0) {
              truncated = true;
              return '[Truncated]';
            }

            const objectValue = value as object;
            if (seen.has(objectValue)) return '[Circular]';
            seen.add(objectValue);

            if (Array.isArray(value)) {
              const output: unknown[] = [];
              const count = Math.min(value.length, remainingEntries);
              if (count < value.length) truncated = true;
              for (let index = 0; index < count; index += 1) {
                remainingEntries -= 1;
                try {
                  output.push(boundedClone(value[index], depth + 1));
                } catch {
                  output.push('[Unreadable]');
                }
              }
              return output;
            }

            const output = Object.create(null) as Record<string, unknown>;
            const record = value as Record<string, unknown>;
            let propertyCount = 0;
            try {
              for (const key in record) {
                if (!Object.prototype.hasOwnProperty.call(record, key)) {
                  continue;
                }
                if (remainingEntries <= 0 || remainingTextChars <= 0) {
                  truncated = true;
                  break;
                }
                remainingEntries -= 1;
                propertyCount += 1;
                const safeKey = takeText(key, 256);
                if (!safeKey) break;
                try {
                  output[safeKey] = boundedClone(record[key], depth + 1);
                } catch {
                  output[safeKey] = '[Unreadable]';
                }
              }
            } catch {
              truncated = true;
            }
            return propertyCount === 0 ? '[Object]' : output;
          },
        ];

        let output: string;
        if (raw === undefined) {
          output = 'undefined';
        } else {
          try {
            output = JSON.stringify(boundedClone(raw));
          } catch {
            output = '[Unserializable]';
            truncated = true;
          }
        }
        if (output.length > maxOutputChars) {
          output = output.slice(0, maxOutputChars);
          truncated = true;
        }
        return { ok: true, output, truncated };
      } catch (error: unknown) {
        let message = 'Unknown evaluation error';
        try {
          message =
            error instanceof Error
              ? error.message
              : String(error ?? 'Unknown evaluation error');
        } catch {
          // Keep the safe fallback message.
        }
        return { ok: false, error: message.slice(0, 2_000) };
      }
    },
    {
      code: script,
      maxOutputChars: MAX_CLI_EVAL_OUTPUT_CHARS,
      maxEntries: MAX_CLI_EVAL_ENTRIES,
      maxDepth: MAX_CLI_EVAL_DEPTH,
    }
  )) as BoundedCliEvaluation;

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
