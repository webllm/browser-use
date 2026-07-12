import { describe, expect, it } from 'vitest';
import {
  MAX_CLI_ATTRIBUTE_VALUE_CHARS,
  MAX_CLI_ELEMENT_ATTRIBUTES,
  MAX_CLI_ELEMENT_TEXT_CHARS,
  readBoundedCliElementData,
} from '../src/skill-cli/page-inspection.js';

describe('bounded skill CLI page inspection', () => {
  it('passes strict page-controlled data budgets to the evaluator', async () => {
    const page = {
      evaluate: async (_fn: unknown, limits: any) => limits,
    };

    const result = (await readBoundedCliElementData(
      page,
      '/html/body/main',
      'text'
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      dataKind: 'text',
      maxTextChars: MAX_CLI_ELEMENT_TEXT_CHARS,
      maxAttributes: MAX_CLI_ELEMENT_ATTRIBUTES,
      maxAttributeValueChars: MAX_CLI_ATTRIBUTE_VALUE_CHARS,
    });
  });

  it('bounds text nodes and attribute values inside the page context', async () => {
    const textNode = {
      nodeValue: 'x'.repeat(MAX_CLI_ELEMENT_TEXT_CHARS + 10_000),
      parentElement: { tagName: 'P' },
    };
    const attributeEntries = Array.from(
      { length: MAX_CLI_ELEMENT_ATTRIBUTES + 10 },
      (_, index) => ({
        name: `data-${index}`,
        value: 'v'.repeat(MAX_CLI_ATTRIBUTE_VALUE_CHARS + 100),
      })
    );
    const element = {
      attributes: {
        length: attributeEntries.length,
        item: (index: number) => attributeEntries[index] ?? null,
      },
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        top: 0,
        right: 1,
        bottom: 1,
        left: 0,
      }),
    };
    const page = {
      evaluate: async (fn: (payload: any) => unknown, payload: any) => {
        const globals = globalThis as any;
        const previous = {
          document: globals.document,
          NodeFilter: globals.NodeFilter,
          XPathResult: globals.XPathResult,
        };
        let returnedText = false;
        globals.document = {
          evaluate: () => ({ singleNodeValue: element }),
          createTreeWalker: () => ({
            nextNode: () => {
              if (returnedText) return null;
              returnedText = true;
              return textNode;
            },
          }),
        };
        globals.NodeFilter = { SHOW_TEXT: 4 };
        globals.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
        try {
          return await fn(payload);
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globals[key];
            else globals[key] = value;
          }
        }
      },
    };

    const text = await readBoundedCliElementData(
      page,
      '/html/body/main',
      'text'
    );
    const attributes = (await readBoundedCliElementData(
      page,
      '/html/body/main',
      'attributes'
    )) as Record<string, string>;

    expect(text).toHaveLength(MAX_CLI_ELEMENT_TEXT_CHARS);
    expect(Object.keys(attributes)).toHaveLength(MAX_CLI_ELEMENT_ATTRIBUTES);
    expect(attributes['data-0']).toHaveLength(MAX_CLI_ATTRIBUTE_VALUE_CHARS);
  });
});
