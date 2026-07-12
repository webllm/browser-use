import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIRECT_COMMAND_SPECS,
  formatDirectUsage,
  renderDirectSkillCommandTable,
} from '../src/skill-cli/direct-commands.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

describe('browser-use-direct command contract', () => {
  it('keeps registry names unique and aligned with implemented dispatch branches', () => {
    const registeredNames = DIRECT_COMMAND_SPECS.map((command) => command.name);
    expect(new Set(registeredNames).size).toBe(registeredNames.length);

    const directSource = fs.readFileSync(
      path.join(repositoryRoot, 'src', 'skill-cli', 'direct.ts'),
      'utf8'
    );
    const implementedNames = Array.from(
      directSource.matchAll(/\bcommand === '([^']+)'/g),
      (match) => match[1]
    ).filter(
      (command) =>
        command !== 'help' && command !== '--help' && command !== '-h'
    );

    expect([...implementedNames].sort()).toEqual([...registeredNames].sort());
  });

  it('derives help variants and documented invocations from their command', () => {
    const help = formatDirectUsage();

    for (const command of DIRECT_COMMAND_SPECS) {
      for (const variant of command.variants) {
        expect(variant.usage.split(' ')[0]).toBe(command.name);
        expect(help).toContain(variant.usage);
      }
      for (const usage of command.documentation.usages) {
        expect(usage.split(' ')[0]).toBe(command.name);
      }
    }
  });

  it('keeps the bundled Skill command table generated from the registry', () => {
    const skill = fs.readFileSync(
      path.join(repositoryRoot, 'skills', 'browser-use', 'SKILL.md'),
      'utf8'
    );
    const generatedBlock =
      '<!-- BEGIN GENERATED DIRECT COMMANDS -->\n' +
      `${renderDirectSkillCommandTable()}\n` +
      '<!-- END GENERATED DIRECT COMMANDS -->';

    expect(skill).toContain(generatedBlock);
  });
});
