import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['app/shared/desk/**/*.test.ts'], environment: 'node' } });
