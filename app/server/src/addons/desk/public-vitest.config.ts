import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const engineRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
export default defineConfig({ test: {
  include: ['server/src/addons/desk/public-api.test.ts', 'server/src/addons/desk/orchestration/payment-gate.test.ts'],
  environment: 'node', env: { VAULT_ROOT: engineRoot, DEPLOYMENT: 'local' },
} });
