import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Browsers launched by tests must not download the default extensions
    // from the Chrome Web Store or depend on the user's extension cache.
    env: { BROWSER_USE_DISABLE_EXTENSIONS: '1' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
