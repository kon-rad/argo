import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['server/src/addons/desk/worker/control.test.ts'] } });
