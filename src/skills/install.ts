import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROWSER_USE_SKILL_NAME = 'browser-use';

/** Skills shipped with the package, installable by name. */
export const BUNDLED_SKILLS = {
  'browser-use':
    'Drive a persistent browser from a coding agent (direct CLI and MCP).',
  'browser-use-ts':
    'Reference for writing TypeScript code with the browser-use package.',
} as const;

export type BundledSkillName = keyof typeof BUNDLED_SKILLS;

export const SKILL_TARGETS = [
  'agents',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'openclaw',
  'opencode',
] as const;

export type SkillTarget = (typeof SKILL_TARGETS)[number];

type Writable = Pick<NodeJS.WriteStream, 'write'>;

export type SkillCommandOptions = {
  bundledSkillDir?: string;
  homeDir?: string;
  xdgConfigHome?: string;
  stdout?: Writable;
  stderr?: Writable;
};

type InstallRequest = {
  skill: BundledSkillName;
  destinations: string[];
  force: boolean;
  skillFileOnly: boolean;
};

const getSkillUsage = () => `Usage:
  browser-use skill list
  browser-use skill show [skill]
  browser-use skill install [--skill <name>] [--target <${SKILL_TARGETS.join('|')}>] [--force]
  browser-use skill install [--skill <name>] --path <destination> [--force]

Skills: ${Object.keys(BUNDLED_SKILLS).join(', ')} (default: ${BROWSER_USE_SKILL_NAME}).
Without --target or --path, install copies the skill to every supported coding-agent directory.`;

const writeLine = (stream: Writable, value: string) => {
  stream.write(`${value}\n`);
};

const getBundledSkillDir = () =>
  path.resolve(
    fileURLToPath(new URL('../../skills/browser-use', import.meta.url))
  );

const expandHome = (value: string, homeDir: string) => {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return path.resolve(value);
};

const readOptionValue = (argv: string[], index: number, option: string) => {
  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

const parseSkillName = (value: string): BundledSkillName => {
  if (Object.prototype.hasOwnProperty.call(BUNDLED_SKILLS, value)) {
    return value as BundledSkillName;
  }
  throw new Error(
    `Unknown skill "${value}". Expected one of: ${Object.keys(BUNDLED_SKILLS).join(', ')}.`
  );
};

/**
 * Directory of a bundled skill. Skills sit side by side, so the directory of
 * the default skill identifies the others.
 */
const getSkillDir = (bundledSkillDir: string, skill: BundledSkillName) =>
  skill === BROWSER_USE_SKILL_NAME
    ? bundledSkillDir
    : path.join(path.dirname(bundledSkillDir), skill);

const parseTarget = (value: string): SkillTarget => {
  if ((SKILL_TARGETS as readonly string[]).includes(value)) {
    return value as SkillTarget;
  }
  throw new Error(
    `Unsupported skill target "${value}". Expected one of: ${SKILL_TARGETS.join(', ')}.`
  );
};

const getTargetDestination = (
  target: SkillTarget,
  skill: BundledSkillName,
  homeDir: string,
  xdgConfigHome: string
) => {
  if (target === 'opencode') {
    return path.join(xdgConfigHome, 'opencode', 'skills', skill);
  }
  return path.join(homeDir, `.${target}`, 'skills', skill);
};

const parseInstallRequest = (
  argv: string[],
  homeDir: string,
  xdgConfigHome: string
): InstallRequest => {
  const targets: SkillTarget[] = [];
  let customPath: string | null = null;
  let force = false;
  let skill: BundledSkillName = BROWSER_USE_SKILL_NAME;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--skill') {
      skill = parseSkillName(readOptionValue(argv, index, '--skill'));
      index += 1;
      continue;
    }
    if (arg.startsWith('--skill=')) {
      skill = parseSkillName(arg.slice('--skill='.length).trim());
      continue;
    }
    if (arg === '--target') {
      targets.push(parseTarget(readOptionValue(argv, index, '--target')));
      index += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      targets.push(parseTarget(arg.slice('--target='.length).trim()));
      continue;
    }
    if (arg === '--path') {
      customPath = readOptionValue(argv, index, '--path');
      index += 1;
      continue;
    }
    if (arg.startsWith('--path=')) {
      customPath = arg.slice('--path='.length).trim();
      if (!customPath) {
        throw new Error('--path requires a value.');
      }
      continue;
    }
    throw new Error(`Unknown skill install option: ${arg}`);
  }

  if (customPath && targets.length > 0) {
    throw new Error('Use either --path or --target, not both.');
  }

  if (customPath) {
    const destination = expandHome(customPath, homeDir);
    return {
      skill,
      destinations: [destination],
      force,
      skillFileOnly: path.basename(destination) === 'SKILL.md',
    };
  }

  const selectedTargets =
    targets.length > 0 ? [...new Set(targets)] : [...SKILL_TARGETS];
  return {
    skill,
    destinations: selectedTargets.map((target) =>
      getTargetDestination(target, skill, homeDir, xdgConfigHome)
    ),
    force,
    skillFileOnly: false,
  };
};

