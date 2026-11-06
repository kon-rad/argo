import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The suite must be hermetic. It runs from inside someone's vault as often as
// from a standalone engine checkout, and config.ts reads VAULT_ROOT/.env and
// VAULT_ROOT/secondbrain.json at import. Left unset, VAULT_ROOT resolves to the
// surrounding vault, so the developer's own settings and secrets leak into every
// test and make results depend on which machine ran them.
//
// Pin VAULT_ROOT to the engine repo (what a standalone checkout already defaults
// to, i.e. what CI runs against) and pin DEPLOYMENT to local, so an ambient
// DEPLOYMENT=server cannot switch the login on and change route behaviour
// (a route that 404s as "no such endpoint" becomes a session-gated 401 instead).
const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'desk',
          root: './server',
          environment: 'node',
          include: [
            'src/addons/desk/settlement/arc*.test.ts',
            'src/addons/desk/boot.test.ts',
            'src/addons/desk/public-api.test.ts',
            'src/addons/desk/orchestration/payment-gate.test.ts',
            'src/addons/desk/persistence/persistence.test.ts',
          ],
          env: { VAULT_ROOT: engineRoot, DEPLOYMENT: 'local' },
        },
      },
      {
        test: {
          name: 'server',
          root: './server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          globalSetup: ['./test/globalSetup.ts'],
          // Clear ambient board settings before any test imports config (test/hermetic.ts).
          setupFiles: ['./test/hermetic.ts'],
          // Existing route tests exercise the optional modules; modules.test.ts turns them off itself.
          env: { MODULES: 'ring,agents', RING_PULL_SSH_HOST: 'test-host', VAULT_ROOT: engineRoot, DEPLOYMENT: 'local' },
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
