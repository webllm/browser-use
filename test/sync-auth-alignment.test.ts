import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceAuthClient,
  load_cloud_auth_config,
  MAX_CLOUD_AUTH_FILE_BYTES,
  save_cloud_api_token,
} from '../src/sync/auth.js';

describe('DeviceAuthClient alignment', () => {
  const originalConfigDir = process.env.BROWSER_USE_CONFIG_DIR;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'browser-use-sync-auth-'));
    process.env.BROWSER_USE_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.BROWSER_USE_CONFIG_DIR;
    } else {
      process.env.BROWSER_USE_CONFIG_DIR = originalConfigDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('sends empty agent_session_id when none is provided', async () => {
    const post = vi.fn(
      async (
        _url?: string,
        _form?: URLSearchParams,
        _config?: Record<string, unknown>
      ) => ({
        data: {},
      })
    );
    const client = new DeviceAuthClient('https://api.example.com', {
      post,
    } as any);

    await client.start_device_authorization(null);

    expect(post).toHaveBeenCalled();
    const form = post.mock.calls[0]?.[1];
    expect(form).toBeInstanceOf(URLSearchParams);
    const params = form as URLSearchParams;
    expect(params.get('agent_session_id')).toBe('');
    expect(post.mock.calls[0]?.[2]).toMatchObject({ maxRedirects: 0 });
  });

  it('clear_auth removes cloud auth file instead of writing empty values', async () => {
    const authFile = path.join(tempDir, 'cloud_auth.json');
    await writeFile(
      authFile,
      JSON.stringify({
        api_token: 'token',
        user_id: 'user',
        authorized_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8'
    );
    const client = new DeviceAuthClient('https://api.example.com', {
      post: vi.fn(async () => ({ data: {} })),
    } as any);

    expect(fs.existsSync(authFile)).toBe(true);
    client.clear_auth();
    expect(fs.existsSync(authFile)).toBe(false);
  });

  it('stores cloud auth and device id files with private permissions', () => {
    save_cloud_api_token('bu_saved_token', 'user-1');
    const client = new DeviceAuthClient('https://api.example.com', {
      post: vi.fn(async () => ({ data: {} })),
    } as any);

    expect(client.device_id).toBeTruthy();
    const authFile = path.join(tempDir, 'cloud_auth.json');
    const deviceIdFile = path.join(tempDir, 'device_id');
    expect(fs.existsSync(authFile)).toBe(true);
    expect(fs.existsSync(deviceIdFile)).toBe(true);

    if (process.platform !== 'win32') {
      expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(deviceIdFile).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects oversized and non-object cloud auth state', () => {
    const authFile = path.join(tempDir, 'cloud_auth.json');
    fs.writeFileSync(authFile, '[]');
    expect(load_cloud_auth_config()).toEqual({
      api_token: null,
      user_id: null,
      authorized_at: null,
    });

    fs.truncateSync(authFile, MAX_CLOUD_AUTH_FILE_BYTES + 1);
    expect(load_cloud_auth_config()).toEqual({
      api_token: null,
      user_id: null,
      authorized_at: null,
    });
  });

  it('replaces auth state atomically without following destination symlinks', () => {
    if (process.platform === 'win32') return;
    const authFile = path.join(tempDir, 'cloud_auth.json');
    const targetFile = path.join(tempDir, 'unrelated.json');
    fs.writeFileSync(targetFile, 'do-not-overwrite');
    fs.symlinkSync(targetFile, authFile);

    expect(load_cloud_auth_config().api_token).toBeNull();
    save_cloud_api_token('replacement-token', 'user-1');

    expect(fs.readFileSync(targetFile, 'utf8')).toBe('do-not-overwrite');
    expect(fs.lstatSync(authFile).isSymbolicLink()).toBe(false);
    expect(load_cloud_auth_config().api_token).toBe('replacement-token');
  });

  it('preserves existing auth state when atomic replacement fails', () => {
    save_cloud_api_token('old-token', 'user-1');
    const authFile = path.join(tempDir, 'cloud_auth.json');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('injected rename failure');
    });

    try {
      expect(() => save_cloud_api_token('new-token', 'user-2')).toThrow(
        'injected rename failure'
      );
    } finally {
      rename.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(authFile, 'utf8')).api_token).toBe(
      'old-token'
    );
    expect(
      fs.readdirSync(tempDir).filter((entry) => entry.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('repairs invalid device ID files without following symlinks', () => {
    if (process.platform === 'win32') return;
    const deviceIdFile = path.join(tempDir, 'device_id');
    const targetFile = path.join(tempDir, 'unrelated-device');
    fs.writeFileSync(targetFile, 'do-not-overwrite');
    fs.symlinkSync(targetFile, deviceIdFile);

    const client = new DeviceAuthClient('https://api.example.com', {
      post: vi.fn(async () => ({ data: {} })),
    } as any);

    expect(client.device_id).toBeTruthy();
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('do-not-overwrite');
    expect(fs.lstatSync(deviceIdFile).isSymbolicLink()).toBe(false);
  });
});
