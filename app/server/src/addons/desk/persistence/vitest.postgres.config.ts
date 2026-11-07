import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['postgres.integration.test.ts'],
    env: { VAULT_ROOT: fileURLToPath(new URL('../../../../../..', import.meta.url)), DEPLOYMENT: 'local' },
  },
});
