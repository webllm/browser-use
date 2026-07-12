import { describe, expect, it, vi } from 'vitest';

const PROCESS_EVENTS = [
  'SIGINT',
  'SIGTERM',
  'exit',
  'uncaughtException',
  'unhandledRejection',
] as const;

describe('Playwright manager process integration', () => {
  it('does not install process-wide handlers when imported', async () => {
    const originalListeners = new Map(
      PROCESS_EVENTS.map((event) => [event, process.listeners(event)])
    );

    try {
      vi.resetModules();
      await import('../src/browser/playwright-manager.js');

      for (const event of PROCESS_EVENTS) {
        expect(process.listeners(event)).toEqual(originalListeners.get(event));
      }
    } finally {
      for (const event of PROCESS_EVENTS) {
        const originals = originalListeners.get(event) ?? [];
        for (const listener of process.listeners(event)) {
          if (!originals.includes(listener)) {
            process.removeListener(event, listener);
          }
        }
      }
    }
  });
});
