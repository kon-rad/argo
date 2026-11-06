import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['server/test/addons/desk-p2.test.ts'], environment: 'node' } });
