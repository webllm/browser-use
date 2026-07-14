import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runTunnelCommand } from '../src/cli.js';
import { TunnelManager } from '../src/skill-cli/tunnel.js';

const createWritable = () => {
  let buffer = '';
  return {
    stream: {
      write(chunk: string) {
        buffer += chunk;
      },
    },
    read() {
      return buffer;
    },
  };
};

describe('skill-cli tunnel alignment', () => {
  it('routes tunnel CLI lifecycle commands through the manager', async () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const manager = {
      start_tunnel: vi.fn(async () => ({
        port: 3000,
        url: 'https://demo.trycloudflare.com',
      })),
      list_tunnels: vi.fn(() => ({
        tunnels: [
          {
            port: 3000,
            url: 'https://demo.trycloudflare.com',
            ownership: 'owned' as const,
          },
        ],
        count: 1,
      })),
      stop_tunnel: vi.fn(async () => ({
        stopped: 3000,
        url: 'https://demo.trycloudflare.com',
      })),
      stop_all_tunnels: vi.fn(async () => ({
        stopped: [3000],
        count: 1,
      })),
    };

    expect(
      await runTunnelCommand(['3000'], {
        manager,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).toBe(0);
    expect(
      await runTunnelCommand(['list'], {
        manager,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).toBe(0);
    expect(
      await runTunnelCommand(['stop', '3000'], {
        manager,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).toBe(0);
    expect(
      await runTunnelCommand(['stop', '--all'], {
        manager,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).toBe(0);

    expect(manager.start_tunnel).toHaveBeenCalledWith(3000);
    expect(manager.list_tunnels).toHaveBeenCalledTimes(1);
    expect(manager.stop_tunnel).toHaveBeenCalledWith(3000);
    expect(manager.stop_all_tunnels).toHaveBeenCalledTimes(1);
    expect(stdout.read()).toContain('Tunnel started: http://localhost:3000');
    expect(stdout.read()).toContain('3000: https://demo.trycloudflare.com');
    expect(stdout.read()).toContain('Stopped tunnel on port 3000');
    expect(stdout.read()).toContain('Stopped 1 tunnel(s): 3000');
    expect(stderr.read()).toBe('');
  });

  it('returns JSON output and propagates manager errors', async () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const manager = {
      start_tunnel: vi.fn(async () => ({
        error: 'cloudflared not installed',
      })),
      list_tunnels: vi.fn(() => ({ tunnels: [], count: 0 })),
      stop_tunnel: vi.fn(),
      stop_all_tunnels: vi.fn(),
    };

    expect(
      await runTunnelCommand(['list'], {
        manager,
        stdout: stdout.stream,
        stderr: stderr.stream,
        json_output: true,
      })
    ).toBe(0);
    expect(
      await runTunnelCommand(['8080'], {
        manager,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).toBe(1);

    expect(stdout.read()).toContain('"count": 0');
    expect(stderr.read()).toContain('cloudflared not installed');
  });

  it('drops stale persisted tunnels when the process is no longer alive', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    fs.writeFileSync(
      path.join(tunnelDir, '3000.json'),
      JSON.stringify({
        port: 3000,
        pid: 12345,
        url: 'https://stale.trycloudflare.com',
        binary_path: '/usr/bin/cloudflared',
      }),
      'utf-8'
    );

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        is_process_alive: () => false,
      });
      const result = manager.list_tunnels();

      expect(result).toEqual({ tunnels: [], count: 0 });
      expect(fs.existsSync(path.join(tunnelDir, '3000.json'))).toBe(false);
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('retains live tunnel state when process ownership cannot be inspected', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const infoPath = path.join(tunnelDir, '3000.json');
    const logPath = path.join(tunnelDir, '3000.log');
    const killProcessSpy = vi.fn(async () => true);
    const binaryResolver = vi.fn(() => '/usr/bin/cloudflared');
    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        port: 3000,
        pid: 4321,
        url: 'https://demo.trycloudflare.com',
        binary_path: '/usr/bin/cloudflared',
      }),
      'utf8'
    );
    fs.writeFileSync(logPath, 'tunnel log', 'utf8');

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        binary_resolver: binaryResolver,
        is_process_alive: () => true,
        get_process_command_line: () => null,
        kill_process: killProcessSpy,
      });
      const stdout = createWritable();
      const stderr = createWritable();

      expect(manager.list_tunnels()).toEqual({
        tunnels: [
          {
            port: 3000,
            url: 'https://demo.trycloudflare.com',
            ownership: 'unverified',
          },
        ],
        count: 1,
      });
      await expect(
        runTunnelCommand(['list'], {
          manager,
          stdout: stdout.stream,
          stderr: stderr.stream,
        })
      ).resolves.toBe(0);
      expect(stdout.read()).toContain(
        '3000: https://demo.trycloudflare.com (ownership unverified; state retained)'
      );
      expect(stderr.read()).toBe('');
      await expect(manager.start_tunnel(3000)).resolves.toEqual({
        error:
          'A live process is recorded for tunnel port 3000, but its ownership could not be verified; metadata was retained and no new process was started',
      });
      await expect(manager.stop_tunnel(3000)).resolves.toEqual({
        error:
          'Cannot verify ownership of process 4321 for tunnel port 3000; process was not signaled and metadata was retained',
      });

      expect(killProcessSpy).not.toHaveBeenCalled();
      expect(binaryResolver).not.toHaveBeenCalled();
      expect(fs.existsSync(infoPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('stores tunnel metadata and logs with private permissions', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const logPath = path.join(tunnelDir, '3000.log');
    const infoPath = path.join(tunnelDir, '3000.json');
    const spawnImpl = vi.fn(() => {
      fs.writeFileSync(logPath, 'https://demo.trycloudflare.com');
      return {
        pid: 4321,
        unref: vi.fn(),
      } as any;
    });

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        binary_resolver: () => '/usr/bin/cloudflared',
        spawn_impl: spawnImpl as any,
        is_process_alive: () => true,
        get_process_command_line: () =>
          '/usr/bin/cloudflared tunnel --url http://localhost:3000',
        sleep_impl: vi.fn(async () => {}),
      });

      await expect(manager.start_tunnel(3000)).resolves.toEqual({
        port: 3000,
        url: 'https://demo.trycloudflare.com',
      });
      expect(fs.existsSync(infoPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(infoPath, 'utf8'))).toMatchObject({
        port: 3000,
        pid: 4321,
        binary_path: '/usr/bin/cloudflared',
      });
      expect(manager.list_tunnels()).toEqual({
        tunnels: [
          {
            port: 3000,
            url: 'https://demo.trycloudflare.com',
            ownership: 'owned',
          },
        ],
        count: 1,
      });

      if (process.platform !== 'win32') {
        expect(fs.statSync(tunnelDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(infoPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('returns cloudflared spawn errors instead of crashing the process', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      unref: ReturnType<typeof vi.fn>;
    };
    child.unref = vi.fn();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn EACCES')));
      return child as any;
    });

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        binary_resolver: () => '/usr/bin/cloudflared',
        spawn_impl: spawnImpl as any,
        sleep_impl: async () => {
          await Promise.resolve();
        },
      });

      await expect(manager.start_tunnel(3000)).resolves.toEqual({
        error: 'Failed to start cloudflared: spawn EACCES',
      });
      expect(child.unref).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('retains ownership metadata when a timed-out tunnel cannot be stopped', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const infoPath = path.join(tunnelDir, '3000.json');
    const spawnImpl = vi.fn(
      () =>
        ({
          pid: 4321,
          unref: vi.fn(),
        }) as any
    );
    const killProcess = vi.fn(async () => false);
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        binary_resolver: () => '/usr/bin/cloudflared',
        spawn_impl: spawnImpl as any,
        sleep_impl: async (ms) => {
          now += ms;
        },
        is_process_alive: () => true,
        get_process_command_line: () =>
          '/usr/bin/cloudflared tunnel --url http://localhost:3000',
        kill_process: killProcess,
      });

      await expect(manager.start_tunnel(3000)).resolves.toEqual({
        error:
          'Timed out waiting for cloudflare tunnel URL and could not stop process 4321; run tunnel stop 3000 to retry cleanup',
      });
      expect(killProcess).toHaveBeenCalledWith(4321, expect.any(Function));
      expect(JSON.parse(fs.readFileSync(infoPath, 'utf8'))).toEqual({
        port: 3000,
        pid: 4321,
        url: '',
        binary_path: '/usr/bin/cloudflared',
      });
      await expect(manager.start_tunnel(3000)).resolves.toEqual({
        error:
          'A previous tunnel launch on port 3000 is still running and requires cleanup; run tunnel stop 3000',
      });
    } finally {
      nowSpy.mockRestore();
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('stops a persisted tunnel only when its process signature matches', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const infoPath = path.join(tunnelDir, '3000.json');
    const logPath = path.join(tunnelDir, '3000.log');
    const binaryPath = '/opt/Cloudflare Bin/cloudflared';
    const killProcessSpy = vi.fn(async () => true);
    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        port: 3000,
        pid: 4321,
        url: 'https://demo.trycloudflare.com',
        binary_path: binaryPath,
      }),
      'utf8'
    );
    fs.writeFileSync(logPath, 'tunnel log', 'utf8');

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        is_process_alive: () => true,
        get_process_arguments: () => [
          binaryPath,
          'tunnel',
          '--url',
          'http://localhost:3000',
        ],
        kill_process: killProcessSpy,
      });

      await expect(manager.stop_tunnel(3000)).resolves.toEqual({
        stopped: 3000,
        url: 'https://demo.trycloudflare.com',
      });
      expect(killProcessSpy).toHaveBeenCalledWith(4321, expect.any(Function));
      expect(fs.existsSync(infoPath)).toBe(false);
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'preserves exact executable boundaries when tunnel paths contain spaces',
    async () => {
      const tunnelDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'browser-use-tunnel-')
      );
      const infoPath = path.join(tunnelDir, '3000.json');
      const logPath = path.join(tunnelDir, '3000.log');
      const binaryPath = path.join(tunnelDir, 'cloud flare');
      const child = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(() => {}, 1000)',
          'tunnel',
          '--url',
          'http://localhost:3000',
        ],
        {
          argv0: binaryPath,
          stdio: 'ignore',
        }
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      fs.writeFileSync(
        infoPath,
        JSON.stringify({
          port: 3000,
          pid: child.pid,
          url: 'https://demo.trycloudflare.com',
          binary_path: binaryPath,
        }),
        'utf8'
      );
      fs.writeFileSync(logPath, 'tunnel log', 'utf8');
      const killProcessSpy = vi.fn(async () => true);

      try {
        const manager = new TunnelManager({
          tunnel_dir: tunnelDir,
          kill_process: killProcessSpy,
        });

        await expect(manager.stop_tunnel(3000)).resolves.toEqual({
          stopped: 3000,
          url: 'https://demo.trycloudflare.com',
        });
        expect(killProcessSpy).toHaveBeenCalledWith(
          child.pid,
          expect.any(Function)
        );
        expect(fs.existsSync(infoPath)).toBe(false);
        expect(fs.existsSync(logPath)).toBe(false);

        const expectedPrefix = path.join(tunnelDir, 'cloud');
        fs.writeFileSync(
          infoPath,
          JSON.stringify({
            port: 3000,
            pid: child.pid,
            url: 'https://stale.trycloudflare.com',
            binary_path: expectedPrefix,
          }),
          'utf8'
        );
        fs.writeFileSync(logPath, 'stale tunnel log', 'utf8');
        const wrongProcessKillSpy = vi.fn(async () => true);
        const staleManager = new TunnelManager({
          tunnel_dir: tunnelDir,
          kill_process: wrongProcessKillSpy,
        });

        await expect(staleManager.stop_tunnel(3000)).resolves.toEqual({
          error: 'No tunnel running on port 3000',
        });
        expect(wrongProcessKillSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(infoPath)).toBe(false);
        expect(fs.existsSync(logPath)).toBe(false);
      } finally {
        if (child.exitCode == null && child.pid) {
          const exited = new Promise<void>((resolve) =>
            child.once('exit', () => resolve())
          );
          child.kill('SIGKILL');
          await exited;
        }
        fs.rmSync(tunnelDir, { recursive: true, force: true });
      }
    }
  );

  it('does not terminate a reused PID with a different process signature', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const infoPath = path.join(tunnelDir, '3000.json');
    const logPath = path.join(tunnelDir, '3000.log');
    const killProcessSpy = vi.fn(async () => true);
    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        port: 3000,
        pid: 4321,
        url: 'https://stale.trycloudflare.com',
        binary_path: '/usr/bin/cloudflared',
      }),
      'utf8'
    );
    fs.writeFileSync(logPath, 'stale tunnel log', 'utf8');

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        is_process_alive: () => true,
        get_process_command_line: () => '/usr/bin/sleep 30',
        kill_process: killProcessSpy,
      });

      await expect(manager.stop_tunnel(3000)).resolves.toEqual({
        error: 'No tunnel running on port 3000',
      });
      expect(killProcessSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(infoPath)).toBe(false);
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('rechecks tunnel ownership before escalating to SIGKILL', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const infoPath = path.join(tunnelDir, '3000.json');
    const logPath = path.join(tunnelDir, '3000.log');
    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        port: 3000,
        pid: 4321,
        url: 'https://demo.trycloudflare.com',
        binary_path: '/usr/bin/cloudflared',
      }),
      'utf8'
    );
    fs.writeFileSync(logPath, 'tunnel log', 'utf8');
    const getProcessCommandLine = vi
      .fn()
      .mockReturnValueOnce(
        '/usr/bin/cloudflared tunnel --url http://localhost:3000'
      )
      .mockReturnValueOnce(
        '/usr/bin/cloudflared tunnel --url http://localhost:3000'
      )
      .mockReturnValue('/usr/bin/sleep 30');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        is_process_alive: () => true,
        get_process_command_line: getProcessCommandLine,
        sleep_impl: vi.fn(async () => {}),
      });

      await expect(manager.stop_tunnel(3000)).resolves.toEqual({
        error:
          'Failed to stop tunnel on port 3000; process 4321 is still running',
      });
      expect(killSpy).toHaveBeenCalledWith(4321, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(4321, 'SIGKILL');
      expect(fs.existsSync(infoPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      killSpy.mockRestore();
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });

  it('retains tunnel metadata when process termination fails', async () => {
    const tunnelDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-tunnel-')
    );
    const infoPath = path.join(tunnelDir, '3000.json');
    const logPath = path.join(tunnelDir, '3000.log');
    fs.writeFileSync(
      infoPath,
      JSON.stringify({
        port: 3000,
        pid: 4321,
        url: 'https://demo.trycloudflare.com',
        binary_path: '/usr/bin/cloudflared',
      }),
      'utf8'
    );
    fs.writeFileSync(logPath, 'tunnel log', 'utf8');

    try {
      const manager = new TunnelManager({
        tunnel_dir: tunnelDir,
        is_process_alive: () => true,
        get_process_command_line: () =>
          '/usr/bin/cloudflared tunnel --url http://localhost:3000',
        kill_process: vi.fn(async () => false),
      });

      await expect(manager.stop_tunnel(3000)).resolves.toEqual({
        error:
          'Failed to stop tunnel on port 3000; process 4321 is still running',
      });
      expect(fs.existsSync(infoPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  });
});
