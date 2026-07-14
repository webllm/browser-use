import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROWSER_USE_SKILL_NAME = 'browser-use';

export const SKILL_TARGETS = [
  'agents',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
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
  destinations: string[];
  force: boolean;
  skillFileOnly: boolean;
};

const getSkillUsage = () => `Usage:
  browser-use skill show
  browser-use skill install [--target <${SKILL_TARGETS.join('|')}>] [--force]
  browser-use skill install --path <destination> [--force]

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
  homeDir: string,
  xdgConfigHome: string
) => {
  if (target === 'opencode') {
    return path.join(
      xdgConfigHome,
      'opencode',
      'skills',
      BROWSER_USE_SKILL_NAME
    );
  }
  return path.join(homeDir, `.${target}`, 'skills', BROWSER_USE_SKILL_NAME);
};

const parseInstallRequest = (
  argv: string[],
  homeDir: string,
  xdgConfigHome: string
): InstallRequest => {
  const targets: SkillTarget[] = [];
  let customPath: string | null = null;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--force') {
      force = true;
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
      destinations: [destination],
      force,
      skillFileOnly: path.basename(destination) === 'SKILL.md',
    };
  }

  const selectedTargets =
    targets.length > 0 ? [...new Set(targets)] : [...SKILL_TARGETS];
  return {
    destinations: selectedTargets.map((target) =>
      getTargetDestination(target, homeDir, xdgConfigHome)
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
  const source = request.skillFileOnly
    ? path.join(bundledSkillDir, 'SKILL.md')
    : bundledSkillDir;

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
    writeLine(stdout, `Installed browser-use skill: ${destination}`);
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

    if (command === 'show') {
      if (argv.length > 1) {
        throw new Error('browser-use skill show does not accept options.');
      }
      stdout.write(await fs.readFile(path.join(bundledSkillDir, 'SKILL.md')));
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
