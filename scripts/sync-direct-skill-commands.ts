import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDirectSkillCommandTable } from '../src/skill-cli/direct-commands.js';

const START_MARKER = '<!-- BEGIN GENERATED DIRECT COMMANDS -->';
const END_MARKER = '<!-- END GENERATED DIRECT COMMANDS -->';
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const skillPath = path.join(
  repositoryRoot,
  'skills',
  'browser-use',
  'SKILL.md'
);
const checkOnly = process.argv.includes('--check');

const current = fs.readFileSync(skillPath, 'utf8');
const startIndex = current.indexOf(START_MARKER);
const endIndex = current.indexOf(END_MARKER);

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  throw new Error(
    `Expected generated command markers in ${path.relative(repositoryRoot, skillPath)}`
  );
}

const generated = `${START_MARKER}\n${renderDirectSkillCommandTable()}\n${END_MARKER}`;
const next =
  current.slice(0, startIndex) +
  generated +
  current.slice(endIndex + END_MARKER.length);

if (next === current) {
  process.stdout.write('Direct Skill command table is up to date.\n');
} else if (checkOnly) {
  process.stderr.write(
    'Direct Skill command table is stale. Run "pnpm skill:commands:sync".\n'
  );
  process.exitCode = 1;
} else {
  fs.writeFileSync(skillPath, next, 'utf8');
  process.stdout.write('Updated Direct Skill command table.\n');
}
