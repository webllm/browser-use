import { describe, expect, it } from 'vitest';
import { SchemaOptimizer } from '../src/llm/schema.js';

describe('SchemaOptimizer field names', () => {
  it('keeps user fields whose names match JSON Schema keywords', () => {
    const schema = {
      type: 'object',
      title: 'Report',
      properties: {
        default: { type: 'string', title: 'Default', description: 'kept' },
        minItems: { type: 'integer' },
        propertyNames: { type: 'string' },
        title: { type: 'string' },
        $defs: { type: 'string' },
        properties: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
      required: [
        'default',
        'minItems',
        'propertyNames',
        'title',
        '$defs',
        'properties',
        'additionalProperties',
      ],
    };

    const optimized = SchemaOptimizer.createOptimizedJsonSchema(schema, {
      removeMinItems: true,
      removeDefaults: true,
    }) as any;

    expect(Object.keys(optimized.properties).sort()).toEqual(
      [
        '$defs',
        'additionalProperties',
        'default',
        'minItems',
        'properties',
        'propertyNames',
        'title',
      ].sort()
    );
    expect(optimized.required).toHaveLength(7);
    expect(optimized.properties.default).toEqual({
      type: 'string',
      description: 'kept',
    });
    // Schema-level metadata titles are still dropped.
    expect(optimized.title).toBeUndefined();
    expect(optimized.additionalProperties).toBe(false);
  });

  it('still removes schema keywords outside of property maps', () => {
    const optimized = SchemaOptimizer.createOptimizedJsonSchema(
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            default: ['a'],
            items: { type: 'string', propertyNames: { pattern: 'x' } },
          },
        },
      },
      { removeMinItems: true, removeDefaults: true }
    ) as any;

    expect(optimized.properties.items).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });
});
