import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { projects: [
    { test: { name: 'server', environment: 'node', include: ['server/**/*.test.ts'] } },
    { test: { name: 'contracts', environment: 'node', include: ['contracts/**/*.test.ts'] } },
    { test: { name: 'web', environment: 'jsdom', include: ['web/**/*.test.ts', 'web/**/*.test.tsx'] } }
  ] }
});
