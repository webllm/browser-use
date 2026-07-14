import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  MAX_CLI_ATTRIBUTE_VALUE_CHARS,
  MAX_CLI_ELEMENT_ATTRIBUTES,
  MAX_CLI_ELEMENT_TEXT_CHARS,
  MAX_CLI_EVAL_OUTPUT_CHARS,
  evaluateBoundedCliScript,
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

  it('bounds eval values before they leave the page context', async () => {
    const page = {
      evaluate: async (fn: (payload: any) => unknown, payload: any) =>
        await fn(payload),
    };

    const result = await evaluateBoundedCliScript(
      page,
      `({ text: 'x'.repeat(${MAX_CLI_EVAL_OUTPUT_CHARS * 2}) })`
    );

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output?.length).toBeLessThanOrEqual(
      MAX_CLI_EVAL_OUTPUT_CHARS
    );
  });

  it('serializes eval callbacks without relying on a page-global __name helper', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.evaluate(() => {
        Object.defineProperty(globalThis, '__name', {
          value: 42,
          configurable: false,
          writable: false,
        });
      });

      const result = await evaluateBoundedCliScript(
        page,
        '({ answer: 42, nested: [true, null] })'
      );

      expect(result).toEqual({
        ok: true,
        output: '{"answer":42,"nested":[true,null]}',
        truncated: false,
      });
    } finally {
      await browser.close();
    }
  });
});
