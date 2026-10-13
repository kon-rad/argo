import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root: './server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          globalSetup: ['./test/globalSetup.ts'],
          // Existing route tests exercise the optional modules; modules.test.ts turns them off itself.
          env: { MODULES: 'ring,agents', RING_PULL_SSH_HOST: 'test-host' },
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
      {
        test: {
          name: 'web',
          root: './web',
          environment: 'jsdom',
          include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        },
      },
    ],
  },
});