const getPathStats = async (value: string) => {
  try {
    return await fs.lstat(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const validateDestinationType = async (
  destination: string,
  skillFileOnly: boolean
) => {
  const stats = await getPathStats(destination);
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Skill destination must not be a symlink: ${destination}`);
  }
  if (skillFileOnly && !stats.isFile()) {
    throw new Error(`Skill destination is not a regular file: ${destination}`);
  }
  if (!skillFileOnly && !stats.isDirectory()) {
    throw new Error(`Skill destination is not a directory: ${destination}`);
  }
  return stats;
};

const installSkill = async (
  bundledSkillDir: string,
  request: InstallRequest,
  stdout: Writable
) => {
  const skillDir = getSkillDir(bundledSkillDir, request.skill);
  const source = request.skillFileOnly
    ? path.join(skillDir, 'SKILL.md')
    : skillDir;

  if (!(await getPathStats(source))) {
    throw new Error(`Bundled skill is missing: ${source}`);
  }

  for (const destination of request.destinations) {
    const existing = await validateDestinationType(
      destination,
      request.skillFileOnly
    );
    if (!request.force && existing) {
      throw new Error(
        `Skill destination already exists: ${destination}. Use --force to update it.`
      );
    }
  }

  for (const destination of request.destinations) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (request.skillFileOnly) {
      await fs.copyFile(
        source,
        destination,
        request.force ? 0 : constants.COPYFILE_EXCL
      );
    } else {
      await fs.cp(source, destination, {
        recursive: true,
        force: request.force,
        errorOnExist: !request.force,
      });
    }
    writeLine(stdout, `Installed ${request.skill} skill: ${destination}`);
  }
};

export const runSkillCommand = async (
  argv: string[],
  options: SkillCommandOptions = {}
) => {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const bundledSkillDir = options.bundledSkillDir ?? getBundledSkillDir();
  const homeDir = options.homeDir ?? os.homedir();
  const configuredXdgHome = process.env.XDG_CONFIG_HOME?.trim();
  const requestedXdgHome = options.xdgConfigHome ?? configuredXdgHome;
  const xdgConfigHome =
    requestedXdgHome && path.isAbsolute(requestedXdgHome)
      ? requestedXdgHome
      : path.join(homeDir, '.config');

  try {
    const command = argv[0];
    if (!command || command === '--help' || command === '-h') {
      writeLine(stdout, getSkillUsage());
      return 0;
    }

    if (command === 'list') {
      for (const [name, description] of Object.entries(BUNDLED_SKILLS)) {
        writeLine(stdout, `${name}\t${description}`);
      }
      return 0;
    }

    if (command === 'show') {
      if (argv.length > 2 || (argv[1] ?? '').startsWith('-')) {
        throw new Error('Usage: browser-use skill show [skill]');
      }
      const skill = argv[1] ? parseSkillName(argv[1]) : BROWSER_USE_SKILL_NAME;
      stdout.write(
        await fs.readFile(
          path.join(getSkillDir(bundledSkillDir, skill), 'SKILL.md')
        )
      );
      return 0;
    }

    if (command === 'install') {
      if (argv.includes('--help') || argv.includes('-h')) {
        writeLine(stdout, getSkillUsage());
        return 0;
      }
      const request = parseInstallRequest(
        argv.slice(1),
        homeDir,
        xdgConfigHome
      );
      await installSkill(bundledSkillDir, request, stdout);
      return 0;
    }

    throw new Error(`Unknown skill command: ${command}`);
  } catch (error) {
    writeLine(
      stderr,
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
};
