import { defineConfig } from 'vitest/config';

// Pure profile validation can run without the integration suite's Postgres setup.
export default defineConfig({
  test: { environment: 'node', include: ['server/test/org-runtime-resolve.test.ts', 'server/test/org-launcher.test.ts'] },
});
