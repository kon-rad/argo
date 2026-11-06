import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['app/server/src/addons/desk/identity/**/*.test.ts'],
    environment: 'node',
  },
});
