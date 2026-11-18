import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Pure usage regressions remain runnable on collectors without a Postgres service.
export default defineConfig({
  test: {
    include: [
      'server/test/codex-parser.test.ts',
      'server/test/archive-redact.test.ts',
      'server/test/usage-claude.test.ts',
      'server/test/usage-parsers.test.ts',
    ],
    env: { VAULT_ROOT: resolve(import.meta.dirname, '..'), DEPLOYMENT: 'local' },
  },
});
