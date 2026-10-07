import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

type JsonSchema = Record<string, unknown>;

interface ZodJsonSchemaOptions {
  name?: string;
  target?: string;
  [key: string]: unknown;
}

export const zodSchemaToJsonSchema = (
  schema: unknown,
  options: ZodJsonSchemaOptions = {}
): JsonSchema => {
  try {
    const toJSONSchema = (z as any)?.toJSONSchema;
    if (typeof toJSONSchema === 'function') {
      const converted = toJSONSchema(schema as any) as JsonSchema;
      if (converted && typeof converted === 'object') {
        return converted;
      }
    }
  } catch {
    // Fall back to zod-to-json-schema below.
  }

  return zodToJsonSchema(schema as any, options as any) as JsonSchema;
};

export class SchemaOptimizer {
  static createOptimizedJsonSchema(
    schema: JsonSchema,
    options: {
      removeMinItems?: boolean;
      removeDefaults?: boolean;
    } = {}
  ): JsonSchema {
    const defsLookup = (schema.$defs as Record<string, JsonSchema>) ?? {};
    const removeMinItems = options.removeMinItems ?? false;
    const removeDefaults = options.removeDefaults ?? false;

    const optimize = (obj: any, inProperties = false): any => {
      if (Array.isArray(obj)) {
        return obj.map((item) => optimize(item, inProperties));
      }

      if (obj && typeof obj === 'object') {
        let flattenedRef: any = null;
        const optimized: Record<string, any> = {};

        for (const [key, value] of Object.entries(obj)) {
          // Keys inside a `properties` map are user field names, not schema
          // keywords, so a field called `default` or `title` must survive.
          if (inProperties) {
            optimized[key] = optimize(value, false);
            continue;
          }
          if (key === '$defs') continue;
          // Some OpenAI-compatible providers reject this JSON Schema keyword.
          if (key === 'propertyNames') continue;
          // Titles are metadata; field names never reach this branch.
          if (key === 'title') continue;
          if (removeMinItems && (key === 'minItems' || key === 'min_items')) {
            continue;
          }
          if (removeDefaults && key === 'default') continue;

          if (key === '$ref' && typeof value === 'string') {
            const refName = value.split('/').pop()!;
            if (defsLookup[refName]) {
              flattenedRef = optimize(defsLookup[refName], inProperties);
            }
            continue;
          }

          if (key === 'additionalProperties') {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const optimizedAdditional = optimize(value, inProperties);
              optimized[key] =
                Object.keys(optimizedAdditional).length === 0
                  ? true
                  : optimizedAdditional;
            } else {
              optimized[key] = value;
            }
            continue;
          }

          if (key === 'properties') {
            optimized[key] = optimize(value, true);
            continue;
          }

          if (typeof value === 'object' && value !== null) {
            optimized[key] = optimize(value, inProperties);
            continue;
          }

          optimized[key] = value;
        }

        const result = flattenedRef
          ? { ...flattenedRef, ...optimized }
          : optimized;
        const hasExplicitProperties =
          result.properties &&
          typeof result.properties === 'object' &&
          !Array.isArray(result.properties);
        if (
          result.type === 'object' &&
          result.additionalProperties === undefined &&
          hasExplicitProperties
        ) {
          result.additionalProperties = false;
        }
        return result;
      }

      return obj;
    };

    const optimizedSchema = optimize(schema);

    const ensureAdditionalProperties = (obj: any) => {
      if (Array.isArray(obj)) {
        obj.forEach(ensureAdditionalProperties);
        return;
      }
      if (obj && typeof obj === 'object') {
        const hasExplicitProperties =
          obj.properties &&
          typeof obj.properties === 'object' &&
          !Array.isArray(obj.properties);
        if (
          obj.type === 'object' &&
          obj.additionalProperties === undefined &&
          hasExplicitProperties
        ) {
          obj.additionalProperties = false;
        }
        Object.values(obj).forEach(ensureAdditionalProperties);
      }
    };

    const stripStructuredDoneSuccess = (obj: any) => {
      if (Array.isArray(obj)) {
        obj.forEach(stripStructuredDoneSuccess);
        return;
      }
      if (!obj || typeof obj !== 'object') {
        return;
      }

      const properties = obj.properties;
      if (
        obj.type === 'object' &&
        properties &&
        typeof properties === 'object' &&
        !Array.isArray(properties)
      ) {
        const dataSchema = (properties as Record<string, any>).data;
        const successSchema = (properties as Record<string, any>).success;
        const looksLikeStructuredDone =
          dataSchema &&
          successSchema &&
          successSchema.type === 'boolean' &&
          successSchema.description ===
            'True if user_request completed successfully';

        if (looksLikeStructuredDone) {
          delete (properties as Record<string, any>).success;
          if (Array.isArray(obj.required)) {
            obj.required = obj.required.filter(
              (name: unknown) => name !== 'success'
            );
          }
        }
      }

      Object.values(obj).forEach(stripStructuredDoneSuccess);
    };

    const stripExtractOutputSchema = (
      obj: any,
      parentKey: string | null = null
    ) => {
      if (Array.isArray(obj)) {
        obj.forEach((item) => stripExtractOutputSchema(item, parentKey));
        return;
      }
      if (!obj || typeof obj !== 'object') {
        return;
      }

      const isExtractActionSchema =
        parentKey === 'extract_structured_data' || parentKey === 'extract';
      if (isExtractActionSchema && obj.type === 'object') {
        const props = obj.properties;
        if (props && typeof props === 'object' && !Array.isArray(props)) {
          delete (props as Record<string, unknown>).output_schema;
        }
        if (Array.isArray(obj.required)) {
          obj.required = obj.required.filter(
            (name: unknown) => name !== 'output_schema'
          );
        }
      }

      for (const [key, value] of Object.entries(obj)) {
        stripExtractOutputSchema(value, key);
      }
    };

    ensureAdditionalProperties(optimizedSchema);
    stripStructuredDoneSuccess(optimizedSchema);
    stripExtractOutputSchema(optimizedSchema);
    SchemaOptimizer.makeStrictCompatible(optimizedSchema);
    return optimizedSchema;
  }

  static createGeminiOptimizedSchema(schema: JsonSchema): JsonSchema {
    return SchemaOptimizer.createOptimizedJsonSchema(schema);
  }

  static makeStrictCompatible(schema: any) {
    if (Array.isArray(schema)) {
      schema.forEach(SchemaOptimizer.makeStrictCompatible);
      return;
    }
    if (schema && typeof schema === 'object') {
      for (const [key, value] of Object.entries(schema)) {
        if (key !== 'required' && value && typeof value === 'object') {
          SchemaOptimizer.makeStrictCompatible(value);
        }
      }
      if (schema.type === 'object' && schema.properties) {
        schema.required = Object.keys(schema.properties);
      }
    }
  }
}
