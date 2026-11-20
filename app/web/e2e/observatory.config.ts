import { defineConfig } from '@playwright/test';
const port = Number(process.env.OBSERVATORY_PORT ?? 5199);
export default defineConfig({
  testDir: '.', testMatch: 'observatory.pw.ts', outputDir: './test-results',
  use: { baseURL: `http://127.0.0.1:${port}`, timezoneId: 'UTC', locale: 'en-US',
    launchOptions: process.env.OBSERVATORY_CHROME ? { executablePath: process.env.OBSERVATORY_CHROME,
      args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--enable-gpu'] } : undefined },
  webServer: { command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`, cwd: '..', url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
  reporter: [['list']],
});
