import { defineConfig } from '@playwright/test';

// The table checks need no server and no database: they start the Vite dev server themselves and answer every
// /api call from fake fixtures (see mock-api.ts). Run from app/: npx playwright test -c web/e2e/tables.config.ts
const PORT = Number(process.env.TABLES_PORT ?? 5199);
// When the browser runs somewhere else (a Playwright server in a container, PW_TEST_CONNECT_WS_ENDPOINT), Vite has to
// listen on every interface and the browser opens the page by a host name it can reach. Unset: plain loopback.
const BROWSER_HOST = process.env.CC_CARD_BROWSER_APP_HOST || process.env.TABLES_BROWSER_HOST || '';
const listen = BROWSER_HOST ? '0.0.0.0' : '127.0.0.1';

export default defineConfig({
  testDir: '.',
  testMatch: 'mobile-tables.pw.ts',
  outputDir: './test-results',
  // Desktop baselines are made on the machine that compares them (see mobile-tables.pw.ts), never committed.
  snapshotPathTemplate: `${process.env.TABLES_BASELINE ?? './baseline'}/{arg}{ext}`,
  fullyParallel: true,
  use: { baseURL: `http://${BROWSER_HOST || '127.0.0.1'}:${PORT}`, timezoneId: 'UTC', locale: 'en-US', colorScheme: 'light' },
  webServer: {
    command: `npx vite --host ${listen} --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    // Vite refuses requests whose Host header it does not know.
    env: BROWSER_HOST ? { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: BROWSER_HOST } : {},
  },
  reporter: [['list']],
});
