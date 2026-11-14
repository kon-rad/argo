import { defineConfig } from '@playwright/test';

// The table checks need no server and no database: they start the Vite dev server themselves and answer every
// /api call from fake fixtures (see mock-api.ts). Run from app/: npx playwright test -c web/e2e/tables.config.ts
const PORT = Number(process.env.TABLES_PORT ?? 5199);

export default defineConfig({
  testDir: '.',
  testMatch: 'mobile-tables.pw.ts',
  outputDir: './test-results',
  // Desktop baselines are made on the machine that compares them (see mobile-tables.pw.ts), never committed.
  snapshotPathTemplate: `${process.env.TABLES_BASELINE ?? './baseline'}/{arg}{ext}`,
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${PORT}`, timezoneId: 'UTC', locale: 'en-US', colorScheme: 'light' },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
  },
  reporter: [['list']],
});
