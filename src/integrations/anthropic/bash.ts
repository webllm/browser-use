/**
 * Bounded Bash tool for Claude tool runners.
 *
 * Commands run from the configured output directory with a stripped
 * environment (no inherited credentials), a hard timeout that kills the whole
 * process group, and capped output.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

export interface BashToolOptions {
  /** Working directory for commands and their deliverables (default `outputs`). */
  outputDir?: string;
  /** Hard limit per command (default 120 seconds). */
  timeoutSeconds?: number;
  /** Combined stdout/stderr bytes returned to Claude (default 50,000). */
  maxOutputBytes?: number;
}

export interface RunBashOptions extends BashToolOptions {
  signal?: AbortSignal | null;
}

export interface BashResult {
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  output: string;
}

const KILL_GRACE_MS = 1000;

const expandHome = (value: string) =>
  value === '~' || value.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), value.slice(1))
    : value;

const exitCodeFor = (code: number | null, signal: NodeJS.Signals | null) => {
  if (code !== null) {
    return code;
  }
  // Mirror the shell convention used by Python's subprocess: -SIGNUM.
  const number = signal ? os.constants.signals[signal] : undefined;
  return typeof number === 'number' ? -number : null;
};

/**
 * Run a command with `/bin/bash` and return a JSON string with `exit_code`,
 * `timed_out`, `truncated`, and `output` (stdout and stderr interleaved).
 */
export const runBash = async (
  command: string,
  options: RunBashOptions = {}
): Promise<string> => {
  if (process.platform === 'win32') {
    throw new Error(
      'Browser Use Bash currently requires a POSIX host with /bin/bash.'
    );
  }
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  const maxOutputBytes = options.maxOutputBytes ?? 50_000;
  if (!(timeoutSeconds > 0)) {
    throw new Error('timeoutSeconds must be positive');
  }
  if (!(maxOutputBytes > 0)) {
    throw new Error('maxOutputBytes must be positive');
  }
  const root = path.resolve(expandHome(options.outputDir ?? 'outputs'));
  const tmp = path.join(root, '.tmp');
  await fs.mkdir(tmp, { recursive: true });

  const result = await new Promise<BashResult>((resolve, reject) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd: root,
      env: {
        HOME: root,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        PYTHONNOUSERSITE: '1',
        TMPDIR: tmp,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group lets a timeout kill the command's descendants.
      detached: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;

    const collect = (data: Buffer) => {
      const remaining = maxOutputBytes - size;
      if (remaining > 0) {
        const kept = data.subarray(0, remaining);
        chunks.push(kept);
        size += kept.length;
      }
      if (data.length > remaining) {
        truncated = true;
      }
    };
    const killGroup = () => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exit_code: exitCodeFor(
          code ?? child.exitCode,
          signal ?? child.signalCode
        ),
        timed_out: timedOut,
        truncated,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    };
    const stop = () => {
      killGroup();
      // Close our pipe ends even if a detached descendant still holds them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      graceTimer = setTimeout(() => finish(null, null), KILL_GRACE_MS);
    };
    const onAbort = () => {
      if (!settled) {
        stop();
      }
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
    // `close` fires after the shell exits and its output pipes are closed.
    child.on('close', (code, signal) => finish(code, signal));
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutSeconds * 1000);
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
  return JSON.stringify(result);
};

/**
 * Create the `bash` tool. It works with this package's
 * `runBrowserToolsetConversation` and with the SDK's
 * `client.beta.messages.toolRunner`.
 */
export const createBashTool = (
  options: BashToolOptions = {}
): BetaRunnableTool<{ command: string }> =>
  betaTool({
    name: 'bash',
    description:
      'Run Bash for local computation and create deliverables in the configured output directory. ' +
      'Browser actions must use the browser toolset.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The Bash command to run.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    run: ({ command }, context) =>
      runBash(command, { ...options, signal: context?.signal ?? null }),
  });
