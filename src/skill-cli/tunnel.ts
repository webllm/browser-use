import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  getProcessArguments,
  type ProcessArgumentsReader,
} from '../process-identity.js';
import { readBoundedPrivateFile } from '../private-state.js';

const TUNNEL_URL_PATTERN = /(https:\/\/\S+\.trycloudflare\.com)/;
const DEFAULT_TUNNELS_DIR = path.join(os.homedir(), '.browser-use', 'tunnels');
export const MAX_TUNNEL_INFO_BYTES = 64 * 1024;
export const MAX_TUNNEL_STARTUP_LOG_BYTES = 1024 * 1024;
export const isValidTunnelPort = (port: unknown): port is number =>
  typeof port === 'number' &&
  Number.isSafeInteger(port) &&
  port >= 1 &&
  port <= 65_535;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const findSystemBinary = (binary: string) => {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [binary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    return null;
  }
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
};

const parseCommandLine = (commandLine: string) =>
  (commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((arg) => {
    if (
      arg.length >= 2 &&
      ((arg.startsWith('"') && arg.endsWith('"')) ||
        (arg.startsWith("'") && arg.endsWith("'")))
    ) {
      return arg.slice(1, -1);
    }
    return arg;
  });

type TunnelInfo = {
  port: number;
  pid: number;
  url: string;
  binary_path: string;
};

export type TunnelProcessOwnership = 'owned' | 'not_owned' | 'unverified';

type LoadedTunnelInfo = {
  info: TunnelInfo;
  ownership: Exclude<TunnelProcessOwnership, 'not_owned'>;
};

export type TunnelStatus = {
  available: boolean;
  source: 'system' | null;
  path: string | null;
  note: string;
};

export type StartTunnelResult =
  | { url: string; port: number; existing?: boolean }
  | { error: string };

export type ListTunnelsResult = {
  tunnels: Array<{
    port: number;
    url: string;
    ownership: Exclude<TunnelProcessOwnership, 'not_owned'>;
  }>;
  count: number;
};

export type StopTunnelResult =
  | { stopped: number; url: string }
  | { error: string };

export type StopAllTunnelsResult = {
  stopped: number[];
  count: number;
};

export interface TunnelManagerOptions {
  tunnel_dir?: string;
  binary_resolver?: (binary: string) => string | null;
  spawn_impl?: typeof spawn;
  sleep_impl?: (ms: number) => Promise<void>;
  is_process_alive?: (pid: number) => boolean;
  kill_process?: (
    pid: number,
    is_still_owned?: () => boolean
  ) => Promise<boolean>;
  get_process_arguments?: ProcessArgumentsReader;
  /** @deprecated Prefer get_process_arguments so executable boundaries survive. */
  get_process_command_line?: (pid: number) => string | null;
}

export class TunnelManager {
  private readonly tunnel_dir: string;
  private readonly binary_resolver: (binary: string) => string | null;
  private readonly spawn_impl: typeof spawn;
  private readonly sleep_impl: (ms: number) => Promise<void>;
  private readonly is_process_alive_impl: (pid: number) => boolean;
  private readonly kill_process_impl: (
    pid: number,
    is_still_owned?: () => boolean
  ) => Promise<boolean>;
  private readonly get_process_arguments_impl: ProcessArgumentsReader;
  private binary_path: string | null = null;

  constructor(options: TunnelManagerOptions = {}) {
    this.tunnel_dir = options.tunnel_dir ?? DEFAULT_TUNNELS_DIR;
    this.binary_resolver = options.binary_resolver ?? findSystemBinary;
    this.spawn_impl = options.spawn_impl ?? spawn;
    this.sleep_impl = options.sleep_impl ?? sleep;
    this.is_process_alive_impl =
      options.is_process_alive ?? default_is_process_alive;
    this.kill_process_impl =
      options.kill_process ??
      ((pid, isStillOwned) =>
        default_kill_process(pid, isStillOwned, this.sleep_impl));
    this.get_process_arguments_impl = options.get_process_arguments
      ? options.get_process_arguments
      : options.get_process_command_line
        ? (pid) => {
            const commandLine = options.get_process_command_line?.(pid);
            return commandLine ? parseCommandLine(commandLine) : null;
          }
        : getProcessArguments;
  }

  private get_tunnel_file(port: number) {
    return path.join(this.tunnel_dir, `${port}.json`);
  }

  private get_tunnel_log_file(port: number) {
    return path.join(this.tunnel_dir, `${port}.log`);
  }

  private ensure_tunnel_dir() {
    fs.mkdirSync(this.tunnel_dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      fs.chmodSync(this.tunnel_dir, 0o700);
    }
  }

  private create_tunnel_log(logPath: string) {
    fs.rmSync(logPath, { force: true });
    const noFollowFlag =
      process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    return fs.openSync(
      logPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag,
      0o600
    );
  }

  private save_tunnel_info(
    port: number,
    pid: number,
    url: string,
    binaryPath: string
  ) {
    this.ensure_tunnel_dir();
    const targetPath = this.get_tunnel_file(port);
    const serializedInfo = JSON.stringify({
      port,
      pid,
      url,
      binary_path: binaryPath,
    });
    if (Buffer.byteLength(serializedInfo, 'utf8') > MAX_TUNNEL_INFO_BYTES) {
      throw new Error(`Tunnel state exceeds ${MAX_TUNNEL_INFO_BYTES} bytes`);
    }
    const tempPath = path.join(
      this.tunnel_dir,
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    let renamed = false;
    try {
      fs.writeFileSync(tempPath, serializedInfo, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      if (process.platform !== 'win32') {
        fs.chmodSync(tempPath, 0o600);
      }
      fs.renameSync(tempPath, targetPath);
      renamed = true;
      if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o600);
      }
    } finally {
      if (!renamed) {
        fs.rmSync(tempPath, { force: true });
      }
    }
  }

  private remove_tunnel_state(port: number) {
    fs.rmSync(this.get_tunnel_file(port), { force: true });
    fs.rmSync(this.get_tunnel_log_file(port), { force: true });
  }

  private load_tunnel_info(port: number): LoadedTunnelInfo | null {
    const filePath = this.get_tunnel_file(port);
    let parsed: Partial<TunnelInfo> | null;
    try {
      const raw = readBoundedPrivateFile(filePath, MAX_TUNNEL_INFO_BYTES);
      parsed = JSON.parse(raw) as Partial<TunnelInfo> | null;
    } catch {
      this.remove_tunnel_state(port);
      return null;
    }

    if (
      !parsed ||
      parsed.port !== port ||
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.url !== 'string' ||
      typeof parsed.binary_path !== 'string' ||
      parsed.binary_path.trim().length === 0
    ) {
      this.remove_tunnel_state(port);
      return null;
    }

    const info: TunnelInfo = {
      port: parsed.port,
      pid: parsed.pid,
      url: parsed.url,
      binary_path: parsed.binary_path,
    };

    let isAlive: boolean;
    try {
      isAlive = this.is_process_alive_impl(info.pid);
    } catch {
      return { info, ownership: 'unverified' };
    }
    if (!isAlive) {
      this.remove_tunnel_state(port);
      return null;
    }

    const ownership = this.get_tunnel_process_ownership(info);
    if (ownership === 'not_owned') {
      this.remove_tunnel_state(port);
      return null;
    }
    return { info, ownership };
  }

  private get_tunnel_process_ownership(
    info: TunnelInfo
  ): TunnelProcessOwnership {
    let args: string[] | null = null;
    try {
      args = this.get_process_arguments_impl(info.pid);
    } catch {
      return 'unverified';
    }
    if (!args) {
      return 'unverified';
    }

    if (args.length < 4) {
      return 'not_owned';
    }

    const normalizeExecutable = (value: string) => {
      const normalized = path.normalize(value);
      return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
    };
    if (
      normalizeExecutable(args[0]!) !==
      normalizeExecutable(info.binary_path.trim())
    ) {
      return 'not_owned';
    }

    const tunnelIndex = args.indexOf('tunnel', 1);
    if (tunnelIndex < 1) {
      return 'not_owned';
    }

    const expectedUrl = `http://localhost:${info.port}`;
    for (let index = tunnelIndex + 1; index < args.length; index += 1) {
      if (args[index] === '--url' && args[index + 1] === expectedUrl) {
        return 'owned';
      }
      if (args[index] === `--url=${expectedUrl}`) {
        return 'owned';
      }
    }
    return 'not_owned';
  }

  private async cleanup_unpersisted_tunnel(info: TunnelInfo) {
    let terminated = false;
    try {
      terminated = await this.kill_process_impl(
        info.pid,
        () => this.get_tunnel_process_ownership(info) === 'owned'
      );
    } catch {
      // Report the untracked live process below.
    }

    let isAlive = true;
    if (!terminated) {
      try {
        isAlive = this.is_process_alive_impl(info.pid);
      } catch {
        // An unverified process must be treated as live.
      }
    }
    if (terminated || !isAlive) {
      try {
        this.remove_tunnel_state(info.port);
      } catch {
        // The process is stopped; stale files can be cleaned on the next run.
      }
      return true;
    }
    return false;
  }

  get_binary_path() {
    if (this.binary_path) {
      return this.binary_path;
    }

    const systemBinary = this.binary_resolver('cloudflared');
    if (systemBinary) {
      this.binary_path = systemBinary;
      return systemBinary;
    }

    throw new Error(
      'cloudflared not installed.\n\nInstall cloudflared:\n  macOS:   brew install cloudflared\n  Linux:   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared\n  Windows: winget install Cloudflare.cloudflared'
    );
  }

  is_available() {
    if (this.binary_path) {
      return true;
    }
    return Boolean(this.binary_resolver('cloudflared'));
  }

  get_status(): TunnelStatus {
    const systemBinary = this.binary_resolver('cloudflared');
    if (systemBinary) {
      return {
        available: true,
        source: 'system',
        path: systemBinary,
        note: 'cloudflared installed',
      };
    }
    return {
      available: false,
      source: null,
      path: null,
      note: 'cloudflared not installed - install it manually before using tunnel',
    };
  }

  async start_tunnel(port: number): Promise<StartTunnelResult> {
    if (!isValidTunnelPort(port)) {
      return { error: `Invalid port: ${String(port)}` };
    }
    const loaded = this.load_tunnel_info(port);
    if (loaded) {
      if (loaded.ownership === 'unverified') {
        return {
          error: `A live process is recorded for tunnel port ${port}, but its ownership could not be verified; metadata was retained and no new process was started`,
        };
      }
      if (!loaded.info.url) {
        return {
          error: `A previous tunnel launch on port ${port} is still running and requires cleanup; run tunnel stop ${port}`,
        };
      }
      return { url: loaded.info.url, port, existing: true };
    }

    let binaryPath: string;
    try {
      binaryPath = this.get_binary_path();
    } catch (error) {
      return { error: (error as Error).message };
    }

    this.ensure_tunnel_dir();
    const logPath = this.get_tunnel_log_file(port);
    const logFd = this.create_tunnel_log(logPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(logPath, 0o600);
    }
    let logOffset = 0;
    let logContent = '';
    let cleanupArtifactsAfterClose = false;
    const refreshLogContent = () => {
      const stats = fs.fstatSync(logFd);
      if (!stats.isFile()) {
        throw new Error('cloudflared startup log is not a regular file');
      }
      if (stats.size < logOffset) {
        logOffset = 0;
        logContent = '';
      }
      const readableEnd = Math.min(stats.size, MAX_TUNNEL_STARTUP_LOG_BYTES);
      const bytesToRead = readableEnd - logOffset;
      if (bytesToRead > 0) {
        const chunk = Buffer.allocUnsafe(bytesToRead);
        const bytesRead = fs.readSync(logFd, chunk, 0, bytesToRead, logOffset);
        logOffset += bytesRead;
        logContent += chunk.subarray(0, bytesRead).toString('utf8');
      }
      return stats.size > MAX_TUNNEL_STARTUP_LOG_BYTES;
    };
    try {
      const child = this.spawn_impl(
        binaryPath,
        ['tunnel', '--url', `http://localhost:${port}`],
        {
          detached: true,
          stdio: ['ignore', 'ignore', logFd],
        }
      );
      child.unref?.();
      const spawnFailure: { error: Error | null } = { error: null };
      child.once?.('error', (error) => {
        spawnFailure.error =
          error instanceof Error ? error : new Error(String(error));
      });

      const deadline = Date.now() + 15_000;
      let startupFailure: string | null = null;
      while (Date.now() < deadline) {
        const spawnError = spawnFailure.error;
        if (spawnError) {
          return {
            error: `Failed to start cloudflared: ${spawnError.message}`,
          };
        }
        try {
          if (refreshLogContent()) {
            startupFailure = `cloudflared startup log exceeded ${MAX_TUNNEL_STARTUP_LOG_BYTES} bytes`;
            break;
          }
        } catch (error) {
          startupFailure = `Failed to read cloudflared startup log: ${(error as Error).message}`;
          break;
        }
        const pid = child.pid;
        if (typeof pid === 'number' && !this.is_process_alive_impl(pid)) {
          return {
            error: `cloudflared exited unexpectedly: ${logContent.slice(0, 500)}`,
          };
        }

        const match = logContent.match(TUNNEL_URL_PATTERN);
        if (match?.[1] && typeof child.pid === 'number') {
          const info: TunnelInfo = {
            port,
            pid: child.pid,
            url: match[1],
            binary_path: binaryPath,
          };
          try {
            this.save_tunnel_info(port, child.pid, match[1], binaryPath);
          } catch (error) {
            const cleaned = await this.cleanup_unpersisted_tunnel(info);
            cleanupArtifactsAfterClose = cleaned;
            return {
              error: cleaned
                ? `Failed to persist tunnel ownership metadata and stopped process ${child.pid}: ${(error as Error).message}`
                : `Failed to persist tunnel ownership metadata; process ${child.pid} may still be running and is not tracked. Stop it manually: ${(error as Error).message}`,
            };
          }
          return { url: match[1], port };
        }

        await this.sleep_impl(200);
      }

      if (typeof child.pid === 'number') {
        const info: TunnelInfo = {
          port,
          pid: child.pid,
          url: '',
          binary_path: binaryPath,
        };
        let terminated = false;
        try {
          terminated = await this.kill_process_impl(
            child.pid,
            () => this.get_tunnel_process_ownership(info) === 'owned'
          );
        } catch {
          // Preserve ownership metadata below when cleanup can be retried.
        }
        if (
          !terminated &&
          this.is_process_alive_impl(child.pid) &&
          this.get_tunnel_process_ownership(info) !== 'not_owned'
        ) {
          try {
            this.save_tunnel_info(port, child.pid, '', binaryPath);
          } catch (error) {
            const cleaned = await this.cleanup_unpersisted_tunnel(info);
            if (cleaned) {
              cleanupArtifactsAfterClose = true;
              return {
                error:
                  startupFailure ??
                  'Timed out waiting for cloudflare tunnel URL (15s)',
              };
            }
            return {
              error: `${startupFailure ?? 'Timed out waiting for cloudflare tunnel URL (15s)'}; process ${child.pid} may still be running and ownership metadata could not be saved. Stop it manually: ${(error as Error).message}`,
            };
          }
          return {
            error: startupFailure
              ? `${startupFailure} and could not stop process ${child.pid}; run tunnel stop ${port} to retry cleanup`
              : `Timed out waiting for cloudflare tunnel URL and could not stop process ${child.pid}; run tunnel stop ${port} to retry cleanup`,
          };
        }
      }
      return {
        error:
          startupFailure ?? 'Timed out waiting for cloudflare tunnel URL (15s)',
      };
    } finally {
      fs.closeSync(logFd);
      if (cleanupArtifactsAfterClose) {
        try {
          this.remove_tunnel_state(port);
        } catch {
          // The process is already stopped; cleanup can be retried manually.
        }
      }
    }
  }

  list_tunnels(): ListTunnelsResult {
    const tunnels: ListTunnelsResult['tunnels'] = [];
    if (!fs.existsSync(this.tunnel_dir)) {
      return { tunnels, count: 0 };
    }

    for (const entry of fs.readdirSync(this.tunnel_dir)) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const portText = path.basename(entry, '.json');
      if (!/^\d+$/.test(portText)) {
        continue;
      }
      const port = Number(portText);
      if (!isValidTunnelPort(port)) {
        continue;
      }
      const loaded = this.load_tunnel_info(port);
      if (loaded) {
        tunnels.push({
          port: loaded.info.port,
          url: loaded.info.url,
          ownership: loaded.ownership,
        });
      }
    }

    return { tunnels, count: tunnels.length };
  }

  async stop_tunnel(port: number): Promise<StopTunnelResult> {
    if (!isValidTunnelPort(port)) {
      return { error: `Invalid port: ${String(port)}` };
    }
    const loaded = this.load_tunnel_info(port);
    if (!loaded) {
      return { error: `No tunnel running on port ${port}` };
    }
    const { info, ownership } = loaded;
    if (ownership === 'unverified') {
      return {
        error: `Cannot verify ownership of process ${info.pid} for tunnel port ${port}; process was not signaled and metadata was retained`,
      };
    }

    let terminated = false;
    try {
      terminated = await this.kill_process_impl(
        info.pid,
        () => this.get_tunnel_process_ownership(info) === 'owned'
      );
    } catch {
      // Preserve metadata so a later stop attempt can retry.
    }
    if (!terminated && this.is_process_alive_impl(info.pid)) {
      return {
        error: `Failed to stop tunnel on port ${port}; process ${info.pid} is still running`,
      };
    }
    this.remove_tunnel_state(port);
    return {
      stopped: port,
      url: info.url,
    };
  }

  async stop_all_tunnels(): Promise<StopAllTunnelsResult> {
    const stopped: number[] = [];
    if (!fs.existsSync(this.tunnel_dir)) {
      return { stopped, count: 0 };
    }

    for (const entry of fs.readdirSync(this.tunnel_dir)) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const portText = path.basename(entry, '.json');
      if (!/^\d+$/.test(portText)) {
        continue;
      }
      const port = Number(portText);
      if (!isValidTunnelPort(port)) {
        continue;
      }
      const result = await this.stop_tunnel(port);
      if ('stopped' in result) {
        stopped.push(result.stopped);
      }
    }

    return {
      stopped,
      count: stopped.length,
    };
  }
}

const default_is_process_alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const default_kill_process = async (
  pid: number,
  is_still_owned: (() => boolean) | undefined,
  sleep_impl: (ms: number) => Promise<void>
) => {
  if (is_still_owned && !is_still_owned()) {
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!default_is_process_alive(pid)) {
      return true;
    }
    await sleep_impl(100);
  }

  if (is_still_owned && !is_still_owned()) {
    return false;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!default_is_process_alive(pid)) {
      return true;
    }
    await sleep_impl(100);
  }
  return false;
};

let tunnel_manager: TunnelManager | null = null;

export const get_tunnel_manager = () => {
  if (!tunnel_manager) {
    tunnel_manager = new TunnelManager();
  }
  return tunnel_manager;
};
