import { z } from 'zod';
import type { SkillDefinition, SkillParameterSchema } from './views.js';

const normalizeSlug = (title: string): string => {
  const cleaned = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'skill';
};

const normalizeTypeSchema = (param: SkillParameterSchema): z.ZodTypeAny => {
  switch (param.type) {
    case 'string':
    case 'cookie':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.unknown());
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
};

export const get_skill_slug = (
  skill: SkillDefinition,
  all_skills: SkillDefinition[]
): string => {
  const slug = normalizeSlug(skill.title);
  const duplicateCount = all_skills.filter((entry) => {
    return normalizeSlug(entry.title) === slug;
  }).length;

  if (duplicateCount > 1) {
    return `${slug}_${skill.id.slice(0, 4)}`;
  }
  return slug;
};

export const build_skill_parameters_schema = (
  parameters: SkillParameterSchema[],
  options: { exclude_cookies?: boolean } = {}
): z.ZodObject<Record<string, z.ZodTypeAny>> => {
  const { exclude_cookies = false } = options;
  const shape = Object.create(null) as Record<string, z.ZodTypeAny>;

  for (const param of parameters) {
    if (exclude_cookies && param.type === 'cookie') {
      continue;
    }

    const description =
      typeof param.description === 'string' ? param.description.trim() : '';
    const required = param.required !== false;

    let schema = normalizeTypeSchema(param);
    if (description) {
      schema = schema.describe(description);
    }

    shape[param.name] = required ? schema : schema.optional();
  }

  return z.object(shape);
};
