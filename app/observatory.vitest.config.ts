// Fixture-only checks remain runnable without PostgreSQL. The regular suite also includes them.
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/test/observatory.test.ts', 'server/test/change-evidence.test.ts', 'server/test/review-unit.test.ts'], environment: 'node', env: { VAULT_ROOT: process.cwd(), DEPLOYMENT: 'local' } } });
