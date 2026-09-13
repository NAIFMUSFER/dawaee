import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // apps/mobile was absent from this list, so the app had no tests at all —
    // which is how a notification handler that nothing called, and a push
    // token that was never registered, both survived to production.
    include: [
      'packages/**/*.test.ts', 'apps/api/**/*.test.ts',
      'apps/worker/**/*.test.ts', 'apps/mobile/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Build ignored web artifacts before any server/route inventory starts.
    globalSetup: ['./vitest.global-setup.ts'],
    // Integration suites share one Postgres database, so they run serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@dawaee/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@dawaee/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@dawaee/api/config': resolve(__dirname, 'apps/api/src/config.ts'),
      '@dawaee/api/providers': resolve(__dirname, 'apps/api/src/providers/index.ts'),
      '@dawaee/api/services/materializer': resolve(__dirname, 'apps/api/src/services/materializer.ts'),
    },
  },
});
