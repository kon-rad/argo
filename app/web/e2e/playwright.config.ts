import { defineConfig } from '@playwright/test';

// Run against an app that is already up. BASE_URL wins; otherwise the host the
// browser should use to reach this machine (E2E_APP_HOST, or the card runner's
// CC_CARD_BROWSER_APP_HOST when the browser runs in a container) on port 5123.
// On a laptop with neither set this is http://localhost:5123.
const host = process.env.E2E_APP_HOST ?? process.env.CC_CARD_BROWSER_APP_HOST ?? 'localhost';
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  // Traces and failure screenshots; gitignored like shots/.
  outputDir: '../test-results',
  // A cold dev server sometimes holds a page's first load past networkidle;
  // one retry, and the report names it flaky instead of passed.
  retries: 1,
  use: { baseURL: process.env.BASE_URL ?? `http://${host}:5123` },
  reporter: [['list']],
});
