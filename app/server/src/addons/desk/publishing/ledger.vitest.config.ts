import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root: here, test: { environment: 'node', include: ['ledger.integration.test.ts'], env: { VAULT_ROOT: resolve(here, '../../../../../'), DEPLOYMENT: 'local' } } });
