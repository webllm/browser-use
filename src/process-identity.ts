import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export type ProcessCommandLineReader = (
  pid: number
) => string | null | Promise<string | null>;

export type ProcessArgumentsReader = (pid: number) => string[] | null;

const isValidPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;

const parseDisplayedCommandLine = (commandLine: string) =>
  (commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((argument) => {
    if (
      argument.length >= 2 &&
      ((argument.startsWith('"') && argument.endsWith('"')) ||
        (argument.startsWith("'") && argument.endsWith("'")))
    ) {
      return argument.slice(1, -1);
    }
    return argument;
  });

const readPsField = (pid: number, field: 'command' | 'comm') => {
  const result = spawnSync(
    'ps',
    ['-ww', '-p', String(pid), '-o', `${field}=`],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
};

const readWindowsProcessDetails = (pid: number) => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $process) { @{ executablePath = $process.ExecutablePath; commandLine = $process.CommandLine } | ConvertTo-Json -Compress }`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      executablePath?: unknown;
      commandLine?: unknown;
    };
    return {
      executablePath:
        typeof parsed.executablePath === 'string'
          ? parsed.executablePath.trim()
          : '',
      commandLine:
        typeof parsed.commandLine === 'string' ? parsed.commandLine.trim() : '',
    };
  } catch {
    return null;
  }
};

const argumentsAfterExecutable = (
  commandLine: string,
  executablePath: string
) => {
  if (!executablePath) {
    return null;
  }

  const quotedExecutable = `"${executablePath}"`;
  const caseInsensitive = process.platform === 'win32';
  const comparableCommandLine = caseInsensitive
    ? commandLine.toLowerCase()
    : commandLine;
  const comparableExecutable = caseInsensitive
    ? executablePath.toLowerCase()
    : executablePath;
  const comparableQuotedExecutable = caseInsensitive
    ? quotedExecutable.toLowerCase()
    : quotedExecutable;
  let remainder: string | null = null;
  if (comparableCommandLine === comparableQuotedExecutable) {
    remainder = '';
  } else if (
    comparableCommandLine.startsWith(`${comparableQuotedExecutable} `)
  ) {
    remainder = commandLine.slice(quotedExecutable.length).trimStart();
  } else if (comparableCommandLine === comparableExecutable) {
    remainder = '';
  } else if (comparableCommandLine.startsWith(`${comparableExecutable} `)) {
    remainder = commandLine.slice(executablePath.length).trimStart();
  }

  if (remainder == null) {
    return null;
  }
  return [executablePath, ...parseDisplayedCommandLine(remainder)];
};

export const getProcessArguments: ProcessArgumentsReader = (pid) => {
  if (!isValidPid(pid)) {
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const rawArguments = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const args = rawArguments.split('\0');
      if (args.at(-1) === '') {
        args.pop();
      }
      return args.length > 0 && args[0] ? args : null;
    } catch {
      return null;
    }
  }

  if (process.platform === 'win32') {
    const details = readWindowsProcessDetails(pid);
    if (!details?.commandLine || !details.executablePath) {
      return null;
    }
    const args = argumentsAfterExecutable(
      details.commandLine,
      details.executablePath
    );
    if (!args) {
      return null;
    }
    return args.length > 0 ? args : null;
  }

  const commandLine = readPsField(pid, 'command');
  if (!commandLine) {
    return null;
  }
  const executablePath = readPsField(pid, 'comm');
  if (!executablePath) {
    return null;
  }
  const args = argumentsAfterExecutable(commandLine, executablePath);
  if (!args) {
    return null;
  }
  return args.length > 0 ? args : null;
};

export const getProcessCommandLine = (pid: number): string | null => {
  if (!isValidPid(pid)) {
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const commandLine = fs
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ')
        .trim();
      return commandLine || null;
    } catch {
      return null;
    }
  }

  if (process.platform === 'win32') {
    return readWindowsProcessDetails(pid)?.commandLine || null;
  }

  return readPsField(pid, 'command');
};
