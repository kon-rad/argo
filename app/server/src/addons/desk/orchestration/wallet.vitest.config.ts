import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/src/addons/desk/orchestration/wallet.test.ts'], environment: 'node', env: { VAULT_ROOT: '/tmp/desk-wallet-test', DEPLOYMENT: 'local', NODE_ENV: 'test' } } });
