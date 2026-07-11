#!/usr/bin/env node
import fs from 'node:fs';
import { stdout } from 'node:process';
import { getCliUsage } from './cli-usage.js';
import { isMainModule } from './entrypoint.js';

type CliModule = {
  main: (argv?: string[]) => Promise<void>;
};

type WritableLike = {
  write(chunk: string): unknown;
};

export interface RunCliEntryOptions {
  loadCli?: () => Promise<CliModule>;
  readVersion?: () => string;
  stdout?: WritableLike;
}

export const readCliPackageVersion = (): string => {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
    );
    return typeof packageJson?.version === 'string'
      ? packageJson.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
};

export const runCliEntry = async (
  argv: string[] = process.argv.slice(2),
  options: RunCliEntryOptions = {}
): Promise<void> => {
  const output = options.stdout ?? stdout;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    output.write(`${getCliUsage()}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === '--version') {
    output.write(`${(options.readVersion ?? readCliPackageVersion)()}\n`);
    return;
  }

  const cli = await (options.loadCli ?? (() => import('./cli.js')))();
  await cli.main(argv);
};

if (isMainModule(import.meta.url)) {
  void runCliEntry();
}
