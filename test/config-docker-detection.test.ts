import { describe, expect, it, vi } from 'vitest';
import { detect_container_environment } from '../src/config.js';

const noContainerFiles = () => false;

describe('container environment detection', () => {
  it('does not infer a container from an ordinary minimal Linux host', () => {
    const readFileSync = vi.fn(() =>
      ['0::/user.slice/user-1000.slice/session-2.scope', ''].join('\n')
    );

    expect(
      detect_container_environment({
        platform: 'linux',
        env: {},
        existsSync: noContainerFiles,
        readFileSync,
      })
    ).toBe(false);
    expect(readFileSync).not.toHaveBeenCalledWith(
      '/proc/1/cmdline',
      expect.anything()
    );
  });

  it.each([
    '0::/docker/0123456789abcdef',
    '0::/kubepods.slice/kubepods-burstable.slice/pod.scope',
    '0::/machine.slice/libpod-012345.scope',
  ])('recognizes container cgroup evidence: %s', (cgroup) => {
    expect(
      detect_container_environment({
        platform: 'linux',
        env: {},
        existsSync: noContainerFiles,
        readFileSync: () => cgroup,
      })
    ).toBe(true);
  });

  it('recognizes explicit container runtime evidence', () => {
    expect(
      detect_container_environment({
        platform: 'linux',
        env: { container: 'podman' },
        existsSync: noContainerFiles,
        readFileSync: () => '',
      })
    ).toBe(true);
    expect(
      detect_container_environment({
        platform: 'linux',
        env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
        existsSync: noContainerFiles,
        readFileSync: () => '',
      })
    ).toBe(true);
  });

  it('ignores Linux-specific markers on other platforms', () => {
    expect(
      detect_container_environment({
        platform: 'darwin',
        env: { container: 'docker' },
        existsSync: () => true,
        readFileSync: () => 'docker',
      })
    ).toBe(false);
  });
});
