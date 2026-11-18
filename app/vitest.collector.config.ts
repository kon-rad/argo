import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/test/collector-safety.test.ts'], testTimeout: 5000 } });
