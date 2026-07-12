import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getProcessCommandLine } from './process-identity.js';

const TUNNEL_URL_PATTERN = /(https:\/\/\S+\.trycloudflare\.com)/;
const DEFAULT_TUNNELS_DIR = path.join(os.homedir(), '.browser-use', 'tunnels');

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
  tunnels: Array<{ port: number; url: string }>;
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
  kill_process?: (pid: number) => Promise<boolean>;
  get_process_command_line?: (pid: number) => string | null;
}

export class TunnelManager {
  private readonly tunnel_dir: string;
  private readonly binary_resolver: (binary: string) => string | null;
  private readonly spawn_impl: typeof spawn;
  private readonly sleep_impl: (ms: number) => Promise<void>;
  private readonly is_process_alive_impl: (pid: number) => boolean;
  private readonly kill_process_impl: (pid: number) => Promise<boolean>;
  private readonly get_process_command_line_impl: (
    pid: number
  ) => string | null;
  private binary_path: string | null = null;

  constructor(options: TunnelManagerOptions = {}) {
    this.tunnel_dir = options.tunnel_dir ?? DEFAULT_TUNNELS_DIR;
    this.binary_resolver = options.binary_resolver ?? findSystemBinary;
    this.spawn_impl = options.spawn_impl ?? spawn;
    this.sleep_impl = options.sleep_impl ?? sleep;
    this.is_process_alive_impl =
      options.is_process_alive ?? default_is_process_alive;
    this.kill_process_impl = options.kill_process ?? default_kill_process;
    this.get_process_command_line_impl =
      options.get_process_command_line ?? getProcessCommandLine;
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

  private save_tunnel_info(
    port: number,
    pid: number,
    url: string,
    binaryPath: string
  ) {
    this.ensure_tunnel_dir();
    fs.writeFileSync(
      this.get_tunnel_file(port),
      JSON.stringify({ port, pid, url, binary_path: binaryPath }),
      { encoding: 'utf-8', mode: 0o600 }
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(this.get_tunnel_file(port), 0o600);
    }
  }

  private load_tunnel_info(port: number): TunnelInfo | null {
    const filePath = this.get_tunnel_file(port);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, 'utf-8')
      ) as Partial<TunnelInfo> | null;
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
        fs.rmSync(filePath, { force: true });
        return null;
      }

      const info: TunnelInfo = {
        port: parsed.port,
        pid: parsed.pid,
        url: parsed.url,
        binary_path: parsed.binary_path,
      };

      if (
        !this.is_process_alive_impl(info.pid) ||
        !this.is_owned_tunnel_process(info)
      ) {
        fs.rmSync(filePath, { force: true });
        fs.rmSync(this.get_tunnel_log_file(port), { force: true });
        return null;
      }

      return info;
    } catch {
      fs.rmSync(filePath, { force: true });
      return null;
    }
  }

  private is_owned_tunnel_process(info: TunnelInfo) {
    const commandLine = this.get_process_command_line_impl(info.pid);
    if (!commandLine) {
      return false;
    }

    const args = parseCommandLine(commandLine);
    if (args.length < 4) {
      return false;
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
      return false;
    }

    const tunnelIndex = args.indexOf('tunnel', 1);
    if (tunnelIndex < 1) {
      return false;
    }

    const expectedUrl = `http://localhost:${info.port}`;
    for (let index = tunnelIndex + 1; index < args.length; index += 1) {
      if (args[index] === '--url' && args[index + 1] === expectedUrl) {
        return true;
      }
      if (args[index] === `--url=${expectedUrl}`) {
        return true;
      }
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
    const existing = this.load_tunnel_info(port);
    if (existing) {
      return { url: existing.url, port, existing: true };
    }

    let binaryPath: string;
    try {
      binaryPath = this.get_binary_path();
    } catch (error) {
      return { error: (error as Error).message };
    }

    this.ensure_tunnel_dir();
    const logPath = this.get_tunnel_log_file(port);
    const logFd = fs.openSync(logPath, 'w', 0o600);
    if (process.platform !== 'win32') {
      fs.chmodSync(logPath, 0o600);
    }
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

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const pid = child.pid;
        if (typeof pid === 'number' && !this.is_process_alive_impl(pid)) {
          const content = fs.existsSync(logPath)
            ? fs.readFileSync(logPath, 'utf-8')
            : '';
          return {
            error: `cloudflared exited unexpectedly: ${content.slice(0, 500)}`,
          };
        }

        const content = fs.existsSync(logPath)
          ? fs.readFileSync(logPath, 'utf-8')
          : '';
        const match = content.match(TUNNEL_URL_PATTERN);
        if (match?.[1] && typeof child.pid === 'number') {
          this.save_tunnel_info(port, child.pid, match[1], binaryPath);
          return { url: match[1], port };
        }

        await this.sleep_impl(200);
      }

      if (typeof child.pid === 'number') {
        await this.kill_process_impl(child.pid);
      }
      return { error: 'Timed out waiting for cloudflare tunnel URL (15s)' };
    } finally {
      fs.closeSync(logFd);
    }
  }

  list_tunnels(): ListTunnelsResult {
    const tunnels: Array<{ port: number; url: string }> = [];
    if (!fs.existsSync(this.tunnel_dir)) {
      return { tunnels, count: 0 };
    }

    for (const entry of fs.readdirSync(this.tunnel_dir)) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const port = Number.parseInt(path.basename(entry, '.json'), 10);
      if (!Number.isFinite(port)) {
        continue;
      }
      const info = this.load_tunnel_info(port);
      if (info) {
        tunnels.push({ port: info.port, url: info.url });
      }
    }

    return { tunnels, count: tunnels.length };
  }

  async stop_tunnel(port: number): Promise<StopTunnelResult> {
    const info = this.load_tunnel_info(port);
    if (!info) {
      return { error: `No tunnel running on port ${port}` };
    }

    await this.kill_process_impl(info.pid);
    fs.rmSync(this.get_tunnel_file(port), { force: true });
    fs.rmSync(this.get_tunnel_log_file(port), { force: true });
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
      const port = Number.parseInt(path.basename(entry, '.json'), 10);
      if (!Number.isFinite(port)) {
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
  } catch {
    return false;
  }
};

const default_kill_process = async (pid: number) => {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!default_is_process_alive(pid)) {
      return true;
    }
    await sleep(100);
  }

  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
};

let tunnel_manager: TunnelManager | null = null;

export const get_tunnel_manager = () => {
  if (!tunnel_manager) {
    tunnel_manager = new TunnelManager();
  }
  return tunnel_manager;
};
