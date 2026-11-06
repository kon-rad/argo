import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../../../../../');
export default defineConfig({ root: here, test: { environment: 'node', include: ['persistence.test.ts'], env: { VAULT_ROOT: appRoot, DEPLOYMENT: 'local' } } });
