import { defineConfig } from '@playwright/test';

// Run against an app that is already up: BASE_URL=http://localhost:5123
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:5123' },
  reporter: [['list']],
});
