import { describe, expect, it, vi } from 'vitest';
import { runCliEntry } from '../src/cli-entry.js';

const outputCollector = () => {
  let value = '';
  return {
    stream: {
      write(chunk: string) {
        value += chunk;
      },
    },
    value: () => value,
  };
};

describe('CLI lightweight entrypoint', () => {
  it.each([['--help'], ['-h']])(
    'prints %s without loading the full CLI',
    async (flag) => {
      const output = outputCollector();
      const loadCli = vi.fn();

      await runCliEntry([flag], {
        loadCli,
        stdout: output.stream,
      });

      expect(loadCli).not.toHaveBeenCalled();
      expect(output.value()).toContain('Usage:');
      expect(output.value()).toContain('browser-use --mcp');
    }
  );

  it('prints the package version without loading the full CLI', async () => {
    const output = outputCollector();
    const loadCli = vi.fn();

    await runCliEntry(['--version'], {
      loadCli,
      readVersion: () => '1.2.3-test',
      stdout: output.stream,
    });

    expect(loadCli).not.toHaveBeenCalled();
    expect(output.value()).toBe('1.2.3-test\n');
  });

  it('loads and forwards non-trivial commands once', async () => {
    const main = vi.fn(async () => undefined);
    const loadCli = vi.fn(async () => ({ main }));

    await runCliEntry(['doctor'], { loadCli });

    expect(loadCli).toHaveBeenCalledOnce();
    expect(main).toHaveBeenCalledWith(['doctor']);
  });
});
